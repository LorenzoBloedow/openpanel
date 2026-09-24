import { deepMergeObjects, toDots } from '@openpanel/common';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { assocPath, omit, pathOr, uniq } from 'ramda';

import { type Queryable, anQuery, anTransaction } from '../analytics/client';
import { HIDDEN_PROPERTY_KEYS } from '../analytics/rollups';
import { sql } from '../analytics/sql';
import {
  type EventWriteRow,
  type ProfileWriteRow,
  insertBotEvents,
  insertEvents,
  toStringMap,
  upsertGroups,
  upsertProfiles,
  upsertSessions,
} from '../analytics/writers';
import type { IServiceCreateEventPayload } from '../services/event.service';
import type { IClickhouseSession } from '../services/session.service';
import {
  type BotRecord,
  type EventRecord,
  type EventsEnvelope,
  type GroupRecord,
  type IngestRecord,
  type ProfileOpRecord,
  deserializeEventPayload,
  stripNulChars,
} from './envelope';
import { getBucketSessionId } from './session-id';
import {
  applyEventToSession,
  fromSessionDate,
  isSessionSignal,
} from './session-machine';

/**
 * The op-events consumer: applies a batch of envelopes in ONE transaction.
 *
 * 1. Ledger: record ids go into analytics.ingest_ledger; only new ones are
 *    applied, so a redelivered message changes nothing.
 * 2. The live session of every device in the batch is locked (rows created
 *    as placeholders if missing, then SELECT … FOR UPDATE in key order), which
 *    serializes concurrent consumers per device like GroupMQ did.
 * 3. The session state machine runs over each device's events in event time.
 * 4. Events, sessions, live sessions, profiles, groups, bots and rollups are
 *    written in bulk, each class of rows in key order (no deadlocks).
 *
 * Side effects (LiveHub, notification rules, first-event markers) are
 * returned for the caller to run after the commit.
 */

export interface ApplyEnvelopesOptions {
  /** Project event-exclusion filter, re-applied to detached events. */
  isExcluded?: (payload: IServiceCreateEventPayload) => Promise<boolean>;
  /** Wall clock for inserted_at / last_seen_at (tests pin it). */
  now?: Date;
}

export interface AppliedEvent {
  payload: IServiceCreateEventPayload & { id: string };
}

export interface ApplyEnvelopesResult {
  appliedRecords: number;
  skippedRecords: number;
  /** Events actually inserted (new rows), in event-time order. */
  insertedEvents: AppliedEvent[];
  /** Sessions a boundary closed in this batch. */
  closedSessions: IClickhouseSession[];
}

type LiveSession = IClickhouseSession;

const HOUR_MS = 60 * 60 * 1000;
const MAX_PROPERTY_KEYS_PER_PROJECT = 10_000;

/** A stable UUID for derived rows (session_start / session_end events). */
export function deterministicUuid(name: string): string {
  const hash = sha256(utf8ToBytes(name));
  hash[6] = (hash[6]! & 0x0f) | 0x80; // version 8 (custom)
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(hash.subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const deviceKey = (projectId: string, deviceId: string) => `${projectId}\u0000${deviceId}`;

function compareKeys(a: [string, string], b: [string, string]) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

/** The session_end event for a closed session, built from its snapshot. */
export function buildSessionEndEvent(
  session: LiveSession,
): IServiceCreateEventPayload & { id: string } {
  const query = Object.fromEntries(
    (
      [
        ['utm_medium', session.utm_medium],
        ['utm_source', session.utm_source],
        ['utm_campaign', session.utm_campaign],
        ['utm_content', session.utm_content],
        ['utm_term', session.utm_term],
      ] as const
    ).filter(([, value]) => value),
  );
  return {
    id: deterministicUuid(`${session.project_id}:${session.id}:session_end`),
    name: 'session_end',
    projectId: session.project_id,
    deviceId: session.device_id,
    profileId: session.profile_id,
    sessionId: session.id,
    createdAt: new Date(fromSessionDate(session.ended_at).getTime() + 1000),
    duration: Math.max(0, session.duration ?? 0),
    path: session.exit_path ?? '',
    origin: session.exit_origin ?? '',
    referrer: session.referrer,
    referrerName: session.referrer_name,
    referrerType: session.referrer_type,
    properties: {
      __bounce: session.is_bounce,
      ...(Object.keys(query).length > 0 ? { __query: query } : {}),
    },
    groups: session.groups ?? [],
    country: session.country,
    city: session.city,
    region: session.region,
    longitude: session.longitude,
    latitude: session.latitude,
    os: session.os,
    osVersion: session.os_version,
    browser: session.browser,
    browserVersion: session.browser_version,
    device: session.device,
    brand: session.brand,
    model: session.model,
    sdkName: undefined,
    sdkVersion: undefined,
  };
}

/** createEvent's row mapping (event.service), minus the buffer. */
export function toEventRow(
  payload: IServiceCreateEventPayload & { id: string },
  now: Date,
): EventWriteRow {
  const profileId =
    payload.profileId || (payload.deviceId ? payload.deviceId : '');
  return {
    id: payload.id,
    name: payload.name,
    device_id: payload.deviceId ?? '',
    profile_id: profileId ? String(profileId) : '',
    project_id: payload.projectId,
    session_id: payload.sessionId ?? '',
    properties: toDots(payload.properties ?? {}),
    path: payload.path ?? '',
    origin: payload.origin ?? '',
    created_at: payload.createdAt.toISOString(),
    country: payload.country ?? '',
    city: payload.city ?? '',
    region: payload.region ?? '',
    longitude: payload.longitude ?? null,
    latitude: payload.latitude ?? null,
    os: payload.os ?? '',
    os_version: payload.osVersion ?? '',
    browser: payload.browser ?? '',
    browser_version: payload.browserVersion ?? '',
    device: payload.device ?? '',
    brand: payload.brand ?? '',
    model: payload.model ?? '',
    duration: payload.duration ?? 0,
    referrer: payload.referrer ?? '',
    referrer_name: payload.referrerName ?? '',
    referrer_type: payload.referrerType ?? '',
    imported_at: null,
    inserted_at: now.toISOString(),
    sdk_name: payload.sdkName ?? '',
    sdk_version: payload.sdkVersion ?? '',
    revenue: payload.revenue ?? 0,
    groups: payload.groups ?? [],
  };
}

/** Event-derived profile write (createEvent on session_start/session_end). */
export function profileFromEvent(
  payload: IServiceCreateEventPayload,
): PendingProfile | null {
  const profileId = payload.profileId || payload.deviceId;
  if (!profileId) {
    return null;
  }
  return {
    fromEvent: true,
    upsert: {
      id: String(profileId),
      projectId: payload.projectId,
      isExternal: profileId !== payload.deviceId,
      properties: {
        path: payload.path,
        country: payload.country,
        city: payload.city,
        region: payload.region,
        longitude: payload.longitude,
        latitude: payload.latitude,
        os: payload.os,
        os_version: payload.osVersion,
        browser: payload.browser,
        browser_version: payload.browserVersion,
        device: payload.device,
        brand: payload.brand,
        model: payload.model,
        referrer: payload.referrer,
        referrer_name: payload.referrerName,
        referrer_type: payload.referrerType,
      },
    },
  };
}

export interface PendingProfile {
  fromEvent?: boolean;
  upsert: {
    id: string;
    projectId: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    avatar?: string;
    properties?: Record<string, unknown>;
    isExternal: boolean;
    groups?: string[];
  };
}

interface StoredProfile {
  id: string;
  project_id: string;
  is_external: boolean;
  first_name: string;
  last_name: string;
  email: string;
  avatar: string;
  properties: Record<string, unknown>;
  groups: string[];
  created_at: string;
  last_seen_at: string;
}

const SERVER_DEVICE_PROPERTIES = [
  'city',
  'country',
  'region',
  'longitude',
  'latitude',
  'os',
  'osVersion',
  'browser',
  'device',
  'isServer',
  'os_version',
  'browser_version',
];

/** Drop empty values before merging (upsertProfile's `strip`). */
function stripEmpty(properties: Record<string, unknown> | undefined) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** ProfileBuffer.mergeProfiles over the stored row. */
function mergeProfile(
  existing: StoredProfile | null,
  incoming: PendingProfile['upsert'],
  now: string,
): StoredProfile {
  const next: StoredProfile = {
    id: String(incoming.id),
    project_id: incoming.projectId,
    is_external: incoming.isExternal,
    first_name: incoming.firstName || '',
    last_name: incoming.lastName || '',
    email: incoming.email || '',
    avatar: incoming.avatar || '',
    properties: stripEmpty(incoming.properties),
    groups: incoming.groups ?? [],
    created_at: now,
    last_seen_at: now,
  };
  if (!existing) {
    return next;
  }

  let profile = next;
  if (existing.properties.device !== 'server' && next.properties.device === 'server') {
    profile = { ...next, properties: omit(SERVER_DEVICE_PROPERTIES, next.properties) };
  }

  return {
    ...deepMergeObjects<StoredProfile>(existing, omit(['created_at', 'groups'], profile)),
    created_at: existing.created_at,
    groups: uniq([...(existing.groups ?? []), ...(next.groups ?? [])]),
  };
}

function inheritSession(
  payload: IServiceCreateEventPayload,
  session: LiveSession,
): IServiceCreateEventPayload {
  // merge(baseEvent, {referrer…}) in the old worker: the session's non-empty
  // referrer fields override the event's own.
  return {
    ...payload,
    sessionId: session.id,
    referrer: session.referrer || payload.referrer,
    referrerName: session.referrer_name || payload.referrerName,
    referrerType: session.referrer_type || payload.referrerType,
  };
}

/** incoming-event.ts: server/backdated events ride on the profile's session. */
function attachDetached(
  payload: IServiceCreateEventPayload,
  session: LiveSession | null,
): IServiceCreateEventPayload {
  return {
    ...payload,
    deviceId: session?.device_id ?? '',
    sessionId: session?.id ?? '',
    referrer: session?.referrer ?? undefined,
    referrerName: session?.referrer_name ?? undefined,
    referrerType: session?.referrer_type ?? undefined,
    path: session?.exit_path ?? payload.path,
    origin: session?.exit_origin ?? payload.origin,
    os: session?.os ?? payload.os,
    osVersion: session?.os_version ?? payload.osVersion,
    browserVersion: session?.browser_version ?? payload.browserVersion,
    browser: session?.browser ?? payload.browser,
    device: session?.device ?? payload.device,
    brand: session?.brand ?? payload.brand,
    model: session?.model ?? payload.model,
    city: session?.city ?? payload.city,
    country: session?.country ?? payload.country,
    region: session?.region ?? payload.region,
    longitude: session?.longitude ?? payload.longitude,
    latitude: session?.latitude ?? payload.latitude,
  };
}

function dedupeRecords(envelopes: EventsEnvelope[]): IngestRecord[] {
  const seen = new Set<string>();
  const records: IngestRecord[] = [];
  for (const envelope of envelopes) {
    for (const record of envelope.records) {
      if (!seen.has(record.id)) {
        seen.add(record.id);
        records.push(record);
      }
    }
  }
  return records;
}

async function claimLedger(client: Queryable, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await anQuery<{ id: string }>(
    sql`
      INSERT INTO analytics.ingest_ledger (id)
      SELECT id FROM unnest(${[...ids].sort()}::uuid[]) AS t(id) ORDER BY id
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    undefined,
    client,
  );
  return new Set(rows.map((row) => row.id));
}

async function lockLiveSessions(
  client: Queryable,
  keys: [string, string][],
): Promise<Map<string, LiveSession | null>> {
  const result = new Map<string, LiveSession | null>();
  if (keys.length === 0) {
    return result;
  }
  const projectIds = keys.map(([projectId]) => projectId);
  const deviceIds = keys.map(([, deviceId]) => deviceId);
  // Placeholders make a row to lock for devices without a live session yet,
  // so two consumers can't both open a first session for the same device.
  await anQuery(
    sql`
      INSERT INTO analytics.live_sessions (project_id, device_id, session_id, ended_at, session)
      SELECT k.project_id, k.device_id, '', 'epoch', 'null'::jsonb
      FROM unnest(${projectIds}::text[], ${deviceIds}::text[]) AS k(project_id, device_id)
      ORDER BY k.project_id, k.device_id
      ON CONFLICT DO NOTHING
    `,
    undefined,
    client,
  );
  const rows = await anQuery<{ project_id: string; device_id: string; session: LiveSession | null }>(
    sql`
      SELECT l.project_id, l.device_id, l.session
      FROM analytics.live_sessions l
      JOIN unnest(${projectIds}::text[], ${deviceIds}::text[]) AS k(project_id, device_id)
        ON l.project_id = k.project_id AND l.device_id = k.device_id
      ORDER BY l.project_id, l.device_id
      FOR UPDATE OF l
    `,
    undefined,
    client,
  );
  for (const row of rows) {
    result.set(deviceKey(row.project_id, row.device_id), row.session ?? null);
  }
  return result;
}

async function readProfileSessions(
  client: Queryable,
  keys: [string, string][],
): Promise<Map<string, LiveSession>> {
  const result = new Map<string, LiveSession>();
  if (keys.length === 0) {
    return result;
  }
  const rows = await anQuery<{ project_id: string; profile_id: string; session: LiveSession }>(
    sql`
      SELECT DISTINCT ON (l.project_id, l.profile_id) l.project_id, l.profile_id, l.session
      FROM analytics.live_sessions l
      JOIN unnest(${keys.map((k) => k[0])}::text[], ${keys.map((k) => k[1])}::text[]) AS k(project_id, profile_id)
        ON l.project_id = k.project_id AND l.profile_id = k.profile_id
      WHERE l.session_id <> ''
      ORDER BY l.project_id, l.profile_id, l.ended_at DESC
    `,
    undefined,
    client,
  );
  for (const row of rows) {
    result.set(deviceKey(row.project_id, row.profile_id), row.session);
  }
  return result;
}

async function lockProfiles(
  client: Queryable,
  keys: [string, string][],
): Promise<Map<string, StoredProfile>> {
  const result = new Map<string, StoredProfile>();
  if (keys.length === 0) {
    return result;
  }
  const rows = await anQuery<StoredProfile>(
    sql`
      SELECT p.id, p.project_id, p.is_external, p.first_name, p.last_name,
        p.email, p.avatar, p.properties, p.groups, p.created_at, p.last_seen_at
      FROM analytics.profiles p
      JOIN unnest(${keys.map((k) => k[0])}::text[], ${keys.map((k) => k[1])}::text[]) AS k(project_id, id)
        ON p.project_id = k.project_id AND p.id = k.id
      ORDER BY p.project_id, p.id
      FOR UPDATE OF p
    `,
    undefined,
    client,
  );
  for (const row of rows) {
    result.set(deviceKey(row.project_id, row.id), row);
  }
  return result;
}

async function lockGroups(client: Queryable, keys: [string, string][]) {
  const result = new Map<
    string,
    { type: string; name: string; properties: Record<string, string>; created_at: string }
  >();
  if (keys.length === 0) {
    return result;
  }
  const rows = await anQuery<{
    project_id: string;
    id: string;
    type: string;
    name: string;
    properties: Record<string, string>;
    created_at: string;
  }>(
    sql`
      SELECT g.project_id, g.id, g.type, g.name, g.properties, g.created_at
      FROM analytics.groups g
      JOIN unnest(${keys.map((k) => k[0])}::text[], ${keys.map((k) => k[1])}::text[]) AS k(project_id, id)
        ON g.project_id = k.project_id AND g.id = k.id
      ORDER BY g.project_id, g.id
      FOR UPDATE OF g
    `,
    undefined,
    client,
  );
  for (const row of rows) {
    result.set(deviceKey(row.project_id, row.id), row);
  }
  return result;
}

function toProfileWriteRow(profile: StoredProfile): ProfileWriteRow {
  return {
    ...profile,
    properties: toStringMap(profile.properties),
  };
}

export async function writeRollups(
  client: Queryable,
  rows: EventWriteRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const dau = new Set<string>();
  const profileDays = new Set<string>();
  const names = new Map<string, { project_id: string; name: string; count: number; first: string; last: string }>();
  const keys = new Map<string, { project_id: string; name: string; key: string; last: string }>();

  for (const row of rows) {
    const day = row.created_at.slice(0, 10);
    if (row.profile_id) {
      dau.add(JSON.stringify([row.project_id, day, row.profile_id]));
      if (row.profile_id !== row.device_id) {
        profileDays.add(JSON.stringify([row.project_id, row.name, day, row.profile_id]));
      }
    }
    const nameKey = `${row.project_id}\u0000${row.name}`;
    const name = names.get(nameKey);
    if (name) {
      name.count++;
      name.first = row.created_at < name.first ? row.created_at : name.first;
      name.last = row.created_at > name.last ? row.created_at : name.last;
    } else {
      names.set(nameKey, { project_id: row.project_id, name: row.name, count: 1, first: row.created_at, last: row.created_at });
    }
    for (const [key, value] of Object.entries(row.properties)) {
      if (!key || value === '' || value === undefined || value === null || HIDDEN_PROPERTY_KEYS.includes(key)) {
        continue;
      }
      const propertyKey = `${nameKey}\u0000${key}`;
      const existing = keys.get(propertyKey);
      if (!existing || row.created_at > existing.last) {
        keys.set(propertyKey, { project_id: row.project_id, name: row.name, key, last: row.created_at });
      }
    }
  }

  const sortedTuples = (set: Set<string>) =>
    [...set].map((item) => JSON.parse(item) as string[]).sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1));

  const dauRows = sortedTuples(dau);
  if (dauRows.length > 0) {
    await anQuery(
      sql`
        INSERT INTO analytics.dau (project_id, day, profile_id)
        SELECT * FROM unnest(${dauRows.map((r) => r[0])}::text[], ${dauRows.map((r) => r[1])}::date[], ${dauRows.map((r) => r[2])}::text[])
        ON CONFLICT DO NOTHING
      `,
      undefined,
      client,
    );
  }

  const dayRows = sortedTuples(profileDays);
  if (dayRows.length > 0) {
    await anQuery(
      sql`
        INSERT INTO analytics.profile_event_days (project_id, name, day, profile_id)
        SELECT * FROM unnest(${dayRows.map((r) => r[0])}::text[], ${dayRows.map((r) => r[1])}::text[], ${dayRows.map((r) => r[2])}::date[], ${dayRows.map((r) => r[3])}::text[])
        ON CONFLICT DO NOTHING
      `,
      undefined,
      client,
    );
  }

  const nameRows = [...names.values()].sort((a, b) =>
    a.project_id === b.project_id ? (a.name < b.name ? -1 : 1) : a.project_id < b.project_id ? -1 : 1,
  );
  await anQuery(
    sql`
      INSERT INTO analytics.event_names (project_id, name, event_count, first_seen_at, last_seen_at)
      SELECT * FROM unnest(
        ${nameRows.map((r) => r.project_id)}::text[], ${nameRows.map((r) => r.name)}::text[],
        ${nameRows.map((r) => r.count)}::bigint[], ${nameRows.map((r) => r.first)}::timestamptz[],
        ${nameRows.map((r) => r.last)}::timestamptz[]
      )
      ON CONFLICT (project_id, name) DO UPDATE SET
        event_count = analytics.event_names.event_count + EXCLUDED.event_count,
        first_seen_at = LEAST(analytics.event_names.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(analytics.event_names.last_seen_at, EXCLUDED.last_seen_at)
    `,
    undefined,
    client,
  );

  const keyRows = [...keys.values()].sort((a, b) => {
    const left = `${a.project_id}\u0000${a.name}\u0000${a.key}`;
    const right = `${b.project_id}\u0000${b.name}\u0000${b.key}`;
    return left < right ? -1 : 1;
  });
  if (keyRows.length > 0) {
    // Existing keys always refresh; new keys stop once a project has many
    // (random keys would otherwise grow the table without bound).
    await anQuery(
      sql`
        INSERT INTO analytics.event_property_keys (project_id, name, property_key, last_seen_at)
        SELECT k.project_id, k.name, k.property_key, k.last_seen_at
        FROM unnest(
          ${keyRows.map((r) => r.project_id)}::text[], ${keyRows.map((r) => r.name)}::text[],
          ${keyRows.map((r) => r.key)}::text[], ${keyRows.map((r) => r.last)}::timestamptz[]
        ) AS k(project_id, name, property_key, last_seen_at)
        WHERE EXISTS (
          SELECT 1 FROM analytics.event_property_keys e
          WHERE e.project_id = k.project_id AND e.name = k.name AND e.property_key = k.property_key
        ) OR (
          SELECT count(*) FROM analytics.event_property_keys e WHERE e.project_id = k.project_id
        ) < ${MAX_PROPERTY_KEYS_PER_PROJECT}
        ON CONFLICT (project_id, name, property_key) DO UPDATE SET
          last_seen_at = GREATEST(analytics.event_property_keys.last_seen_at, EXCLUDED.last_seen_at)
      `,
      undefined,
      client,
    );
  }
}

/**
 * Merge profile writes into the stored rows (locked FOR UPDATE, key order)
 * and apply increments/decrements, the way ProfileBuffer and the old
 * /track increment handler did.
 */
export async function writeProfiles(
  client: Queryable,
  pendingProfiles: PendingProfile[],
  profileOps: ProfileOpRecord[],
  now: Date,
): Promise<void> {
  const profileKeys = [
    ...new Map(
      [
        ...pendingProfiles.map((p) => [p.upsert.projectId, String(p.upsert.id)] as [string, string]),
        ...profileOps.map((op) => [op.projectId, op.profileId] as [string, string]),
      ].map((key) => [deviceKey(key[0], key[1]), key]),
    ).values(),
  ].sort(compareKeys);
  if (profileKeys.length === 0) {
    return;
  }
  const profiles = await lockProfiles(client, profileKeys);
  const touchedProfiles = new Set<string>();
  const nowIso = now.toISOString();

  for (const pending of pendingProfiles) {
    const key = deviceKey(pending.upsert.projectId, String(pending.upsert.id));
    const existing = profiles.get(key) ?? null;
    // Event-derived writes are skipped for profiles seen within the hour
    // (the Redis profile cache did this before).
    if (
      pending.fromEvent &&
      existing &&
      !touchedProfiles.has(key) &&
      now.getTime() - fromSessionDate(existing.last_seen_at).getTime() < HOUR_MS
    ) {
      continue;
    }
    profiles.set(key, mergeProfile(existing, pending.upsert, nowIso));
    touchedProfiles.add(key);
  }

  for (const op of profileOps) {
    const key = deviceKey(op.projectId, op.profileId);
    const profile = profiles.get(key);
    if (!profile) {
      continue;
    }
    const path = op.property.split('.');
    const parsed = Number.parseInt(String(pathOr('0', path, profile.properties)), 10);
    if (Number.isNaN(parsed)) {
      continue;
    }
    profiles.set(key, {
      ...profile,
      properties: assocPath(path, parsed + op.delta, profile.properties),
      last_seen_at: nowIso,
    });
    touchedProfiles.add(key);
  }

  const profileRows = [...touchedProfiles]
    .sort()
    .map((key) => toProfileWriteRow(profiles.get(key)!));
  await upsertProfiles(profileRows, client);
}

export async function applyEnvelopes(
  envelopes: EventsEnvelope[],
  options: ApplyEnvelopesOptions = {},
): Promise<ApplyEnvelopesResult> {
  const now = options.now ?? new Date();
  // Envelopes from older API versions may still carry NUL characters.
  const records = dedupeRecords(stripNulChars(envelopes));

  return anTransaction(async (client) => {
    const fresh = await claimLedger(client, records.map((record) => record.id));
    const applied = records.filter((record) => fresh.has(record.id));

    const eventRecords = applied.filter((r): r is EventRecord => r.type === 'event');
    const attached = eventRecords.filter(
      (record) =>
        !record.detached &&
        record.event.deviceId &&
        !isSessionSignal(record.event.name),
    );
    const detached = eventRecords.filter((record) => !attached.includes(record));

    // --- 2. lock the live sessions of every device in the batch ------------
    const deviceKeys = [
      ...new Map(
        attached.map((record) => [
          deviceKey(record.event.projectId, record.event.deviceId),
          [record.event.projectId, record.event.deviceId] as [string, string],
        ]),
      ).values(),
    ].sort(compareKeys);
    const live = await lockLiveSessions(client, deviceKeys);

    // --- 3. the session state machine ------------------------------------------
    const events: (IServiceCreateEventPayload & { id: string })[] = [];
    const sessions = new Map<string, LiveSession>();
    const closedSessions: LiveSession[] = [];
    const pendingProfiles: PendingProfile[] = [];
    const latestByProfile = new Map<string, LiveSession>();

    const byDevice = new Map<string, EventRecord[]>();
    for (const record of attached) {
      const key = deviceKey(record.event.projectId, record.event.deviceId);
      const list = byDevice.get(key) ?? [];
      list.push(record);
      byDevice.set(key, list);
    }

    for (const [key, list] of byDevice) {
      list.sort((a, b) => Date.parse(a.event.createdAt) - Date.parse(b.event.createdAt));
      let current = live.get(key) ?? null;

      for (const record of list) {
        const payload = deserializeEventPayload(record.event);
        const transition = applyEventToSession(current, payload);
        if (!transition) {
          events.push({ ...payload, id: record.id });
          continue;
        }

        let session = transition.current;
        if (transition.kind !== 'extend') {
          // The API's id is a hint. A boundary must not reopen the id of the
          // session it just closed (the API saw it live a moment ago).
          const closedId = transition.kind === 'boundary' ? transition.closed.id : null;
          if (!session.id || session.id === closedId) {
            let id = getBucketSessionId({
              projectId: payload.projectId,
              deviceId: payload.deviceId,
              eventMs: payload.createdAt.getTime(),
            });
            if (id === closedId) {
              id = `${id}-${record.id.slice(0, 8)}`;
            }
            session = { ...session, id };
          }
        }

        if (transition.kind === 'boundary') {
          closedSessions.push(transition.closed);
          sessions.set(`${transition.closed.project_id}\u0000${transition.closed.id}`, transition.closed);
          const sessionEnd = buildSessionEndEvent(transition.closed);
          events.push(sessionEnd);
          const profile = profileFromEvent(sessionEnd);
          if (profile) pendingProfiles.push(profile);
        }

        if (transition.kind === 'new' || transition.kind === 'boundary') {
          const sessionStart = {
            ...payload,
            id: deterministicUuid(`${payload.projectId}:${session.id}:session_start`),
            name: 'session_start',
            sessionId: session.id,
            createdAt: new Date(payload.createdAt.getTime() - 100),
          };
          events.push(sessionStart);
          const profile = profileFromEvent(sessionStart);
          if (profile) pendingProfiles.push(profile);
        }

        events.push({ ...inheritSession(payload, session), id: record.id });
        current = session;
      }

      if (current) {
        sessions.set(`${current.project_id}\u0000${current.id}`, current);
        live.set(key, current);
        if (current.profile_id && current.profile_id !== current.device_id) {
          latestByProfile.set(deviceKey(current.project_id, current.profile_id), current);
        }
      }
    }

    // --- detached events ride on the profile's live session ------------------------
    const profileLookups = [
      ...new Map(
        detached
          .filter((record) => record.detached === 'server' && record.event.profileId)
          .map((record) => [
            deviceKey(record.event.projectId, record.event.profileId),
            [record.event.projectId, record.event.profileId] as [string, string],
          ]),
      ).values(),
    ].sort(compareKeys);
    const storedProfileSessions = await readProfileSessions(client, profileLookups);

    for (const record of detached) {
      let payload = deserializeEventPayload(record.event);
      if (record.detached) {
        const key = deviceKey(payload.projectId, payload.profileId);
        const session =
          record.detached === 'server' && payload.profileId
            ? (latestByProfile.get(key) ?? storedProfileSessions.get(key) ?? null)
            : null;
        payload = attachDetached(payload, session);
        if (options.isExcluded && (await options.isExcluded(payload))) {
          continue;
        }
      }
      events.push({ ...payload, id: record.id });
    }

    // --- 4. events -----------------------------------------------------------------
    events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const eventRows = events.map((event) => toEventRow(event, now));
    const insertedIds = new Set(await insertEvents(eventRows, client));
    const insertedRows = eventRows.filter((row) => insertedIds.has(row.id));

    // --- sessions and live sessions ------------------------------------------------------
    const sessionRows = [...sessions.values()].sort((a, b) =>
      a.project_id === b.project_id ? (a.id < b.id ? -1 : 1) : a.project_id < b.project_id ? -1 : 1,
    );
    await upsertSessions(
      sessionRows.map((session) => ({ ...session, duration: Math.max(0, session.duration || 0) })),
      client,
    );

    const liveRows = deviceKeys
      .map(([projectId, deviceId]) => live.get(deviceKey(projectId, deviceId)))
      .filter((session): session is LiveSession => Boolean(session));
    if (liveRows.length > 0) {
      await anQuery(
        sql`
          INSERT INTO analytics.live_sessions (project_id, device_id, session_id, profile_id, ended_at, last_received_at, session)
          SELECT r.project_id, r.device_id, r.session_id, r.profile_id, r.ended_at, ${now.toISOString()}::timestamptz, r.session
          FROM jsonb_to_recordset(${JSON.stringify(
            liveRows.map((session) => ({
              project_id: session.project_id,
              device_id: session.device_id,
              session_id: session.id,
              profile_id: session.profile_id,
              ended_at: fromSessionDate(session.ended_at).toISOString(),
              session,
            })),
          )}::jsonb) AS r(project_id text, device_id text, session_id text, profile_id text, ended_at timestamptz, session jsonb)
          ORDER BY r.project_id, r.device_id
          ON CONFLICT (project_id, device_id) DO UPDATE SET
            session_id = EXCLUDED.session_id,
            profile_id = EXCLUDED.profile_id,
            ended_at = EXCLUDED.ended_at,
            last_received_at = EXCLUDED.last_received_at,
            session = EXCLUDED.session
        `,
        undefined,
        client,
      );
    }
    // Placeholders for devices that didn't end up with a session.
    if (deviceKeys.length > 0) {
      await anQuery(
        sql`
          DELETE FROM analytics.live_sessions l
          USING unnest(${deviceKeys.map((k) => k[0])}::text[], ${deviceKeys.map((k) => k[1])}::text[]) AS k(project_id, device_id)
          WHERE l.project_id = k.project_id AND l.device_id = k.device_id AND l.session_id = ''
        `,
        undefined,
        client,
      );
    }

    // --- profiles ------------------------------------------------------------------------
    for (const record of applied) {
      if (record.type === 'profile') {
        pendingProfiles.push({ upsert: record.profile });
      }
    }
    const profileOps = applied.filter(
      (record): record is ProfileOpRecord => record.type === 'profile_op',
    );
    await writeProfiles(client, pendingProfiles, profileOps, now);

    // --- groups ------------------------------------------------------------------------------
    const groupRecords = applied.filter(
      (record): record is GroupRecord => record.type === 'group',
    );
    if (groupRecords.length > 0) {
      const groupKeys = [
        ...new Map(
          groupRecords.map((record) => [
            deviceKey(record.group.projectId, record.group.id),
            [record.group.projectId, record.group.id] as [string, string],
          ]),
        ).values(),
      ].sort(compareKeys);
      const stored = await lockGroups(client, groupKeys);
      const version = now.getTime();
      const merged = new Map<string, Parameters<typeof upsertGroups>[0][number]>();
      for (const record of groupRecords) {
        const key = deviceKey(record.group.projectId, record.group.id);
        const existing = merged.get(key) ?? stored.get(key);
        merged.set(key, {
          id: record.group.id,
          project_id: record.group.projectId,
          type: record.group.type,
          name: record.group.name,
          properties: toDots({ ...(existing?.properties ?? {}), ...record.group.properties }),
          created_at: existing?.created_at ?? now.toISOString(),
          version,
        });
      }
      await upsertGroups([...merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => row), client);
    }

    // --- bots ------------------------------------------------------------------------------------
    const bots = applied.filter((record): record is BotRecord => record.type === 'bot');
    await insertBotEvents(
      bots.map((record) => ({
        id: record.id,
        project_id: record.bot.projectId,
        name: record.bot.name,
        type: record.bot.type,
        path: record.bot.path,
        created_at: record.bot.createdAt,
      })),
      client,
    );

    // --- rollups -----------------------------------------------------------------------------------
    await writeRollups(client, insertedRows);

    const insertedEvents = events
      .filter((event) => insertedIds.has(event.id))
      .map((payload) => ({ payload }));

    return {
      appliedRecords: applied.length,
      skippedRecords: records.length - applied.length,
      insertedEvents,
      closedSessions,
    };
  });
}
