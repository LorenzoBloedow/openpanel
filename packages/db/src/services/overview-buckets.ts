import { DateTime } from '@openpanel/common';
import type { IInterval } from '@openpanel/validation';

import { clix } from '../analytics/query-builder';
import { type Sql, raw, sql } from '../analytics/sql';
import { type TimeCtx, fromLocal } from '../analytics/time';

/**
 * Time buckets of the overview, pages and referrer-spike queries, and the
 * ClickHouse `ORDER BY date WITH FILL` they relied on.
 *
 * Those queries ran with `session_timezone = <project zone>` and bucketed
 * with the ClickHouse builder's `toStartOf`:
 *
 * - minute / hour / day: `toStartOf{Minute,Hour,Day}(created_at)`, a
 *   DateTime: the instant the local minute/hour/day starts, rendered as local
 *   wall-clock text ('YYYY-MM-DD HH:MM:SS');
 * - week / month: `toStartOf{Week,Month}(toDateTime(created_at))`, a Date of
 *   the local calendar ('YYYY-MM-DD'). `toStartOfWeek` without a mode starts
 *   weeks on SUNDAY (the charts pass mode 1 and start on Monday).
 *
 * A bucket is grouped by its instant, so the repeated hour of a DST
 * fall-back stays two buckets, as it was. Rows carry the bucket as `key`
 * (the instant as UTC text, or the date) and as the `label` ClickHouse
 * returned.
 */

const DATE_BUCKETS: ReadonlySet<string> = new Set(['week', 'month']);

const TRUNC_UNITS: Readonly<Record<string, string>> = {
  minute: 'minute',
  hour: 'hour',
  day: 'day',
};

const WALL_CLOCK = 'yyyy-MM-dd HH:mm:ss';
const DATE_ONLY = 'yyyy-MM-dd';

function isDateBucket(interval: IInterval): boolean {
  if (DATE_BUCKETS.has(interval)) {
    return true;
  }
  if (Object.hasOwn(TRUNC_UNITS, interval)) {
    return false;
  }
  throw new Error(`Unsupported interval: ${JSON.stringify(interval)}`);
}

const zone = (ctx: TimeCtx) => sql`${ctx.timezone}::text`;

/**
 * The bucket of an instant column: a `timestamptz` (minute/hour/day) or a
 * `date` (week/month) in the project zone.
 */
export function bucketOf(column: Sql, interval: IInterval, ctx: TimeCtx): Sql {
  if (!isDateBucket(interval)) {
    return sql`date_trunc(${raw(`'${TRUNC_UNITS[interval]}'`)}, ${column}, ${zone(ctx)})`;
  }
  const local = sql`(${column} AT TIME ZONE ${zone(ctx)})`;
  if (interval === 'week') {
    // Postgres weeks start on Monday; shift by a day for Sunday weeks.
    return sql`(date_trunc('week', ${local} + interval '1 day') - interval '1 day')::date`;
  }
  return sql`date_trunc('month', ${local})::date`;
}

/** The text ClickHouse returned for a bucket of {@link bucketOf}. */
export function bucketLabel(bucket: Sql, interval: IInterval, ctx: TimeCtx): Sql {
  return isDateBucket(interval)
    ? sql`to_char(${bucket}, 'YYYY-MM-DD')`
    : sql`to_char(${bucket} AT TIME ZONE ${zone(ctx)}, 'YYYY-MM-DD HH24:MI:SS')`;
}

/** The identity of a bucket of {@link bucketOf}, matched against {@link fillBuckets}. */
export function bucketKey(bucket: Sql, interval: IInterval): Sql {
  return isDateBucket(interval)
    ? sql`to_char(${bucket}, 'YYYY-MM-DD')`
    : sql`to_char(${bucket} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;
}

/**
 * `column BETWEEN toDateTime(start) AND toDateTime(end)`: the bounds are
 * wall-clock times in the project zone (ClickHouse read `toDateTime('…')`
 * in the session zone), normalised the way `clix.datetime` did.
 */
export function createdBetween(
  column: Sql,
  range: { startDate: string; endDate: string },
  ctx: TimeCtx,
): Sql {
  return sql`${column} BETWEEN ${fromLocal(clix.datetime(range.startDate), ctx)} AND ${fromLocal(clix.datetime(range.endDate), ctx)}`;
}

/**
 * Milliseconds from a screen view (alias `e`) to the next one of its
 * session, 0 for the last: `dateDiff('millisecond', created_at,
 * lead(created_at, 1, created_at) OVER (PARTITION BY session_id ORDER BY
 * created_at))`. The window runs over the rows the query's WHERE keeps.
 */
export const MS_TO_NEXT_VIEW = sql`(extract(epoch from lead(e.created_at, 1, e.created_at) OVER (PARTITION BY e.session_id ORDER BY e.created_at) - e.created_at) * 1000)::bigint`;

/**
 * ClickHouse `round(x, digits)` of a Float64: `x * 10^digits` rounded half
 * to even, which is what Postgres' `round(double precision)` does.
 */
export function chRound(value: Sql, digits: number): Sql {
  const scale = raw(String(10 ** digits));
  return sql`(round((${value})::double precision * ${scale}) / ${scale})`;
}

export interface Bucket {
  key: string;
  label: string;
}

/**
 * The buckets ClickHouse's `WITH FILL FROM toStartOf(start) TO end STEP 1
 * <interval>` generated for these queries: minute/hour/day from the bucket
 * of `toDateTime(start)` while before `toDateTime(end)` (minutes and hours
 * step in absolute time, days in the local calendar); week/month from the
 * bucket of `toDate(start)` while before `toDate(end)`.
 */
export function fillBuckets(
  interval: IInterval,
  startDate: string,
  endDate: string,
  timezone: string,
): Bucket[] {
  const start = clix.datetime(startDate);
  const end = clix.datetime(endDate);
  const buckets: Bucket[] = [];

  if (isDateBucket(interval)) {
    const first = DateTime.fromFormat(start.slice(0, 10), DATE_ONLY, { zone: 'utc' });
    const to = DateTime.fromFormat(end.slice(0, 10), DATE_ONLY, { zone: 'utc' });
    const step = interval === 'week' ? { weeks: 1 } : { months: 1 };
    // Luxon weekdays run Monday = 1 … Sunday = 7.
    let cursor =
      interval === 'week' ? first.minus({ days: first.weekday % 7 }) : first.startOf('month');
    while (cursor < to) {
      const label = cursor.toFormat(DATE_ONLY);
      buckets.push({ key: label, label });
      cursor = cursor.plus(step);
    }
    return buckets;
  }

  const unit = TRUNC_UNITS[interval] as 'minute' | 'hour' | 'day';
  const to = DateTime.fromFormat(end, WALL_CLOCK, { zone: timezone });
  let cursor = DateTime.fromFormat(start, WALL_CLOCK, { zone: timezone }).startOf(unit);
  while (cursor < to) {
    buckets.push({
      key: cursor.toUTC().toFormat(WALL_CLOCK),
      label: cursor.toFormat(WALL_CLOCK),
    });
    cursor = cursor.plus({ [unit]: 1 });
  }
  return buckets;
}

/**
 * `rows` with a `fill(bucket)` row for every bucket none of them has, in
 * bucket order; rows of one bucket keep their order and rows outside the
 * buckets stay, as with WITH FILL.
 */
export function withFill<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  buckets: readonly Bucket[],
  fill: (bucket: Bucket) => T,
): T[] {
  const present = new Set(rows.map(keyOf));
  const entries = rows.map((row) => ({ key: keyOf(row), row }));
  for (const bucket of buckets) {
    if (!present.has(bucket.key)) {
      entries.push({ key: bucket.key, row: fill(bucket) });
    }
  }
  // Array.prototype.sort is stable.
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return entries.map((entry) => entry.row);
}

/**
 * Whether ClickHouse's `date = '1970-01-01 00:00:00'` found a ROLLUP totals
 * row. The totals row carries the zero value — the epoch — and the literal
 * was read in the project zone (clamped at the epoch): only zones at or east
 * of UTC matched. A Date bucket compares with '1970-01-01' and always does.
 */
export function rollupSentinelMatches(interval: IInterval, timezone: string): boolean {
  if (isDateBucket(interval)) {
    return true;
  }
  return DateTime.fromFormat('1970-01-01 00:00:00', WALL_CLOCK, { zone: timezone }).toMillis() <= 0;
}
