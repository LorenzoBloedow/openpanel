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
 * {@link fromLocal}, except for the wall-clock times a DST change skips or
 * repeats: ClickHouse's `toDateTime('…')` read those as the earlier of the
 * two candidate instants, Postgres reads them as the later one. In
 * Stockholm, 02:30 on the spring-forward day (skipped) and on the fall-back
 * day (repeated) are both 00:30 UTC here and 01:30 UTC with fromLocal.
 * Every other time is the same instant as fromLocal.
 *
 * The candidates are the wall clock read with the offset of the day before,
 * its own day (Postgres' reading) and the day after. The result is the
 * earliest one that shows the wall clock again in the zone; in a gap none
 * does, and the earlier of the offsets around it wins. A plain expression,
 * not a subquery, so the planner still sees the bound's value.
 */
export function fromLocalEarliest(wallClock: string | Sql, ctx: TimeCtx): Sql {
  const local = sql`(${wallClock})::timestamp`;
  const zone = sql`${ctx.timezone}::text`;
  const withDayBefore = sql`(((${local} - interval '1 day') AT TIME ZONE ${zone}) + interval '1 day')`;
  const withOwnDay = sql`(${local} AT TIME ZONE ${zone})`;
  const withDayAfter = sql`(((${local} + interval '1 day') AT TIME ZONE ${zone}) - interval '1 day')`;
  const ifShowsWallClock = (instant: Sql) =>
    sql`CASE WHEN (${instant} AT TIME ZONE ${zone}) = ${local} THEN ${instant} END`;
  return sql`COALESCE(
    LEAST(${ifShowsWallClock(withDayBefore)}, ${ifShowsWallClock(withOwnDay)}),
    LEAST(${withDayBefore}, ${withDayAfter}))`;
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

/** Unix seconds: parseDateTimeBestEffort reads a 9–10 digit number as one. */
const UNIX_SECONDS = '^[0-9]{9,10}$';
/** A time of day followed by an explicit zone (Z, UTC, GMT, ±hh[:mm]). */
const EXPLICIT_ZONE =
  '[T ][0-9]{1,2}:[0-9]{2}(:[0-9]{2}([.,][0-9]+)?)? ?([zZ]|UTC|GMT|[+-][0-9]{1,2}(:?[0-9]{2})?)$';
/** DD/MM/YYYY, which the best-effort parser reads day first. */
const DAY_MONTH_YEAR = '^([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})';
const YEAR_MONTH_DAY = '\\3-\\2-\\1';

/**
 * Text → `timestamptz`, or NULL when it isn't a date — ClickHouse's
 * `parseDateTimeBestEffortOrNull` under `session_timezone`: text with an
 * explicit zone is that instant, text without one is wall-clock time in the
 * project zone, 9–10 digits are unix seconds, DD/MM/YYYY is day first.
 * Never raises on bad input.
 */
export function parseTimestamp(text: Sql, ctx: TimeCtx): Sql {
  return sql`(SELECT CASE
    WHEN _ts.v ~ ${UNIX_SECONDS} THEN to_timestamp(_ts.v::double precision)
    WHEN _ts.v ~ ${EXPLICIT_ZONE} THEN analytics.to_ts_or_null(_ts.v)
    WHEN pg_input_is_valid(_ts.v, 'timestamp') THEN _ts.v::timestamp AT TIME ZONE ${ctx.timezone}::text
  END FROM (SELECT regexp_replace(btrim((${text})::text), ${DAY_MONTH_YEAR}, ${YEAR_MONTH_DAY}) AS v) AS _ts)`;
}

/** The project-zone calendar date of an instant (ClickHouse `toDate`). */
export function toLocalDate(instant: Sql, ctx: TimeCtx): Sql {
  return sql`(${toLocal(instant, ctx)})::date`;
}

/** A Postgres interval literal for `count` units, e.g. `interval '1 day'`. */
export function interval(count: number, value: TimeUnit): Sql {
  if (!Number.isInteger(count)) {
    throw new Error(`Interval count must be an integer: ${count}`);
  }
  unit(value);
  return raw(`interval '${count} ${value}'`);
}
