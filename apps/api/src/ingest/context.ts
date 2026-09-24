import { generateDeviceId } from '@openpanel/common/server';
import {
  requestFingerprint,
  resolveSession,
  trackLookup,
} from '@openpanel/db/src/ingest/track-lookup';
import { getSalts } from '@openpanel/db/src/services/salt.service';
import {
  type AsnInfo,
  type CfGeoProperties,
  type GeoLocation,
  type GeoSource,
  getAsnInfo,
  getGeoLocation,
} from '@openpanel/geo';
import type {
  IIdentifyPayload,
  ITrackHandlerPayload,
} from '@openpanel/validation';

const ONE_MINUTE_MS = 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * ONE_MINUTE_MS;
const MAX_OVERRIDE_DEVICE_ID_LENGTH = 64;
// biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * The event time: the receive time, or a client `__timestamp` that isn't
 * more than a minute in the future. Events older than 15 minutes are
 * "from the past" and never open or close sessions.
 */
export function getTimestamp(receivedAt: number, payload: unknown) {
  const safeTimestamp = receivedAt || Date.now();
  const properties =
    payload && typeof payload === 'object' && 'properties' in payload
      ? (payload.properties as Record<string, unknown> | undefined)
      : undefined;
  const userDefinedTimestamp = properties?.__timestamp as string | undefined;

  if (!userDefinedTimestamp) {
    return { timestamp: safeTimestamp, isTimestampFromThePast: false };
  }

  const clientTimestampNumber = new Date(userDefinedTimestamp).getTime();
  if (
    Number.isNaN(clientTimestampNumber) ||
    clientTimestampNumber > safeTimestamp + ONE_MINUTE_MS
  ) {
    return { timestamp: safeTimestamp, isTimestampFromThePast: false };
  }

  return {
    timestamp: clientTimestampNumber,
    isTimestampFromThePast:
      clientTimestampNumber < safeTimestamp - FIFTEEN_MINUTES_MS,
  };
}

/** `properties.__identify`, or a bare profile id, of a track payload. */
export function getIdentity(
  body: ITrackHandlerPayload,
): IIdentifyPayload | undefined {
  if (body.type !== 'track') {
    return undefined;
  }
  const identity = body.payload.properties?.__identify as
    | IIdentifyPayload
    | undefined;
  if (identity && typeof identity === 'object') {
    return identity;
  }
  return body.payload.profileId
    ? { profileId: String(body.payload.profileId) }
    : undefined;
}

/** A caller-supplied device id from a track event's `properties.__deviceId`. */
export function getOverrideDeviceId(
  body: ITrackHandlerPayload,
): string | undefined {
  if (body.type !== 'track') {
    return undefined;
  }
  const raw = body.payload?.properties?.__deviceId;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_OVERRIDE_DEVICE_ID_LENGTH ||
    CONTROL_CHARS.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

/** The subset of request headers that ships with ingested events. */
export function getSdkHeaders(headers: Headers) {
  return {
    sdkName: headers.get('openpanel-sdk-name') ?? undefined,
    sdkVersion: headers.get('openpanel-sdk-version') ?? undefined,
  };
}

export function geoSource(
  headers: Headers,
  cf: CfGeoProperties | undefined,
): GeoSource {
  return { cf, connectingIp: headers.get('cf-connecting-ip') };
}

export async function getGeoAndAsn(ip: string, source: GeoSource) {
  const [geo, asnInfo] = await Promise.all([
    getGeoLocation(ip, source),
    getAsnInfo(ip, source),
  ]);
  return { geo, asnInfo };
}

/**
 * The device ids an event may belong to, in priority order: the override,
 * or the ids under the current and previous daily salt (a visit keeps its
 * id across the salt rotation).
 */
export async function getCandidateDeviceIds(input: {
  projectId: string;
  ip: string;
  ua: string | undefined;
  overrideDeviceId?: string;
}): Promise<string[]> {
  if (input.overrideDeviceId) {
    return [input.overrideDeviceId];
  }
  if (!input.ua) {
    return [];
  }
  const salts = await getSalts();
  return [salts.current, salts.previous].map((salt) =>
    generateDeviceId({
      salt,
      origin: input.projectId,
      ip: input.ip,
      ua: input.ua!,
    }),
  );
}

export interface DedupeInput {
  body: unknown;
  ip: string;
  origin: string | undefined;
  clientIdHeader: string | undefined;
}

/**
 * The duplicate-request fingerprint, for browser requests only (they carry
 * an origin and the client id header), like the old 100 ms Redis lock.
 */
export function getDedupeHash(input: DedupeInput): string | null {
  if (!(input.ip && input.origin && input.clientIdHeader)) {
    return null;
  }
  return requestFingerprint({
    payload: input.body,
    ip: input.ip,
    origin: input.origin,
    projectId: input.clientIdHeader,
  });
}

export interface ResolvedDevice {
  duplicate: boolean;
  deviceId: string;
  sessionId: string;
}

/**
 * The one Postgres round trip of an ingest request (Hyperdrive): claim the
 * dedupe fingerprint and read the candidates' live sessions. A live session
 * within the idle window keeps its id; otherwise the deterministic bucket
 * id, which the consumer derives too when it opens the session.
 */
export async function resolveDevice(input: {
  projectId: string;
  deviceIds: string[];
  eventTimeMs: number;
  dedupeHash: string | null;
}): Promise<ResolvedDevice> {
  const lookup = await trackLookup({
    projectId: input.projectId,
    deviceIds: input.deviceIds,
    dedupeHash: input.dedupeHash,
  });
  if (lookup.duplicate) {
    return { duplicate: true, deviceId: '', sessionId: '' };
  }
  return {
    duplicate: false,
    ...resolveSession({
      projectId: input.projectId,
      deviceIds: input.deviceIds,
      sessions: lookup.sessions,
      eventTimeMs: input.eventTimeMs,
    }),
  };
}

export interface TrackContext {
  projectId: string;
  ip: string;
  ua: string;
  /** Raw request headers: bot signals read sec-ch-ua / sec-fetch-*. */
  requestHeaders: Record<string, string>;
  sdkName?: string;
  sdkVersion?: string;
  clientSecretAuth: boolean;
  timestamp: { value: number; isFromPast: boolean };
  identity?: IIdentifyPayload;
  deviceId: string;
  sessionId: string;
  geo: GeoLocation;
  asnInfo: AsnInfo;
}
