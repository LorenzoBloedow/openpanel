import { z } from 'zod';

import type { IServiceCreateEventPayload } from '../services/event.service';
import type { IServiceUpsertProfile } from '../services/profile.service';

/**
 * The message the API puts on the `op-events` queue for one ingest request,
 * and the ingest consumer applies in one Postgres transaction.
 *
 * Every record carries an id (UUIDv7 minted by the API). Events keep it as
 * their row id; for every record it is the key in analytics.ingest_ledger,
 * which makes a redelivered message a no-op.
 */
export const EVENTS_ENVELOPE_VERSION = 1;

/** Queue messages are capped at 128 KB; leave room for the queue's framing. */
export const MAX_ENVELOPE_BYTES = 120 * 1024;

const zId = z.string().uuid();

const zEventPayload = z.object({
  name: z.string().min(1),
  deviceId: z.string(),
  profileId: z.string(),
  projectId: z.string().min(1),
  sessionId: z.string(),
  properties: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime({ offset: true }),
  country: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  longitude: z.number().nullable().optional(),
  latitude: z.number().nullable().optional(),
  os: z.string().optional(),
  osVersion: z.string().optional(),
  browser: z.string().optional(),
  browserVersion: z.string().optional(),
  device: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  duration: z.number().optional(),
  path: z.string(),
  origin: z.string(),
  referrer: z.string().optional(),
  referrerName: z.string().optional(),
  referrerType: z.string().optional(),
  sdkName: z.string().optional(),
  sdkVersion: z.string().optional(),
  revenue: z.number().optional(),
  groups: z.array(z.string()),
});

export type SerializedEventPayload = z.infer<typeof zEventPayload>;

const zEventRecord = z.object({
  type: z.literal('event'),
  id: zId,
  event: zEventPayload,
  /**
   * Server-side events and events backdated more than 15 minutes don't open
   * or close sessions: `server` events join the profile's live session if
   * there is one, `past` events join none.
   */
  detached: z.enum(['server', 'past']).optional(),
});

const zProfileRecord = z.object({
  type: z.literal('profile'),
  id: zId,
  profile: z.object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().optional(),
    avatar: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    isExternal: z.boolean(),
    groups: z.array(z.string()).optional(),
  }),
});

const zProfileOpRecord = z.object({
  type: z.literal('profile_op'),
  id: zId,
  projectId: z.string().min(1),
  profileId: z.string().min(1),
  /** Dotted path into the profile's properties. */
  property: z.string().min(1),
  delta: z.number(),
});

const zGroupRecord = z.object({
  type: z.literal('group'),
  id: zId,
  group: z.object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    type: z.string(),
    name: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
});

const zBotRecord = z.object({
  type: z.literal('bot'),
  id: zId,
  bot: z.object({
    projectId: z.string().min(1),
    name: z.string(),
    type: z.string(),
    path: z.string(),
    createdAt: z.string().datetime({ offset: true }),
  }),
});

export const zIngestRecord = z.discriminatedUnion('type', [
  zEventRecord,
  zProfileRecord,
  zProfileOpRecord,
  zGroupRecord,
  zBotRecord,
]);

export type IngestRecord = z.infer<typeof zIngestRecord>;
export type EventRecord = z.infer<typeof zEventRecord>;
export type ProfileRecord = z.infer<typeof zProfileRecord>;
export type ProfileOpRecord = z.infer<typeof zProfileOpRecord>;
export type GroupRecord = z.infer<typeof zGroupRecord>;
export type BotRecord = z.infer<typeof zBotRecord>;

export const zEventsEnvelope = z.object({
  v: z.literal(EVENTS_ENVELOPE_VERSION),
  projectId: z.string().min(1),
  records: z.array(zIngestRecord).min(1),
});

export type EventsEnvelope = z.infer<typeof zEventsEnvelope>;

export function serializeEventPayload(
  payload: IServiceCreateEventPayload,
): SerializedEventPayload {
  return {
    name: payload.name,
    deviceId: payload.deviceId,
    profileId: payload.profileId ? String(payload.profileId) : '',
    projectId: payload.projectId,
    sessionId: payload.sessionId,
    properties: payload.properties ?? {},
    createdAt: payload.createdAt.toISOString(),
    country: payload.country,
    city: payload.city,
    region: payload.region,
    longitude: payload.longitude ?? null,
    latitude: payload.latitude ?? null,
    os: payload.os,
    osVersion: payload.osVersion,
    browser: payload.browser,
    browserVersion: payload.browserVersion,
    device: payload.device,
    brand: payload.brand,
    model: payload.model,
    duration: payload.duration,
    path: payload.path ?? '',
    origin: payload.origin ?? '',
    referrer: payload.referrer,
    referrerName: payload.referrerName,
    referrerType: payload.referrerType,
    sdkName: payload.sdkName,
    sdkVersion: payload.sdkVersion,
    revenue: payload.revenue,
    groups: payload.groups ?? [],
  };
}

export function deserializeEventPayload(
  payload: SerializedEventPayload,
): IServiceCreateEventPayload {
  return {
    ...payload,
    createdAt: new Date(payload.createdAt),
    referrer: payload.referrer,
    referrerName: payload.referrerName,
    referrerType: payload.referrerType,
    sdkName: payload.sdkName,
    sdkVersion: payload.sdkVersion,
  };
}

export function profileRecordToUpsert(
  record: ProfileRecord,
): IServiceUpsertProfile {
  return record.profile;
}

export class EnvelopeTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(
      `Ingest payload too large (${bytes} bytes, limit ${MAX_ENVELOPE_BYTES})`,
    );
    this.name = 'EnvelopeTooLargeError';
  }
}

/** Build a validated envelope; throws EnvelopeTooLargeError past the limit. */
export function buildEnvelope(
  projectId: string,
  records: IngestRecord[],
): EventsEnvelope {
  const envelope: EventsEnvelope = zEventsEnvelope.parse({
    v: EVENTS_ENVELOPE_VERSION,
    projectId,
    records,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
  if (bytes > MAX_ENVELOPE_BYTES) {
    throw new EnvelopeTooLargeError(bytes);
  }
  return envelope;
}
