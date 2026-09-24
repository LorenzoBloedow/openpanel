import { DateTime, round } from '@openpanel/common';
import type { IChartEventFilter } from '@openpanel/validation';
import { range } from 'ramda';

import { anQuery } from '../analytics/client';
import { eventFilterClauses } from '../analytics/filters';
import { type Sql, and, anyOf, raw, sql } from '../analytics/sql';
import { interval as intervalOf } from '../analytics/time';

/**
 * The retention queries ran without a session time zone, so every day,
 * week and month here is a UTC one, and the date bounds are UTC wall-clock
 * time (`toDateTime('…')` on a UTC server).
 */
const UTC = { timezone: 'UTC' } as const;

type IGetWeekRetentionInput = {
  projectId: string;
};

/**
 * toStartOfWeek (mode 0) of a date: the Sunday on or before it. Postgres'
 * date_trunc('week') would give the Monday.
 */
function sundayOf(day: Sql): Sql {
  return sql`(${day} - extract(dow from ${day})::integer)`;
}

// Week-over-week retention graph: for each week, how many active users were
// also active the following week.
//
// Reads the profile_event_days rollup (one row per identified profile, event
// name and UTC day) instead of the events: the same weeks for the same
// profiles (profile_id <> device_id), without scanning the project's whole
// event history.
export function getRetentionSeries({ projectId }: IGetWeekRetentionInput) {
  // weekly_active is one row per (profile, week), so the LEFT JOIN matches at
  // most one next-week row and plain counts are distinct counts.
  return anQuery<{
    date: string;
    active_users: number;
    retained_users: number;
    retention: number;
  }>(sql`
    WITH weekly_active AS (
      SELECT DISTINCT profile_id, ${sundayOf(raw('day'))} AS week
      FROM analytics.profile_event_days
      WHERE project_id = ${projectId}
    )
    SELECT
      to_char(cur.week, 'YYYY-MM-DD') AS date,
      count(*) AS active_users,
      count(nxt.profile_id) AS retained_users,
      100 * (count(nxt.profile_id)::double precision / count(*)::double precision) AS retention
    FROM weekly_active AS cur
    LEFT JOIN weekly_active AS nxt
      ON nxt.profile_id = cur.profile_id
      AND nxt.week = cur.week + 7
    GROUP BY cur.week
    ORDER BY cur.week ASC
  `);
}

// https://medium.com/@andre_bodro/how-to-fast-calculating-mau-in-clickhouse-fd793559b229
// Rolling active users
export type IServiceRetentionRollingActiveUsers = {
  date: string;
  users: number;
};

/**
 * Distinct active profiles (anonymous devices included) in the `days`-day
 * window ending on each date: every date some window reaches, so the series
 * runs `days - 1` days past the last active day, as the ClickHouse
 * `ARRAY JOIN range(days)` did.
 *
 * Each active day covers the dates up to the profile's next active day (at
 * most `days` of them), so every (profile, date) pair is produced exactly
 * once and a plain count is the distinct count — no DISTINCT over
 * `active days × days` rows.
 */
export function getRollingActiveUsers({
  projectId,
  days,
}: IGetWeekRetentionInput & { days: number }) {
  if (!Number.isInteger(days) || days < 1) {
    return Promise.resolve<IServiceRetentionRollingActiveUsers[]>([]);
  }
  const lastOffset = days - 1;
  return anQuery<IServiceRetentionRollingActiveUsers>(sql`
    SELECT to_char(active.day + n, 'YYYY-MM-DD') AS date, count(*) AS users
    FROM (
      SELECT day, lead(day) OVER (PARTITION BY profile_id ORDER BY day) AS next_day
      FROM analytics.dau
      WHERE project_id = ${projectId}
    ) AS active
    CROSS JOIN LATERAL generate_series(
      0,
      LEAST(${lastOffset}::integer, COALESCE(active.next_day - active.day - 1, ${lastOffset}::integer))
    ) AS n
    GROUP BY active.day + n
    ORDER BY 1
  `);
}

/**
 * Identified profiles by days since their last event: `dateDiff('day',
 * last_active, today())` in UTC, with today taken from the JS clock.
 * max(day) of the profile_event_days rollup is the UTC day of the last
 * identified event.
 */
export function getRetentionLastSeenSeries({
  projectId,
}: IGetWeekRetentionInput) {
  const today = new Date().toISOString().slice(0, 10);
  return anQuery<{
    days: number;
    users: number;
  }>(sql`
    SELECT ${today}::date - last_active.day AS days, count(*) AS users
    FROM (
      SELECT profile_id, max(day) AS day
      FROM analytics.profile_event_days
      WHERE project_id = ${projectId}
      GROUP BY profile_id
    ) AS last_active
    GROUP BY 1
    ORDER BY 1 ASC
  `);
}

export async function getRollingActiveUsersCore(input: {
  projectId: string;
  days: number;
}) {
  const data = await getRollingActiveUsers(input);
  return {
    window_days: input.days,
    label:
      input.days === 1
        ? 'DAU'
        : input.days === 7
          ? 'WAU'
          : input.days === 30
            ? 'MAU'
            : `${input.days}d active`,
    series: data,
  };
}

export async function getWeeklyRetentionSeriesCore(projectId: string) {
  return getRetentionSeries({ projectId });
}

// Weekly active-user retention cohort over the last 12 weeks, computed by the
// unified getRetentionCohort engine (replaces the legacy, broken
// getRetentionCohortTable). firstEvent/secondEvent are omitted so any
// identified activity counts toward the cohort.
export async function getRetentionCohortCore(projectId: string) {
  const end = DateTime.now();
  const start = end.minus({ weeks: 12 });
  return getRetentionCohort({
    projectId,
    interval: 'week',
    startDate: start.toFormat('yyyy-MM-dd HH:mm:ss'),
    endDate: end.toFormat('yyyy-MM-dd HH:mm:ss'),
  });
}

export async function getEngagementCore(projectId: string) {
  const raw = await getRetentionLastSeenSeries({ projectId });

  let active_0_7 = 0;
  let active_8_14 = 0;
  let active_15_30 = 0;
  let active_31_60 = 0;
  let churned_60_plus = 0;

  for (const row of raw) {
    if (row.days <= 7) active_0_7 += row.users;
    else if (row.days <= 14) active_8_14 += row.users;
    else if (row.days <= 30) active_15_30 += row.users;
    else if (row.days <= 60) active_31_60 += row.users;
    else churned_60_plus += row.users;
  }

  const total =
    active_0_7 + active_8_14 + active_15_30 + active_31_60 + churned_60_plus;

  return {
    summary: {
      total_identified_users: total,
      active_last_7_days: active_0_7,
      active_8_to_14_days: active_8_14,
      active_15_to_30_days: active_15_30,
      inactive_31_to_60_days: active_31_60,
      churned_60_plus_days: churned_60_plus,
    },
    distribution: raw,
  };
}

// ---------------------------------------------------------------------------
// Cohort retention matrix
//
// This is the single source of truth for retention cohorts. It powers the
// dashboard retention chart (via the tRPC `cohort` procedure) as well as the
// MCP / agent / REST retention endpoints.
//
// Definition: every user is assigned to exactly ONE cohort, the interval of
// their FIRST `firstEvent` within the window (first-touch). For each cohort we
// count how many of those users performed `secondEvent` 0..N intervals later.
//   - criteria 'on'           -> active exactly k intervals after  (=)
//   - criteria 'on_or_after'  -> active at least k intervals after  (>=, cumulative)
// When `firstEvent` / `secondEvent` is empty the name filter is dropped and the
// query measures retention on ANY activity (active-user retention).
// ---------------------------------------------------------------------------

export type IRetentionInterval = 'minute' | 'hour' | 'day' | 'week' | 'month';
export type IRetentionCriteria = 'on' | 'on_or_after';

export type IGetRetentionCohortInput = {
  projectId: string;
  /** Event name(s) defining cohort entry. Empty/undefined => any event. */
  firstEvent?: string[];
  /** Event name(s) that count as "returned". Empty/undefined => any event. */
  secondEvent?: string[];
  criteria?: IRetentionCriteria;
  interval?: IRetentionInterval;
  /** ISO or `yyyy-MM-dd HH:mm:ss`. */
  startDate: string;
  /** ISO or `yyyy-MM-dd HH:mm:ss`. */
  endDate: string;
  /**
   * Property and/or cohort filters scoping the analysed events. Cohort
   * membership (inCohort/notInCohort) keeps the fast profile_event_days
   * path; any property/column filter falls back to the raw events table.
   */
  filters?: IChartEventFilter[];
};

export type IRetentionCohortRow = {
  cohort_interval: string;
  sum: number;
  values: number[];
  percentages: number[];
};

/** The period a retention interval counts in; minute and hour count days. */
type RetentionPeriod = 'day' | 'week' | 'month';

const PERIOD: Record<IRetentionInterval, RetentionPeriod> = {
  minute: 'day',
  hour: 'day',
  day: 'day',
  week: 'week',
  month: 'month',
};

const LUXON_UNIT: Record<IRetentionInterval, 'days' | 'weeks' | 'months'> = {
  minute: 'days',
  hour: 'days',
  day: 'days',
  week: 'weeks',
  month: 'months',
};

/** The period containing a date (toDate / toStartOfWeek / toStartOfMonth). */
function periodStart(day: Sql, period: RetentionPeriod): Sql {
  switch (period) {
    case 'day':
      return day;
    case 'week':
      return sundayOf(day);
    case 'month':
      // Through `timestamp`: date_trunc of a bare date goes through
      // timestamptz, in the connection's time zone.
      return sql`date_trunc('month', (${day})::timestamp)::date`;
  }
}

/**
 * `dateDiff(period, from, to)` between two period starts: whole days, whole
 * weeks (both are Sundays) or calendar months.
 */
function periodsBetween(from: Sql, to: Sql, period: RetentionPeriod): Sql {
  switch (period) {
    case 'day':
      return sql`(${to} - ${from})`;
    case 'week':
      return sql`((${to} - ${from}) / 7)`;
    case 'month':
      return sql`((extract(year from ${to})::integer * 12 + extract(month from ${to})::integer) - (extract(year from ${from})::integer * 12 + extract(month from ${from})::integer))`;
  }
}

// Normalize an ISO or `yyyy-MM-dd HH:mm:ss` string into ClickHouse date-time form.
function utc(date: string) {
  return date.replace('T', ' ').slice(0, 19);
}

// Number of `interval` buckets spanned by [startDate, endDate]; drives the
// number of retention columns (0..diffInterval). NaN when a date doesn't
// parse.
function diffIntervalCount(
  startDate: string,
  endDate: string,
  interval: IRetentionInterval
) {
  const unit = LUXON_UNIT[interval];
  const start = DateTime.fromFormat(utc(startDate), 'yyyy-MM-dd HH:mm:ss', {
    zone: 'utc',
  });
  const end = DateTime.fromFormat(utc(endDate), 'yyyy-MM-dd HH:mm:ss', {
    zone: 'utc',
  });
  return Math.max(0, Math.floor(end.diff(start, unit).as(unit)));
}

/** `name = ANY(…)`; null means "any event". */
function eventNameWhere(column: Sql, events: string[] | undefined): Sql | null {
  if (!events || events.length === 0) {
    return null;
  }
  return anyOf(column, events);
}

/** Where the retention matrix reads its (profile, UTC day) activity from. */
interface RetentionSource {
  table: Sql;
  /** The UTC day of a row. */
  day: Sql;
  /** Rows of the project (and filters) that count. */
  where: Sql;
  /** The row is at or after / at or before a UTC wall-clock `timestamp`. */
  since: (bound: Sql) => Sql;
  until: (bound: Sql) => Sql;
}

/**
 * profile_event_days is the Postgres cohort_events_mv: one row per
 * identified profile, event name and UTC day. Its day compares with the
 * bounds as midnight, as ClickHouse compared a Date with a DateTime (a
 * start bound after midnight skips that day).
 */
function rollupSource(projectId: string, filters: IChartEventFilter[]): RetentionSource {
  return {
    table: raw('analytics.profile_event_days AS src'),
    day: raw('src.day'),
    where: and([
      sql`src.project_id = ${projectId}`,
      ...eventFilterClauses(filters, { ...UTC, projectId, alias: 'src' }),
    ]),
    since: (bound) => sql`src.day >= ${bound}`,
    until: (bound) => sql`src.day <= ${bound}`,
  };
}

/** The raw events, for filters on event columns and properties. */
function eventsSource(projectId: string, filters: IChartEventFilter[]): RetentionSource {
  return {
    table: raw('analytics.events AS src'),
    day: raw(`(src.created_at AT TIME ZONE 'UTC')::date`),
    where: and([
      sql`src.project_id = ${projectId}`,
      // The rollup only holds identified-user rows; replicate that here.
      raw('src.profile_id <> src.device_id'),
      ...eventFilterClauses(filters, { ...UTC, projectId, alias: 'src' }),
    ]),
    since: (bound) => sql`src.created_at >= (${bound} AT TIME ZONE 'UTC')`,
    until: (bound) => sql`src.created_at <= (${bound} AT TIME ZONE 'UTC')`,
  };
}

/**
 * The retention matrix as rows of (cohort, period, users), with the cohort's
 * size: `users` is the number of the cohort's profiles active in exactly
 * that period ('on'), or whose last active period is that one
 * ('on_or_after', summed into "at least k periods later" by the caller).
 * Cohorts without any return in range are absent, as they were.
 */
export function buildRetentionMatrixSql(
  input: Required<Pick<IGetRetentionCohortInput, 'projectId' | 'criteria' | 'interval' | 'startDate' | 'endDate' | 'filters'>> &
    Pick<IGetRetentionCohortInput, 'firstEvent' | 'secondEvent'>,
  diffInterval: number,
): Sql {
  const { projectId, firstEvent, secondEvent, criteria, interval, filters } = input;
  const period = PERIOD[interval];

  // Hybrid source: the rollup (skinny, fast) carries only
  // project_id/name/day/profile_id, so any filter referencing event
  // properties or columns forces a fallback to the raw events table. Cohort
  // membership filters only need profile_id, so they stay on the fast path.
  const needRawEvents = filters.some(
    (filter) =>
      filter.operator !== 'inCohort' && filter.operator !== 'notInCohort'
  );
  const source = needRawEvents
    ? eventsSource(projectId, filters)
    : rollupSource(projectId, filters);

  const start = sql`${utc(input.startDate)}::timestamp`;
  const end = sql`${utc(input.endDate)}::timestamp`;
  const returnsEnd = sql`(${end} + ${intervalOf(diffInterval, period)})`;
  const periodOfReturn = periodsBetween(
    raw('c.cohort_interval'),
    periodStart(raw('r.event_date'), period),
    period,
  );

  const perProfile =
    criteria === 'on'
      ? sql`SELECT DISTINCT cohort_interval, profile_id, period FROM matrix`
      : sql`SELECT cohort_interval, profile_id, max(period) AS period FROM matrix GROUP BY cohort_interval, profile_id`;

  return sql`
    WITH cohort_users AS (
      SELECT src.profile_id, ${periodStart(sql`min(${source.day})`, period)} AS cohort_interval
      FROM ${source.table}
      WHERE ${and([
        source.where,
        eventNameWhere(raw('src.name'), firstEvent),
        source.since(start),
        source.until(end),
      ])}
      GROUP BY src.profile_id
    ),
    returns AS (
      SELECT DISTINCT src.profile_id, ${source.day} AS event_date
      FROM ${source.table}
      WHERE ${and([
        source.where,
        eventNameWhere(raw('src.name'), secondEvent),
        source.since(start),
        source.until(returnsEnd),
      ])}
    ),
    matrix AS (
      SELECT cohort_interval, profile_id, period
      FROM (
        SELECT c.cohort_interval, c.profile_id, ${periodOfReturn} AS period
        FROM cohort_users AS c
        INNER JOIN returns AS r ON r.profile_id = c.profile_id
        WHERE r.event_date >= c.cohort_interval
      ) AS returned
      WHERE period <= ${diffInterval}
    ),
    cells AS (
      SELECT cohort_interval, period, count(*) AS users
      FROM (${perProfile}) AS per_profile
      GROUP BY cohort_interval, period
    ),
    cohort_sizes AS (
      SELECT cohort_interval, count(*) AS size
      FROM cohort_users
      GROUP BY cohort_interval
    )
    SELECT
      to_char(cells.cohort_interval, 'YYYY-MM-DD') AS cohort_interval,
      cohort_sizes.size AS total_first_event_count,
      cells.period,
      cells.users
    FROM cells
    INNER JOIN cohort_sizes ON cohort_sizes.cohort_interval = cells.cohort_interval
    ORDER BY cells.cohort_interval ASC, cells.period ASC
  `;
}

interface CohortRow {
  cohort_interval: string;
  total_first_event_count: number;
  [key: string]: number | string;
}

/** Matrix cells → the `interval_<k>_user_count` rows processCohortData reads. */
function toCohortRows(
  cells: {
    cohort_interval: string;
    total_first_event_count: number;
    period: number;
    users: number;
  }[],
  diffInterval: number,
  criteria: IRetentionCriteria,
): CohortRow[] {
  const cohorts = new Map<string, { size: number; users: number[] }>();
  for (const cell of cells) {
    let cohort = cohorts.get(cell.cohort_interval);
    if (!cohort) {
      cohort = {
        size: cell.total_first_event_count,
        users: new Array<number>(diffInterval + 1).fill(0),
      };
      cohorts.set(cell.cohort_interval, cohort);
    }
    cohort.users[cell.period] = cell.users;
  }

  const rows: CohortRow[] = [];
  for (const [cohortInterval, cohort] of cohorts) {
    const row: CohortRow = {
      cohort_interval: cohortInterval,
      total_first_event_count: cohort.size,
    };
    // 'on_or_after': active k or more periods later = the profiles whose
    // last active period is k or later.
    let atLeast = 0;
    for (let index = diffInterval; index >= 0; index--) {
      atLeast += cohort.users[index]!;
      row[`interval_${index}_user_count`] =
        criteria === 'on' ? cohort.users[index]! : atLeast;
    }
    rows.push(row);
  }
  return rows;
}

export async function getRetentionCohort(input: IGetRetentionCohortInput) {
  const {
    projectId,
    firstEvent,
    secondEvent,
    criteria = 'on_or_after',
    interval = 'day',
    startDate,
    endDate,
    filters = [],
  } = input;

  const diffInterval = diffIntervalCount(startDate, endDate, interval);
  if (!Number.isFinite(diffInterval)) {
    // A bound that isn't a date: ClickHouse failed the query.
    return [];
  }

  const cells = await anQuery<{
    cohort_interval: string;
    total_first_event_count: number;
    period: number;
    users: number;
  }>(
    buildRetentionMatrixSql(
      {
        projectId,
        firstEvent,
        secondEvent,
        criteria,
        interval,
        startDate,
        endDate,
        filters,
      },
      diffInterval,
    ),
  );

  // Reference point for cohort maturity: we only have return data up to "now",
  // so periods that haven't elapsed yet are excluded from the weighted average.
  const until = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss');
  return processCohortData(
    toCohortRows(cells, diffInterval, criteria),
    diffInterval,
    interval,
    until,
  );
}

// Number of fully-elapsed periods between a cohort's start and the reference
// date. Periods beyond this haven't happened yet, so they carry no return data
// and must be excluded from the average. Fails open (treats everything as
// mature) when dates are missing/unparseable.
function maturePeriodCount(
  cohortInterval: string,
  until: string | undefined,
  interval: IRetentionInterval
): number {
  if (!until) {
    return Number.POSITIVE_INFINITY;
  }
  const unit = LUXON_UNIT[interval];
  const cohort = DateTime.fromFormat(cohortInterval.slice(0, 10), 'yyyy-MM-dd', {
    zone: 'utc',
  });
  const ref = DateTime.fromFormat(until, 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' });
  if (!cohort.isValid || !ref.isValid) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor(ref.diff(cohort, unit).as(unit));
}

// Shapes the raw retention matrix into per-cohort rows + a leading weighted-
// average row.
//
// The average is a maturity-aware pooled rate: for each period column it pools
// only the cohorts old enough to have actually reached that period
// (cohort_interval + N intervals <= `until`). This keeps not-yet-elapsed cells
// from being read as churn AND keeps genuine zeros in, so the late curve is not
// inflated. Counts are normalised to the representative (mean) cohort size, so
// the row is internally consistent: period 0 equals Total profiles and the
// curve starts at 100%.
export function processCohortData(
  data: Array<{
    cohort_interval: string;
    total_first_event_count: number;
    [key: string]: number | string;
  }>,
  diffInterval: number,
  interval: IRetentionInterval = 'day',
  until?: string
): IRetentionCohortRow[] {
  if (data.length === 0) {
    return [];
  }

  const columns = range(0, diffInterval + 1);
  const processed = data.map((row) => {
    const sum = row.total_first_event_count;
    const values = columns.map(
      (index) => (row[`interval_${index}_user_count`] || 0) as number
    );

    return {
      cohort_interval: row.cohort_interval,
      sum,
      values,
      percentages: values.map((value) => (sum > 0 ? round(value / sum, 2) : 0)),
    };
  });

  const maturePeriods = processed.map((row) =>
    maturePeriodCount(row.cohort_interval, until, interval)
  );
  const totalSize = processed.reduce((acc, row) => acc + row.sum, 0);
  const representativeSize = round(totalSize / processed.length, 0);

  const averageRow: IRetentionCohortRow = {
    cohort_interval: 'Weighted Average',
    sum: representativeSize,
    values: [],
    percentages: [],
  };

  for (const index of columns) {
    let matureSize = 0;
    let retained = 0;
    processed.forEach((row, i) => {
      if (index <= maturePeriods[i]!) {
        matureSize += row.sum;
        retained += row.values[index]!;
      }
    });
    const rate = matureSize > 0 ? retained / matureSize : 0;
    averageRow.percentages.push(round(rate, 2));
    averageRow.values.push(round(rate * representativeSize, 0));
  }

  return [averageRow, ...processed];
}
