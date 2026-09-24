import { anQuery, anTransaction } from '../analytics/client';
import { sql } from '../analytics/sql';
import { insertEvents, upsertSessions } from '../analytics/writers';
import type { IClickhouseSession } from '../services/session.service';
import {
  type AppliedEvent,
  type PendingProfile,
  buildSessionEndEvent,
  profileFromEvent,
  toEventRow,
  writeProfiles,
  writeRollups,
} from './consumer';
import { getSessionTimeoutMs } from './session-machine';

/**
 * The session reaper (cron, every minute): closes sessions whose device has
 * been quiet for longer than the idle timeout in wall-clock time — the
 * deadman the Redis reaper ran every five minutes.
 *
 * One call closes up to `limit` sessions in one transaction: it locks their
 * live rows with SKIP LOCKED (a consumer extending a session right now wins),
 * writes the session_end events, finalizes the session rows and deletes the
 * live rows. The caller loops while a full page comes back.
 */
export interface ReapResult {
  closed: IClickhouseSession[];
  insertedEvents: AppliedEvent[];
}

export async function reapIdleSessions(
  options: { now?: Date; timeoutMs?: number; limit?: number } = {},
): Promise<ReapResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.timeoutMs ?? getSessionTimeoutMs()));
  const limit = Math.max(1, Math.floor(options.limit ?? 500));

  return anTransaction(async (client) => {
    const rows = await anQuery<{
      project_id: string;
      device_id: string;
      session: IClickhouseSession;
    }>(
      sql`
        SELECT project_id, device_id, session
        FROM analytics.live_sessions
        WHERE last_received_at < ${cutoff.toISOString()}::timestamptz
          AND session_id <> ''
        ORDER BY project_id, device_id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `,
      undefined,
      client,
    );
    if (rows.length === 0) {
      return { closed: [], insertedEvents: [] };
    }

    const sessions = rows.map((row) => row.session);
    const endEvents = sessions.map(buildSessionEndEvent);
    const eventRows = endEvents.map((event) => toEventRow(event, now));
    const insertedIds = new Set(await insertEvents(eventRows, client));

    // The consumer keeps sessions rows current; writing the final snapshot
    // again is a no-op unless a write was lost.
    await upsertSessions(
      [...sessions].sort((a, b) =>
        a.project_id === b.project_id ? (a.id < b.id ? -1 : 1) : a.project_id < b.project_id ? -1 : 1,
      ),
      client,
    );

    await anQuery(
      sql`
        DELETE FROM analytics.live_sessions l
        USING unnest(
          ${rows.map((row) => row.project_id)}::text[],
          ${rows.map((row) => row.device_id)}::text[],
          ${sessions.map((session) => session.id)}::text[]
        ) AS k(project_id, device_id, session_id)
        WHERE l.project_id = k.project_id
          AND l.device_id = k.device_id
          AND l.session_id = k.session_id
      `,
      undefined,
      client,
    );

    await writeProfiles(
      client,
      endEvents
        .map(profileFromEvent)
        .filter((profile): profile is PendingProfile => profile !== null),
      [],
      now,
    );
    await writeRollups(
      client,
      eventRows.filter((row) => insertedIds.has(row.id)),
    );

    return {
      closed: sessions,
      insertedEvents: endEvents
        .filter((event) => insertedIds.has(event.id))
        .map((payload) => ({ payload })),
    };
  });
}
