import { DateTime } from '@openpanel/common';
import { anQuery } from '@openpanel/db/src/analytics/client';
import { gapFill } from '@openpanel/db/src/analytics/fill';
import { type Sql, raw, sql } from '@openpanel/db/src/analytics/sql';
import { type TimeCtx, startOf } from '@openpanel/db/src/analytics/time';

/**
 * Time windows of the analytics queries written in the routers. ClickHouse
 * evaluated `now() - INTERVAL …` in the project's session_timezone; these
 * take the clock from JS (so frozen test clocks apply) and do the same
 * calendar arithmetic.
 */

const MINUTE_MS = 60_000;

/** ClickHouse's now(): the current time in whole seconds. */
export function secondsNow(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

/**
 * `now() - INTERVAL <amount>` under session_timezone: calendar arithmetic on
 * the project's wall clock, so 30 days across a DST change are 30 local
 * days rather than 720 hours.
 */
export function zonedMinus(
  date: Date,
  timezone: string,
  amount: { months?: number; days?: number },
): Date {
  return DateTime.fromJSDate(date, { zone: timezone }).minus(amount).toJSDate();
}

/** The project wall-clock text of an instant ('YYYY-MM-DD HH:MM:SS'). */
export function zonedWallClock(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date, { zone: timezone }).toFormat(
    'yyyy-MM-dd HH:mm:ss',
  );
}

/** An instant as a bound `timestamptz`. */
export function instant(date: Date): Sql {
  return sql`${date.toISOString()}::timestamptz`;
}

/** `created_at >= <instant>`. */
export function createdSince(date: Date): Sql {
  return sql`created_at >= ${instant(date)}`;
}

// --- the live views (overview live data, realtime widget) -----------------------

const LIVE_WINDOW_MS = 30 * MINUTE_MS;

/** `now() - INTERVAL 30 MINUTE`: where the live views' window starts. */
export function liveWindowStart(now: Date = secondsNow()): Date {
  return new Date(now.getTime() - LIVE_WINDOW_MS);
}

/** The last 30 minutes of a project's events, for the live views. */
export interface LiveWindow extends TimeCtx {
  projectId: string;
  now: Date;
}

export function liveWindow(projectId: string, timezone: string): LiveWindow {
  return { projectId, timezone, now: secondsNow() };
}

/** The window's events: `project_id = … AND created_at >= <start>`. */
export function liveEvents(window: LiveWindow): Sql {
  return sql`project_id = ${window.projectId}
    AND ${createdSince(liveWindowStart(window.now))}`;
}

/**
 * An event's minute on the project's wall clock (`toStartOfMinute` under
 * session_timezone), as a `timestamp`. Format it with to_char after
 * grouping.
 */
export function liveMinute(window: LiveWindow): Sql {
  return startOf(raw('created_at'), 'minute', window);
}

export interface LiveMinuteCount {
  minute: string;
  session_count: number;
  visitor_count: number;
}

/**
 * Distinct sessions and visitors per minute of the window, oldest first,
 * with empty minutes from the window's first minute up to (not including)
 * the current one — ClickHouse's `WITH FILL FROM toStartOfMinute(now() -
 * INTERVAL 30 MINUTE) TO toStartOfMinute(now())`.
 */
export async function getLiveMinuteCounts(
  window: LiveWindow,
): Promise<LiveMinuteCount[]> {
  // A type literal, which gapFill's row constraint accepts.
  const rows = await anQuery<{
    minute: string;
    session_count: number;
    visitor_count: number;
  }>(sql`
    SELECT
      to_char(e.minute, 'YYYY-MM-DD HH24:MI:SS') AS minute,
      COUNT(DISTINCT e.session_id) AS session_count,
      COUNT(DISTINCT e.profile_id) AS visitor_count
    FROM (
      SELECT ${liveMinute(window)} AS minute, session_id, profile_id
      FROM analytics.events
      WHERE ${liveEvents(window)}
    ) AS e
    GROUP BY e.minute
    ORDER BY e.minute
  `);
  const currentMinute = Math.floor(window.now.getTime() / MINUTE_MS) * MINUTE_MS;
  return gapFill(rows, {
    key: 'minute',
    from: zonedWallClock(liveWindowStart(window.now), window.timezone),
    to: zonedWallClock(new Date(currentMinute), window.timezone),
    unit: 'minute',
    fill: (minute) => ({ minute, session_count: 0, visitor_count: 0 }),
  });
}
