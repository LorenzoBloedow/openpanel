import { type Sql, raw, sql } from './sql';

/**
 * Time zone handling for the analytics queries.
 *
 * ClickHouse ran every query with `session_timezone = <project timezone>`,
 * which silently changed what `toStartOfDay(created_at)` and a bound like
 * `created_at >= '2024-05-01 00:00:00'` meant. Postgres gets no such
 * session state through a transaction-mode pooler, so the time zone is
 * explicit: every helper that depends on it takes a {@link TimeCtx}, which
 * makes the compiler point at each place that relied on the implicit one.
 *
 * `timestamptz` columns hold instants. Wall-clock values — the date range
 * strings the dashboard sends, bucket labels — are `timestamp` (without time
 * zone) in the project's zone.
 */

export interface TimeCtx {
  /** IANA zone, e.g. `Europe/Stockholm`. DST is handled by Postgres. */
  timezone: string;
}

export type TimeUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

const UNITS: ReadonlySet<string> = new Set([
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'year',
]);

function unit(value: TimeUnit): Sql {
  if (!UNITS.has(value)) {
    throw new Error(`Unsupported time unit: ${value}`);
  }
  return raw(`'${value}'`);
}

/** The wall-clock time (`timestamp`) of an instant column in the project zone. */
export function toLocal(instant: Sql, ctx: TimeCtx): Sql {
  return sql`(${instant} AT TIME ZONE ${ctx.timezone}::text)`;
}

/**
 * The instant of a wall-clock value in the project zone. Takes the
 * `YYYY-MM-DD HH:MM:SS` strings produced by getDatesFromRange /
 * getChartStartEndDate. Keeps comparisons like
 * `e.created_at >= fromLocal(start)` index-friendly.
 */
export function fromLocal(wallClock: string | Sql, ctx: TimeCtx): Sql {
  return sql`(${wallClock}::timestamp AT TIME ZONE ${ctx.timezone}::text)`;
}

/**
 * Start of the `unit` containing `instant`, as project wall-clock time —
 * ClickHouse's toStartOfMinute/Hour/Day/Week(…, 1)/Month under the session
 * time zone. Weeks start on Monday (ISO), as `toStartOfWeek(x, 1)` did.
 */
export function startOf(instant: Sql, value: TimeUnit, ctx: TimeCtx): Sql {
  return sql`date_trunc(${unit(value)}, ${toLocal(instant, ctx)})`;
}

/** Start of the `unit` containing a wall-clock value (no zone conversion). */
export function startOfLocal(wallClock: Sql, value: TimeUnit): Sql {
  return sql`date_trunc(${unit(value)}, ${wallClock})`;
}

/** `YYYY-MM-DD HH:MM:SS`, the text ClickHouse rendered DateTime values as. */
export function formatDateTime(wallClock: Sql): Sql {
  return sql`to_char(${wallClock}, 'YYYY-MM-DD HH24:MI:SS')`;
}

/** `YYYY-MM-DD`, the text ClickHouse rendered Date values as. */
export function formatDate(wallClock: Sql): Sql {
  return sql`to_char(${wallClock}, 'YYYY-MM-DD')`;
}

/** A Postgres interval literal for `count` units, e.g. `interval '1 day'`. */
export function interval(count: number, value: TimeUnit): Sql {
  if (!Number.isInteger(count)) {
    throw new Error(`Interval count must be an integer: ${count}`);
  }
  unit(value);
  return raw(`interval '${count} ${value}'`);
}
