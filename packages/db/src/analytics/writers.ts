import { type Queryable, anQuery } from './client';
import { sql } from './sql';

/**
 * Bulk writers for the analytics tables. Each call is one statement that
 * expands a JSON array with `jsonb_to_recordset`, so a batch of any size is
 * a single round trip and a single bind parameter.
 *
 * Rows use the ClickHouse row shapes the services already produce
 * (IClickhouseEvent, IClickhouseSession, …): snake_case columns and UTC
 * 'YYYY-MM-DD HH:MM:SS[.mmm]' timestamps, which are marked as UTC here —
 * never left to the connection's TimeZone.
 */

export interface EventWriteRow {
  id: string;
  name: string;
  sdk_name?: string;
  sdk_version?: string;
  device_id: string;
  profile_id: string;
  project_id: string;
  session_id: string;
  groups?: string[];
  path?: string;
  origin?: string;
  referrer?: string;
  referrer_name?: string;
  referrer_type?: string;
  revenue?: number;
  duration?: number;
  properties: Record<string, unknown>;
  created_at: string;
  country?: string;
  city?: string;
  region?: string;
  longitude?: number | null;
  latitude?: number | null;
  os?: string;
  os_version?: string;
  browser?: string;
  browser_version?: string;
  device?: string;
  brand?: string;
  model?: string;
  imported_at?: string | null;
  inserted_at?: string;
}

export interface SessionWriteRow {
  id: string;
  project_id: string;
  profile_id: string;
  device_id: string;
  groups?: string[];
  created_at: string;
  ended_at: string;
  is_bounce: boolean;
  entry_origin: string;
  entry_path: string;
  exit_origin: string;
  exit_path: string;
  screen_view_count: number;
  revenue: number;
  event_count: number;
  duration: number;
  country: string;
  region: string;
  city: string;
  longitude: number | null;
  latitude: number | null;
  device: string;
  brand: string;
  model: string;
  browser: string;
  browser_version: string;
  os: string;
  os_version: string;
  utm_medium: string;
  utm_source: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  referrer: string;
  referrer_name: string;
  referrer_type: string;
  version: number;
}

export interface ProfileWriteRow {
  id: string;
  project_id: string;
  is_external: boolean;
  first_name: string;
  last_name: string;
  email: string;
  avatar: string;
  properties: Record<string, unknown>;
  groups?: string[];
  created_at: string;
  last_seen_at?: string;
}

export interface GroupWriteRow {
  id: string;
  project_id: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  created_at: string;
  version: number;
}

export interface BotWriteRow {
  id: string;
  project_id: string;
  name: string;
  type: string;
  path: string;
  created_at: string;
}

export interface ReplayChunkWriteRow {
  project_id: string;
  session_id: string;
  chunk_index: number;
  started_at: string;
  ended_at: string;
  events_count: number;
  is_full_snapshot: boolean;
  payload: string;
}

export interface GscWriteRow {
  project_id: string;
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  synced_at?: string;
}

export interface CohortMemberWriteRow {
  project_id: string;
  cohort_id: string;
  profile_id: string;
  matched_at?: string;
  matching_properties?: Record<string, unknown>;
  version?: number;
}

/**
 * A ClickHouse-style UTC timestamp ('2024-05-01 12:34:56.789') as ISO 8601
 * with an explicit Z. ISO strings and Dates pass through.
 */
export function toUtcIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    return value;
  }
  return `${value.replace(' ', 'T')}Z`;
}

/** ClickHouse Map(String, String) semantics: values stored as strings. */
function toStringMap(properties: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null) {
      continue;
    }
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

const json = (rows: unknown[]) => JSON.stringify(rows);

/** Insert events; returns the ids that were new (redeliveries are skipped). */
export async function insertEvents(
  rows: EventWriteRow[],
  client?: Queryable,
): Promise<string[]> {
  if (rows.length === 0) {
    return [];
  }
  const payload = rows.map((row) => ({
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    sdk_name: row.sdk_name ?? '',
    sdk_version: row.sdk_version ?? '',
    device_id: row.device_id ?? '',
    profile_id: row.profile_id ?? '',
    session_id: row.session_id ?? '',
    groups: row.groups ?? [],
    path: row.path ?? '',
    origin: row.origin ?? '',
    referrer: row.referrer ?? '',
    referrer_name: row.referrer_name ?? '',
    referrer_type: row.referrer_type ?? '',
    revenue: Math.max(0, Math.round(row.revenue ?? 0)),
    duration: Math.max(0, Math.round(row.duration ?? 0)),
    properties: toStringMap(row.properties ?? {}),
    created_at: toUtcIso(row.created_at),
    country: row.country ?? '',
    city: row.city ?? '',
    region: row.region ?? '',
    longitude: row.longitude ?? null,
    latitude: row.latitude ?? null,
    os: row.os ?? '',
    os_version: row.os_version ?? '',
    browser: row.browser ?? '',
    browser_version: row.browser_version ?? '',
    device: row.device ?? '',
    brand: row.brand ?? '',
    model: row.model ?? '',
    imported_at: toUtcIso(row.imported_at),
    inserted_at: toUtcIso(row.inserted_at) ?? new Date().toISOString(),
  }));

  const inserted = await anQuery<{ id: string }>(
    sql`
      INSERT INTO analytics.events (
        id, project_id, name, sdk_name, sdk_version, device_id, profile_id,
        session_id, groups, path, origin, referrer, referrer_name,
        referrer_type, revenue, duration, properties, created_at, country,
        city, region, longitude, latitude, os, os_version, browser,
        browser_version, device, brand, model, imported_at, inserted_at
      )
      SELECT
        r.id, r.project_id, r.name, r.sdk_name, r.sdk_version, r.device_id,
        r.profile_id, r.session_id, r.groups, r.path, r.origin, r.referrer,
        r.referrer_name, r.referrer_type, r.revenue, r.duration, r.properties,
        r.created_at, r.country, r.city, r.region, r.longitude, r.latitude,
        r.os, r.os_version, r.browser, r.browser_version, r.device, r.brand,
        r.model, r.imported_at, r.inserted_at
      FROM jsonb_to_recordset(${json(payload)}::jsonb) AS r(
        id uuid, project_id text, name text, sdk_name text, sdk_version text,
        device_id text, profile_id text, session_id text, groups text[],
        path text, origin text, referrer text, referrer_name text,
        referrer_type text, revenue bigint, duration bigint, properties jsonb,
        created_at timestamptz, country text, city text, region text,
        longitude real, latitude real, os text, os_version text, browser text,
        browser_version text, device text, brand text, model text,
        imported_at timestamptz, inserted_at timestamptz
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    undefined,
    client,
  );
  return inserted.map((row) => row.id);
}

const SESSION_COLUMNS = `
  id text, project_id text, profile_id text, device_id text, groups text[],
  created_at timestamptz, ended_at timestamptz, is_bounce boolean,
  entry_origin text, entry_path text, exit_origin text, exit_path text,
  screen_view_count integer, revenue double precision, event_count integer,
  duration bigint, country text, region text, city text, longitude real,
  latitude real, device text, brand text, model text, browser text,
  browser_version text, os text, os_version text, utm_medium text,
  utm_source text, utm_campaign text, utm_content text, utm_term text,
  referrer text, referrer_name text, referrer_type text, version bigint
`;

const SESSION_UPDATES = [
  'profile_id',
  'device_id',
  'groups',
  'created_at',
  'ended_at',
  'is_bounce',
  'entry_origin',
  'entry_path',
  'exit_origin',
  'exit_path',
  'screen_view_count',
  'revenue',
  'event_count',
  'duration',
  'country',
  'region',
  'city',
  'longitude',
  'latitude',
  'device',
  'brand',
  'model',
  'browser',
  'browser_version',
  'os',
  'os_version',
  'utm_medium',
  'utm_source',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'referrer',
  'referrer_name',
  'referrer_type',
  'version',
]
  .map((column) => `${column} = EXCLUDED.${column}`)
  .join(', ');

/**
 * Upsert sessions. A row only replaces the stored one when its `version` is
 * higher, so a late or redelivered write can't roll a session back.
 */
export async function upsertSessions(
  rows: SessionWriteRow[],
  client?: Queryable,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const payload = rows.map((row) => ({
    ...row,
    groups: row.groups ?? [],
    created_at: toUtcIso(row.created_at),
    ended_at: toUtcIso(row.ended_at),
    duration: Math.max(0, Math.round(row.duration ?? 0)),
  }));
  await anQuery(
    `
      INSERT INTO analytics.sessions (
        id, project_id, profile_id, device_id, groups, created_at, ended_at,
        is_bounce, entry_origin, entry_path, exit_origin, exit_path,
        screen_view_count, revenue, event_count, duration, country, region,
        city, longitude, latitude, device, brand, model, browser,
        browser_version, os, os_version, utm_medium, utm_source, utm_campaign,
        utm_content, utm_term, referrer, referrer_name, referrer_type, version
      )
      SELECT r.id, r.project_id, r.profile_id, r.device_id, r.groups,
        r.created_at, r.ended_at, r.is_bounce, r.entry_origin, r.entry_path,
        r.exit_origin, r.exit_path, r.screen_view_count, r.revenue,
        r.event_count, r.duration, r.country, r.region, r.city, r.longitude,
        r.latitude, r.device, r.brand, r.model, r.browser, r.browser_version,
        r.os, r.os_version, r.utm_medium, r.utm_source, r.utm_campaign,
        r.utm_content, r.utm_term, r.referrer, r.referrer_name,
        r.referrer_type, r.version
      FROM jsonb_to_recordset($1::jsonb) AS r(${SESSION_COLUMNS})
      ON CONFLICT (project_id, id) DO UPDATE SET ${SESSION_UPDATES}
      WHERE EXCLUDED.version > analytics.sessions.version
    `,
    [json(payload)],
    client,
  );
}

/** Upsert profiles as given (callers merge with the stored row first). */
export async function upsertProfiles(
  rows: ProfileWriteRow[],
  client?: Queryable,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const payload = rows.map((row) => ({
    id: row.id,
    project_id: row.project_id,
    is_external: row.is_external,
    first_name: row.first_name ?? '',
    last_name: row.last_name ?? '',
    email: row.email ?? '',
    avatar: row.avatar ?? '',
    properties: toStringMap(row.properties ?? {}),
    groups: row.groups ?? [],
    created_at: toUtcIso(row.created_at),
    last_seen_at: toUtcIso(row.last_seen_at ?? row.created_at),
  }));
  await anQuery(
    `
      INSERT INTO analytics.profiles (
        project_id, id, is_external, first_name, last_name, email, avatar,
        properties, groups, created_at, last_seen_at
      )
      SELECT r.project_id, r.id, r.is_external, r.first_name, r.last_name,
        r.email, r.avatar, r.properties, r.groups, r.created_at, r.last_seen_at
      FROM jsonb_to_recordset($1::jsonb) AS r(
        project_id text, id text, is_external boolean, first_name text,
        last_name text, email text, avatar text, properties jsonb,
        groups text[], created_at timestamptz, last_seen_at timestamptz
      )
      ON CONFLICT (project_id, id) DO UPDATE SET
        is_external = EXCLUDED.is_external,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        email = EXCLUDED.email,
        avatar = EXCLUDED.avatar,
        properties = EXCLUDED.properties,
        groups = EXCLUDED.groups,
        created_at = LEAST(analytics.profiles.created_at, EXCLUDED.created_at),
        last_seen_at = GREATEST(analytics.profiles.last_seen_at, EXCLUDED.last_seen_at)
    `,
    [json(payload)],
    client,
  );
}

/** Upsert groups; the higher `version` wins. */
export async function upsertGroups(
  rows: GroupWriteRow[],
  client?: Queryable,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const payload = rows.map((row) => ({
    ...row,
    properties: toStringMap(row.properties ?? {}),
    created_at: toUtcIso(row.created_at),
  }));
  await anQuery(
    `
      INSERT INTO analytics.groups (project_id, id, type, name, properties, created_at, version)
      SELECT r.project_id, r.id, r.type, r.name, r.properties, r.created_at, r.version
      FROM jsonb_to_recordset($1::jsonb) AS r(
        project_id text, id text, type text, name text, properties jsonb,
        created_at timestamptz, version bigint
      )
      ON CONFLICT (project_id, id) DO UPDATE SET
        type = EXCLUDED.type,
        name = EXCLUDED.name,
        properties = EXCLUDED.properties,
        version = EXCLUDED.version
      WHERE EXCLUDED.version >= analytics.groups.version
    `,
    [json(payload)],
    client,
  );
}

export async function insertBotEvents(
  rows: BotWriteRow[],
  client?: Queryable,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const payload = rows.map((row) => ({ ...row, created_at: toUtcIso(row.created_at) }));
  await anQuery(
    `
      INSERT INTO analytics.events_bots (id, project_id, name, type, path, created_at)
      SELECT r.id, r.project_id, r.name, r.type, r.path, r.created_at
      FROM jsonb_to_recordset($1::jsonb) AS r(
        id uuid, project_id text, name text, type text, path text, created_at timestamptz
      )
      ON CONFLICT DO NOTHING
    `,
    [json(payload)],
    client,
  );
}

/** Replay chunks can be large: one row per call keeps each parameter small. */
export async function insertReplayChunk(
  row: ReplayChunkWriteRow,
  client?: Queryable,
): Promise<void> {
  await anQuery(
    sql`
      INSERT INTO analytics.session_replay_chunks (
        project_id, session_id, started_at, chunk_index, ended_at,
        events_count, is_full_snapshot, payload
      ) VALUES (
        ${row.project_id}, ${row.session_id}, ${toUtcIso(row.started_at)}::timestamptz,
        ${row.chunk_index}, ${toUtcIso(row.ended_at)}::timestamptz,
        ${row.events_count}, ${row.is_full_snapshot}, ${row.payload}
      )
      ON CONFLICT DO NOTHING
    `,
    undefined,
    client,
  );
}

type GscTable = 'gsc_daily' | 'gsc_pages_daily' | 'gsc_queries_daily';

const GSC_KEYS: Record<GscTable, string | null> = {
  gsc_daily: null,
  gsc_pages_daily: 'page',
  gsc_queries_daily: 'query',
};

/** Upsert Search Console rows; a re-sync of a day overwrites it. */
export async function upsertGscRows(
  table: GscTable,
  rows: (GscWriteRow & { page?: string; query?: string })[],
  client?: Queryable,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const key = GSC_KEYS[table];
  const keyColumn = key ? `, ${key}` : '';
  const keyDefinition = key ? `, ${key} text` : '';
  const payload = rows.map((row) => ({
    ...row,
    synced_at: toUtcIso(row.synced_at) ?? new Date().toISOString(),
  }));
  await anQuery(
    `
      INSERT INTO analytics.${table} (project_id, date${keyColumn}, clicks, impressions, ctr, position, synced_at)
      SELECT r.project_id, r.date${key ? `, r.${key}` : ''}, r.clicks, r.impressions, r.ctr, r.position, r.synced_at
      FROM jsonb_to_recordset($1::jsonb) AS r(
        project_id text, date date${keyDefinition}, clicks integer,
        impressions integer, ctr real, position real, synced_at timestamptz
      )
      ON CONFLICT (project_id, date${keyColumn}) DO UPDATE SET
        clicks = EXCLUDED.clicks,
        impressions = EXCLUDED.impressions,
        ctr = EXCLUDED.ctr,
        position = EXCLUDED.position,
        synced_at = EXCLUDED.synced_at
    `,
    [json(payload)],
    client,
  );
}

export async function insertCohortMembers(
  rows: CohortMemberWriteRow[],
  client?: Queryable,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const payload = rows.map((row) => ({
    project_id: row.project_id,
    cohort_id: row.cohort_id,
    profile_id: row.profile_id,
    matched_at: toUtcIso(row.matched_at) ?? new Date().toISOString(),
    matching_properties: row.matching_properties ?? {},
    version: row.version ?? Date.now(),
  }));
  await anQuery(
    `
      INSERT INTO analytics.cohort_members (project_id, cohort_id, profile_id, matched_at, matching_properties, version)
      SELECT r.project_id, r.cohort_id, r.profile_id, r.matched_at, r.matching_properties, r.version
      FROM jsonb_to_recordset($1::jsonb) AS r(
        project_id text, cohort_id text, profile_id text, matched_at timestamptz,
        matching_properties jsonb, version bigint
      )
      ON CONFLICT (project_id, cohort_id, profile_id) DO UPDATE SET
        matched_at = EXCLUDED.matched_at,
        matching_properties = EXCLUDED.matching_properties,
        version = EXCLUDED.version
    `,
    [json(payload)],
    client,
  );
}
