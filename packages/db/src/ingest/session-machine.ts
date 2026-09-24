import { getEnv } from '@openpanel/runtime';

import type { IServiceCreateEventPayload } from '../services/event.service';
import type { IClickhouseSession } from '../services/session.service';

/**
 * The session lifecycle, as pure functions: the rules SessionBuffer applied
 * against Redis, now applied by the ingest consumer to the rows it holds
 * locked in analytics.live_sessions.
 *
 * - The first event of a device opens a session.
 * - An event within the idle timeout (in event time) of the session's last
 *   event extends it; out-of-order events widen the [created_at, ended_at]
 *   window instead of moving it backwards.
 * - A larger gap closes the session (a boundary) and opens a new one.
 * - session_start / session_end are derived signals and never feed back in.
 */

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** Idle window in event time. Env-overridable so E2E tests can shrink it. */
export function getSessionTimeoutMs(): number {
  const raw =
    getEnv<{ SESSION_TIMEOUT_MS?: string }>().SESSION_TIMEOUT_MS ??
    (typeof process !== 'undefined' ? process.env.SESSION_TIMEOUT_MS : undefined);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TIMEOUT_MS;
}

export type SessionTransition =
  | { kind: 'new'; current: IClickhouseSession }
  | { kind: 'extend'; current: IClickhouseSession }
  | { kind: 'boundary'; current: IClickhouseSession; closed: IClickhouseSession };

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** UTC 'YYYY-MM-DD HH:MM:SS.mmm', the session snapshot's timestamp format. */
export function toSessionDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
}

export function fromSessionDate(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

export function isSessionSignal(name: string): boolean {
  return name === 'session_start' || name === 'session_end';
}

function pickUtm(
  payload: IServiceCreateEventPayload,
  key: 'utm_medium' | 'utm_source' | 'utm_campaign' | 'utm_content' | 'utm_term',
): string {
  const query = (payload.properties as { __query?: Record<string, unknown> } | undefined)
    ?.__query;
  const value = query?.[key];
  return value ? String(value) : '';
}

/** Open a session from its first event (SessionBuffer.newSession). */
export function newSession(payload: IServiceCreateEventPayload): IClickhouseSession {
  const createdAt = toSessionDate(payload.createdAt);
  // Anonymous traffic has no profile id: the device stands in for it so each
  // anonymous device counts as a unique visitor.
  const profileId = payload.profileId || payload.deviceId;
  return {
    id: payload.sessionId,
    project_id: payload.projectId,
    device_id: payload.deviceId,
    profile_id: profileId,
    is_bounce: true,
    created_at: createdAt,
    ended_at: createdAt,
    event_count: payload.name === 'screen_view' ? 0 : 1,
    screen_view_count: payload.name === 'screen_view' ? 1 : 0,
    entry_path: payload.path ?? '',
    entry_origin: payload.origin ?? '',
    exit_path: payload.path ?? '',
    exit_origin: payload.origin ?? '',
    revenue: payload.name === 'revenue' ? (payload.revenue ?? 0) : 0,
    referrer: payload.referrer ?? '',
    referrer_name: payload.referrerName ?? '',
    referrer_type: payload.referrerType ?? '',
    os: payload.os ?? '',
    os_version: payload.osVersion ?? '',
    browser: payload.browser ?? '',
    browser_version: payload.browserVersion ?? '',
    device: payload.device ?? '',
    brand: payload.brand ?? '',
    model: payload.model ?? '',
    country: payload.country ?? '',
    region: payload.region ?? '',
    city: payload.city ?? '',
    longitude: payload.longitude ?? null,
    latitude: payload.latitude ?? null,
    duration: payload.duration ?? 0,
    utm_medium: pickUtm(payload, 'utm_medium'),
    utm_source: pickUtm(payload, 'utm_source'),
    utm_campaign: pickUtm(payload, 'utm_campaign'),
    utm_content: pickUtm(payload, 'utm_content'),
    utm_term: pickUtm(payload, 'utm_term'),
    groups: payload.groups ?? [],
    sign: 1,
    version: 1,
  };
}

/** Fold one more event into a live session (SessionBuffer.extendSession). */
export function extendSession(
  existing: IClickhouseSession,
  payload: IServiceCreateEventPayload,
): IClickhouseSession {
  const current: IClickhouseSession = {
    ...existing,
    sign: 1,
    version: existing.version + 1,
  };

  // The window is [min(event ts), max(event ts)]: late events (offline
  // flushes, retries) can't drag ended_at back or make duration negative.
  const eventTimeMs = payload.createdAt.getTime();
  const startMs = fromSessionDate(current.created_at).getTime();
  const endMs = fromSessionDate(current.ended_at).getTime();
  const eventDate = toSessionDate(payload.createdAt);

  if (eventTimeMs >= endMs) {
    current.ended_at = eventDate;
    if (payload.path) {
      current.exit_path = payload.path;
    }
    if (payload.origin) {
      current.exit_origin = payload.origin;
    }
  }

  if (eventTimeMs < startMs) {
    current.created_at = eventDate;
    if (payload.path) {
      current.entry_path = payload.path;
    }
    if (payload.origin) {
      current.entry_origin = payload.origin;
    }
  } else {
    if (!current.entry_path && payload.path) {
      current.entry_path = payload.path;
    }
    if (!current.entry_origin && payload.origin) {
      current.entry_origin = payload.origin;
    }
  }

  current.duration =
    fromSessionDate(current.ended_at).getTime() -
    fromSessionDate(current.created_at).getTime();

  if (payload.name === 'revenue') {
    current.revenue = (current.revenue ?? 0) + (payload.revenue ?? 0);
  }

  if (payload.name === 'screen_view' && payload.path) {
    current.screen_view_count += 1;
  } else {
    current.event_count += 1;
  }

  if (current.screen_view_count > 1) {
    current.is_bounce = false;
  }

  if (payload.profileId && payload.profileId !== payload.deviceId) {
    current.profile_id = payload.profileId;
  }

  if (payload.groups?.length) {
    current.groups = [...new Set([...(current.groups ?? []), ...payload.groups])];
  }

  return current;
}

/**
 * Apply one event to the device's live session. Returns null for events
 * that don't take part in sessions (session signals, no device).
 */
export function applyEventToSession(
  existing: IClickhouseSession | null,
  payload: IServiceCreateEventPayload,
  timeoutMs = getSessionTimeoutMs(),
): SessionTransition | null {
  if (!payload.projectId || !payload.deviceId) return null;
  if (isSessionSignal(payload.name)) return null;

  const eventTimeMs = payload.createdAt.getTime();
  const isBoundary =
    existing !== null &&
    eventTimeMs - fromSessionDate(existing.ended_at).getTime() > timeoutMs;

  if (existing && !isBoundary) {
    return { kind: 'extend', current: extendSession(existing, payload) };
  }

  const current = newSession(payload);
  if (existing && isBoundary) {
    return { kind: 'boundary', current, closed: existing };
  }
  return { kind: 'new', current };
}
