import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { anQueryOne } from '../analytics/client';
import { sql } from '../analytics/sql';
import { withDbRoute } from '../db-routing';
import { getBucketSessionId } from './session-id';
import { getSessionTimeoutMs } from './session-machine';

/**
 * /track does exactly one Postgres round trip (Hyperdrive — the SDK waits on
 * the session id in the response):
 *
 * - claims the request fingerprint in analytics.request_dedupe for 100 ms
 *   (an identical request inside the window is a duplicate), and
 * - reads the live sessions of the candidate device ids (the current and
 *   previous salt's ids, or a caller-supplied override).
 */

const DEDUPE_WINDOW_MS = 100;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

/** Fingerprint of a request for duplicate suppression (payload + origin). */
export function requestFingerprint(input: {
  payload: unknown;
  ip: string;
  origin: string;
  projectId: string;
}): string {
  return bytesToHex(
    sha256(
      utf8ToBytes(
        stableStringify({
          ...(input.payload as Record<string, unknown>),
          ip: input.ip,
          origin: input.origin,
          projectId: input.projectId,
        }),
      ),
    ),
  );
}

export interface LiveSessionRef {
  deviceId: string;
  sessionId: string;
  /** Event time of the session's latest event. */
  endedAt: Date;
}

export interface TrackLookupResult {
  duplicate: boolean;
  sessions: LiveSessionRef[];
}

export async function trackLookup(input: {
  projectId: string;
  deviceIds: string[];
  /** Omit to skip duplicate suppression (non-browser requests, replay). */
  dedupeHash?: string | null;
}): Promise<TrackLookupResult> {
  const deviceIds = [...new Set(input.deviceIds.filter(Boolean))];
  const dedupe = input.dedupeHash
    ? sql`
        INSERT INTO analytics.request_dedupe AS d (hash, expires_at)
        VALUES (${input.dedupeHash}, clock_timestamp() + ${`${DEDUPE_WINDOW_MS} milliseconds`}::interval)
        ON CONFLICT (hash) DO UPDATE SET expires_at = EXCLUDED.expires_at
          WHERE d.expires_at < clock_timestamp()
        RETURNING 1
      `
    : sql`SELECT 1`;

  const row = await withDbRoute('trackLookup', () =>
    anQueryOne<{ claimed: boolean; sessions: { device_id: string; session_id: string; ended_at: string }[] }>(sql`
      WITH claim AS (${dedupe})
      SELECT
        EXISTS (SELECT 1 FROM claim) AS claimed,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'device_id', l.device_id,
              'session_id', l.session_id,
              'ended_at', l.ended_at
            ))
            FROM analytics.live_sessions l
            WHERE l.project_id = ${input.projectId}
              AND l.device_id = ANY(${deviceIds}::text[])
              AND l.session_id <> ''
          ),
          '[]'::json
        ) AS sessions
    `),
  );

  return {
    duplicate: row ? !row.claimed : false,
    sessions: (row?.sessions ?? []).map((session) => ({
      deviceId: session.device_id,
      sessionId: session.session_id,
      endedAt: new Date(session.ended_at),
    })),
  };
}

/**
 * Pick the device id and session id for an event, the way the Node API's
 * getInfoFromSession did: the first candidate whose live session is within
 * the idle window keeps its id (one visit keeps one id across page loads and
 * salt rotation); otherwise the primary candidate gets the deterministic
 * bucket id, which the consumer also derives if it opens the session.
 */
export function resolveSession(input: {
  projectId: string;
  /** Candidates in priority order: [current salt, previous salt] or [override]. */
  deviceIds: string[];
  sessions: LiveSessionRef[];
  eventTimeMs: number;
}): { deviceId: string; sessionId: string } {
  const candidates = [...new Set(input.deviceIds.filter(Boolean))];
  const primary = candidates[0] ?? '';
  const timeoutMs = getSessionTimeoutMs();

  for (const deviceId of candidates) {
    const session = input.sessions.find((item) => item.deviceId === deviceId);
    if (session && input.eventTimeMs - session.endedAt.getTime() < timeoutMs) {
      return { deviceId, sessionId: session.sessionId };
    }
  }

  if (!primary) {
    return { deviceId: '', sessionId: '' };
  }
  return {
    deviceId: primary,
    sessionId: getBucketSessionId({
      projectId: input.projectId,
      deviceId: primary,
      eventMs: input.eventTimeMs,
    }),
  };
}
