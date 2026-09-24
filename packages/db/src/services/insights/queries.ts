import { type Sql, ident, sql } from '../../analytics/sql';

/**
 * SQL the insight modules share. They ran on ClickHouse in UTC (the engine's
 * query builder had no session time zone), so window bounds are UTC
 * instants and `toDate(created_at)` is the UTC calendar day. The sessions
 * table has one row per session: ClickHouse's `sign = 1` is gone.
 */

export const SESSIONS_TABLE = 'analytics.sessions';
export const EVENTS_TABLE = 'analytics.events';

/**
 * A window bound as ClickHouse compared it: the query builder rendered Dates
 * as DateTime text, which has whole seconds (getEndOfDay's 23:59:59.999 was
 * 23:59:59).
 */
function bound(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();
}

/** `created_at BETWEEN start AND end`, both ends inclusive. */
export function createdBetween(start: Date, end: Date): Sql {
  return sql`created_at BETWEEN ${bound(start)}::timestamptz AND ${bound(end)}::timestamptz`;
}

/** `countIf(created_at BETWEEN start AND end) AS alias`. */
export function countCreatedBetween(start: Date, end: Date, alias: string): Sql {
  return sql`count(*) FILTER (WHERE ${createdBetween(start, end)}) AS ${ident(alias)}`;
}

/** `toDate(created_at)`: the UTC calendar day, 'YYYY-MM-DD'. */
export const CREATED_UTC_DAY = sql`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

/** The project's rows: `project_id = $n`. */
export function forProject(projectId: string): Sql {
  return sql`project_id = ${projectId}`;
}
