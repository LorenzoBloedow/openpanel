import { average, sum } from '@openpanel/common';
import { chartColors } from '@openpanel/constants';
import {
  type IChartEventFilter,
  type IInterval,
  zTimeInterval,
} from '@openpanel/validation';
import { z } from 'zod';
import { anQuery } from '../analytics/client';
import {
  convertClickhouseDateToJs,
  isClickhouseDefaultMinDate,
} from '../analytics/dates';
import { eventFilterClauses, eventPropertyExpr } from '../analytics/filters';
import { type Sql, and, empty, raw, sql } from '../analytics/sql';
import type { TimeCtx } from '../analytics/time';
import {
  MS_TO_NEXT_VIEW,
  bucketKey,
  bucketLabel,
  bucketOf,
  chRound,
  createdBetween,
  fillBuckets,
  rollupSentinelMatches,
  withFill,
} from './overview-buckets';

/**
 * The overview queries on Postgres. They ran in the project's zone
 * (`clix(ch, timezone)`): the date range is project wall-clock time and the
 * buckets are the project's minutes/hours/days, Sunday weeks and months
 * (see overview-buckets.ts). Sessions are plain rows, so ClickHouse's
 * `sum(sign)` / `uniqIf(…, sign > 0)` are plain counts. Kept as ClickHouse
 * returned them: Float64 arithmetic and ties-to-even `round`, the NaN of an
 * empty average as null, the ROLLUP totals row (the epoch sentinel) and the
 * WITH FILL rows with their default values.
 */

/** The date the ROLLUP totals row carried (the zero DateTime). */
const ROLLUP_SENTINEL = '1970-01-01 00:00:00';

// Toggle revenue tracking in overview queries
const INCLUDE_REVENUE = true; // TODO: Make this configurable later

// Maximum number of records to return (for detail modals)
const MAX_RECORDS_LIMIT = 1000;

const COLUMN_PREFIX_MAP: Record<string, string> = {
  region: 'country',
  city: 'country',
  browser_version: 'browser',
  os_version: 'os',
};

const WHITELISTED_FILTERS = [
  'os',
  'path',
  'city',
  'brand',
  'model',
  'origin',
  'region',
  'device',
  'revenue',
  'country',
  'browser',
  'referrer',
  'os_version',
  'referrer_name',
  'browser_version',
  'referrer_type',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
];

// Columns that exist on the sessions table but not on events — on events
// they're stored inside the properties map under __query.utm_*.
const UTM_COLUMNS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
];

// Types
type MetricsRow = {
  bounce_rate: number;
  unique_visitors: number;
  total_sessions: number;
  avg_session_duration: number;
  total_screen_views: number;
  views_per_session: number;
};

type MetricsSeriesRow = MetricsRow & { date: string; total_revenue: number };

export const zGetMetricsInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  interval: zTimeInterval,
});

export type IGetMetricsInput = z.infer<typeof zGetMetricsInput> & {
  timezone: string;
};

export const zGetTopPagesInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  limit: z.number().min(1).max(1000).optional(),
});

export type IGetTopPagesInput = z.infer<typeof zGetTopPagesInput> & {
  timezone: string;
};

export const zGetTopEntryExitInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  mode: z.enum(['entry', 'exit']),
  limit: z.number().min(1).max(1000).optional(),
});

export type IGetTopEntryExitInput = z.infer<typeof zGetTopEntryExitInput> & {
  timezone: string;
};

export const zGetTopGenericInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  column: z.enum([
    // Referrers
    'referrer',
    'referrer_name',
    'referrer_type',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    // Geo
    'region',
    'country',
    'city',
    // Device
    'device',
    'brand',
    'model',
    'browser',
    'browser_version',
    'os',
    'os_version',
  ]),
});

export type IGetTopGenericInput = z.infer<typeof zGetTopGenericInput> & {
  timezone: string;
};

export const zGetTopGenericSeriesInput = zGetTopGenericInput.extend({
  interval: zTimeInterval,
});

export type IGetTopGenericSeriesInput = z.infer<
  typeof zGetTopGenericSeriesInput
> & {
  timezone: string;
};

export const zGetUserJourneyInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  steps: z.number().min(2).max(10).default(5),
});

export type IGetUserJourneyInput = z.infer<typeof zGetUserJourneyInput> & {
  timezone: string;
};

export const zGetTopEventsInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  excludeEvents: z.array(z.string()).optional(),
});

export type IGetTopEventsInput = z.infer<typeof zGetTopEventsInput> & {
  timezone: string;
};

export const zGetTopLinkOutInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
});

export type IGetTopLinkOutInput = z.infer<typeof zGetTopLinkOutInput> & {
  timezone: string;
};

export const zGetMapDataInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
});

export type IGetMapDataInput = z.infer<typeof zGetMapDataInput> & {
  timezone: string;
};

/** Session columns the generic breakdowns group by. */
const GENERIC_COLUMNS: ReadonlySet<string> = new Set(
  zGetTopGenericInput.shape.column.options,
);

interface RangeInput {
  projectId: string;
  filters: IChartEventFilter[];
  startDate: string;
  endDate: string;
  timezone: string;
}

interface RevenueRow {
  date: string;
  total_revenue: number;
}

/** A ROLLUP / GROUPING SETS row: `is_total` marks the totals row. */
interface BucketRow {
  is_total: boolean;
  bucket_key: string | null;
}

interface SessionMetricsRow extends BucketRow {
  date: string | null;
  bounce_rate: number;
  unique_visitors: number;
  total_sessions: number;
  /** NULL when no session has a duration (ClickHouse's NaN, sent as null). */
  _avg_session_duration: number | null;
  total_screen_views: number;
  views_per_session: number;
}

interface PageViewsRow extends BucketRow {
  date: string | null;
  unique_visitors: number;
  total_sessions: number;
  /** null when no view has a duration (ClickHouse's NaN, sent as null). */
  avg_session_duration: number;
  total_screen_views: number;
  views_per_session: number;
}

interface GenericRow {
  prefix?: string;
  name: string;
  sessions: number;
  pageviews: number;
  revenue?: number;
}

interface GenericSeriesRow extends Omit<GenericRow, 'name'> {
  bucket_key: string;
  date: string;
  /** null for the empty value, and on the rows WITH FILL added. */
  name: string | null;
}

const ENTRY_EXIT_COLUMNS = {
  entry: { origin: raw('s.entry_origin'), path: raw('s.entry_path') },
  exit: { origin: raw('s.exit_origin'), path: raw('s.exit_path') },
} as const;

/** A LIMIT from a caller's number. */
const limitOf = (value: number) => Math.max(0, Math.trunc(value));

/** A bucket label (or the totals sentinel) as the ISO string of the series. */
const toIsoDate = (label: string | null) =>
  convertClickhouseDateToJs(label ?? ROLLUP_SENTINEL).toISOString();

export class OverviewService {
  /** Takes (and ignores) the ClickHouse client it used to be built with. */
  // biome-ignore lint/complexity/noUselessConstructor: callers still pass the client
  constructor(_client?: unknown) {
    // Nothing to keep: the queries use the analytics pool.
  }

  private async getRevenue({
    projectId,
    startDate,
    endDate,
    interval,
    timezone,
    filters,
  }: RangeInput & { interval: IInterval }): Promise<RevenueRow[]> {
    const ctx: TimeCtx = { timezone };
    const rows = await anQuery<{ date: string; total_revenue: number }>(sql`
      SELECT
        CASE WHEN GROUPING(r.bucket) = 1 THEN ${ROLLUP_SENTINEL}::text
          ELSE ${bucketLabel(raw('r.bucket'), interval, ctx)} END AS date,
        COALESCE(sum(r.revenue), 0) AS total_revenue
      FROM (
        SELECT ${bucketOf(raw('e.created_at'), interval, ctx)} AS bucket, e.revenue
        FROM analytics.events e
        WHERE ${and([
          sql`e.project_id = ${projectId}`,
          sql`e.name = 'revenue'`,
          sql`e.revenue > 0`,
          createdBetween(raw('e.created_at'), { startDate, endDate }, ctx),
          this.getRawWhereClause('events', filters, { alias: 'e', timezone }),
        ])}
      ) r
      GROUP BY ROLLUP (r.bucket)
    `);
    return rows.map((row) => ({
      date: toIsoDate(row.date),
      total_revenue: row.total_revenue,
    }));
  }

  private mergeRevenueIntoSeries<T extends { date: string }>(
    series: T[],
    revenueData: { date: string; total_revenue: number }[]
  ): (T & { total_revenue: number })[] {
    const revenueByDate = new Map(
      revenueData
        .filter((r) => !isClickhouseDefaultMinDate(r.date))
        .map((r) => [r.date, r.total_revenue])
    );
    return series.map((row) => ({
      ...row,
      total_revenue: revenueByDate.get(row.date) ?? 0,
    }));
  }

  private getOverallRevenue(
    revenueData: { date: string; total_revenue: number }[]
  ): number {
    return (
      revenueData.find((r) => isClickhouseDefaultMinDate(r.date))
        ?.total_revenue ?? 0
    );
  }

  /**
   * Sessions (alias `s`) that have an event matching the events filters in
   * the range — the `distinct_sessions` restriction of a page filter.
   */
  private inDistinctSessions(params: RangeInput): Sql {
    const ctx: TimeCtx = { timezone: params.timezone };
    return sql`s.id IN (SELECT e.session_id FROM analytics.events e WHERE ${and([
      sql`e.project_id = ${params.projectId}`,
      createdBetween(raw('e.created_at'), params, ctx),
      this.getRawWhereClause('events', params.filters, {
        alias: 'e',
        timezone: params.timezone,
      }),
    ])})`;
  }

  /**
   * The filter of a sessions query (alias `s`): the sessions filters, or,
   * with a page filter, the sessions of the matching events instead
   * (`withDistinctSessionsIfNeeded`).
   */
  private sessionsScope(params: RangeInput): Sql {
    if (!this.isPageFilter(params.filters)) {
      return this.getRawWhereClause('sessions', params.filters, {
        alias: 's',
        timezone: params.timezone,
      });
    }
    return this.inDistinctSessions(params);
  }

  isPageFilter(filters: IChartEventFilter[]) {
    return filters.some((filter) => filter.name === 'path' && filter.value);
  }

  async getMetrics({
    projectId,
    filters,
    startDate,
    endDate,
    interval,
    timezone,
  }: IGetMetricsInput): Promise<{
    metrics: {
      bounce_rate: number;
      unique_visitors: number;
      total_sessions: number;
      avg_session_duration: number;
      total_screen_views: number;
      views_per_session: number;
      total_revenue: number;
    };
    series: {
      date: string;
      bounce_rate: number;
      unique_visitors: number;
      total_sessions: number;
      avg_session_duration: number;
      total_screen_views: number;
      views_per_session: number;
      total_revenue: number;
    }[];
  }> {
    return this.isPageFilter(filters)
      ? this.getMetricsWithPageFilter({
          projectId,
          filters,
          startDate,
          endDate,
          interval,
          timezone,
        })
      : this.getMetricsFromSessions({
          projectId,
          filters,
          startDate,
          endDate,
          interval,
          timezone,
        });
  }

  private async getMetricsFromSessions({
    projectId,
    filters,
    startDate,
    endDate,
    interval,
    timezone,
  }: IGetMetricsInput): Promise<{
    metrics: MetricsRow & { total_revenue: number };
    series: MetricsSeriesRow[];
  }> {
    const ctx: TimeCtx = { timezone };

    // Per bucket plus the ROLLUP totals row.
    const sessionQuery = anQuery<SessionMetricsRow>(sql`
      SELECT
        GROUPING(b.bucket) = 1 AS is_total,
        ${bucketKey(raw('b.bucket'), interval)} AS bucket_key,
        ${bucketLabel(raw('b.bucket'), interval, ctx)} AS date,
        ${chRound(sql`(count(*) FILTER (WHERE b.is_bounce))::double precision * 100 / NULLIF(count(*), 0)`, 2)} AS bounce_rate,
        count(DISTINCT b.profile_id) AS unique_visitors,
        count(*) AS total_sessions,
        ${chRound(sql`avg(b.duration::double precision) FILTER (WHERE b.duration > 0)`, 2)} / 1000 AS _avg_session_duration,
        sum(b.screen_view_count) AS total_screen_views,
        ${chRound(sql`sum(b.screen_view_count)::double precision / NULLIF(count(*), 0)`, 2)} AS views_per_session
      FROM (
        SELECT
          ${bucketOf(raw('s.created_at'), interval, ctx)} AS bucket,
          s.is_bounce,
          s.profile_id,
          s.duration,
          s.screen_view_count
        FROM analytics.sessions s
        WHERE ${and([
          sql`s.project_id = ${projectId}`,
          createdBetween(raw('s.created_at'), { startDate, endDate }, ctx),
          this.getRawWhereClause('sessions', filters, { alias: 's', timezone }),
        ])}
      ) b
      GROUP BY ROLLUP (b.bucket)
      HAVING count(*) > 0
      ORDER BY bucket_key NULLS FIRST
    `);

    // Revenue query
    const revenueQuery = this.getRevenue({
      projectId,
      startDate,
      endDate,
      interval,
      timezone,
      filters,
    });

    // Execute both queries in parallel and merge results
    const [sessionRows, revenueRes] = await Promise.all([
      sessionQuery,
      revenueQuery,
    ]);

    // The totals row sorted first (the epoch), then the filled buckets.
    // Without sessions there is no totals row and the first filled bucket
    // stands in for it, as it did.
    const buckets = withFill(
      sessionRows.filter((row) => !row.is_total),
      (row) => row.bucket_key ?? '',
      fillBuckets(interval, startDate, endDate, timezone),
      (bucket): SessionMetricsRow => ({
        is_total: false,
        bucket_key: bucket.key,
        date: bucket.label,
        bounce_rate: 0,
        unique_visitors: 0,
        total_sessions: 0,
        _avg_session_duration: 0,
        total_screen_views: 0,
        views_per_session: 0,
      }),
    );
    const sessionRes = [
      ...sessionRows.filter((row) => row.is_total),
      ...buckets,
    ].map((row) => ({
      date: toIsoDate(row.date),
      bounce_rate: row.bounce_rate,
      unique_visitors: row.unique_visitors,
      total_sessions: row.total_sessions,
      _avg_session_duration: row._avg_session_duration,
      avg_session_duration: row._avg_session_duration ?? 0,
      total_screen_views: row.total_screen_views,
      views_per_session: row.views_per_session,
    }));

    const overallRevenue = this.getOverallRevenue(revenueRes);
    const series = this.mergeRevenueIntoSeries(sessionRes.slice(1), revenueRes);

    return {
      metrics: {
        bounce_rate: sessionRes[0]?.bounce_rate ?? 0,
        unique_visitors: sessionRes[0]?.unique_visitors ?? 0,
        total_sessions: sessionRes[0]?.total_sessions ?? 0,
        avg_session_duration: sessionRes[0]?.avg_session_duration ?? 0,
        total_screen_views: sessionRes[0]?.total_screen_views ?? 0,
        views_per_session: sessionRes[0]?.views_per_session ?? 0,
        total_revenue: overallRevenue,
      },
      series,
    };
  }

  private async getMetricsWithPageFilter({
    projectId,
    filters,
    startDate,
    endDate,
    interval,
    timezone,
  }: IGetMetricsInput): Promise<{
    metrics: MetricsRow & { total_revenue: number };
    series: MetricsSeriesRow[];
  }> {
    const ctx: TimeCtx = { timezone };
    const range = { startDate, endDate };

    // Matching screen views per bucket plus the totals row. A view lasts
    // until the session's next matching view.
    const viewsQuery = anQuery<PageViewsRow>(sql`
      SELECT
        GROUPING(v.bucket) = 1 AS is_total,
        ${bucketKey(raw('v.bucket'), interval)} AS bucket_key,
        ${bucketLabel(raw('v.bucket'), interval, ctx)} AS date,
        count(DISTINCT v.profile_id) AS unique_visitors,
        count(DISTINCT v.session_id) AS total_sessions,
        ${chRound(sql`avg(v.duration::double precision) FILTER (WHERE v.duration > 0)`, 2)} / 1000 AS avg_session_duration,
        count(*) AS total_screen_views,
        ${chRound(sql`count(*)::double precision / NULLIF(count(DISTINCT v.session_id), 0)`, 2)} AS views_per_session
      FROM (
        SELECT
          ${bucketOf(raw('e.created_at'), interval, ctx)} AS bucket,
          e.profile_id,
          e.session_id,
          ${MS_TO_NEXT_VIEW} AS duration
        FROM analytics.events e
        WHERE ${and([
          sql`e.project_id = ${projectId}`,
          sql`e.name = 'screen_view'`,
          createdBetween(raw('e.created_at'), range, ctx),
          this.getRawWhereClause('events', filters, { alias: 'e', timezone }),
        ])}
      ) v
      GROUP BY GROUPING SETS ((v.bucket), ())
      ORDER BY bucket_key NULLS FIRST
    `);

    // Bounce rate of the sessions per bucket, with the ROLLUP totals row.
    const sessionAggQuery = anQuery<BucketRow & { bounce_rate: number }>(sql`
      SELECT
        GROUPING(b.bucket) = 1 AS is_total,
        ${bucketKey(raw('b.bucket'), interval)} AS bucket_key,
        ${chRound(sql`(count(*) FILTER (WHERE b.is_bounce))::double precision * 100 / NULLIF(count(*), 0)`, 2)} AS bounce_rate
      FROM (
        SELECT ${bucketOf(raw('s.created_at'), interval, ctx)} AS bucket, s.is_bounce
        FROM analytics.sessions s
        WHERE ${and([
          sql`s.project_id = ${projectId}`,
          createdBetween(raw('s.created_at'), range, ctx),
          this.getRawWhereClause('sessions', filters, { alias: 's', timezone }),
        ])}
      ) b
      GROUP BY ROLLUP (b.bucket)
      HAVING count(*) > 0
    `);

    // Revenue query
    const revenueQuery = this.getRevenue({
      projectId,
      startDate,
      endDate,
      interval,
      timezone,
      filters,
    });

    // Execute the queries in parallel and merge results
    const [viewRows, sessionAggRows, revenueRes] = await Promise.all([
      viewsQuery,
      sessionAggQuery,
      revenueQuery,
    ]);

    const overall = viewRows.find((row) => row.is_total);
    const bounceRateByBucket = new Map(
      sessionAggRows
        .filter((row) => !row.is_total)
        .map((row) => [row.bucket_key, row.bounce_rate]),
    );
    // `WHERE date = '1970-01-01 00:00:00'` on the ROLLUP output: the totals
    // row, or nothing (NULL) in zones west of UTC.
    const overallBounceRate = rollupSentinelMatches(interval, timezone)
      ? (sessionAggRows.find((row) => row.is_total)?.bounce_rate ?? null)
      : null;

    interface MainRow {
      key: string;
      date: string;
      bounce_rate: number;
      unique_visitors: number;
      total_sessions: number;
      avg_session_duration: number;
      total_screen_views: number;
      views_per_session: number;
      overall_unique_visitors: number | null;
      overall_total_sessions: number | null;
      overall_bounce_rate: number | null;
    }

    const mainRes = withFill(
      viewRows
        .filter((row) => !row.is_total)
        .map(
          (row): MainRow => ({
            key: row.bucket_key ?? '',
            date: row.date ?? ROLLUP_SENTINEL,
            // A bucket without sessions joined no row: the default 0.
            bounce_rate: bounceRateByBucket.get(row.bucket_key) ?? 0,
            unique_visitors: row.unique_visitors,
            total_sessions: row.total_sessions,
            avg_session_duration: row.avg_session_duration,
            total_screen_views: row.total_screen_views,
            views_per_session: row.views_per_session,
            overall_unique_visitors: overall?.unique_visitors ?? null,
            overall_total_sessions: overall?.total_sessions ?? null,
            overall_bounce_rate: overallBounceRate,
          }),
        ),
      (row) => row.key,
      fillBuckets(interval, startDate, endDate, timezone),
      (bucket): MainRow => ({
        key: bucket.key,
        date: bucket.label,
        bounce_rate: 0,
        unique_visitors: 0,
        total_sessions: 0,
        avg_session_duration: 0,
        total_screen_views: 0,
        views_per_session: 0,
        overall_unique_visitors: null,
        overall_total_sessions: null,
        overall_bounce_rate: null,
      }),
    ).map(({ key: _key, date, ...row }) => ({ ...row, date: toIsoDate(date) }));

    const overallRevenue = this.getOverallRevenue(revenueRes);
    const series = this.mergeRevenueIntoSeries(mainRes, revenueRes);

    const anyRowWithData = mainRes.find(
      (item) =>
        item.overall_bounce_rate !== null ||
        item.overall_total_sessions !== null ||
        item.overall_unique_visitors !== null
    );

    return {
      metrics: {
        bounce_rate: anyRowWithData?.overall_bounce_rate ?? 0,
        unique_visitors: anyRowWithData?.overall_unique_visitors ?? 0,
        total_sessions: anyRowWithData?.overall_total_sessions ?? 0,
        avg_session_duration: average(
          mainRes.map((item) => item.avg_session_duration)
        ),
        total_screen_views: sum(mainRes.map((item) => item.total_screen_views)),
        views_per_session: average(
          mainRes.map((item) => item.views_per_session)
        ),
        total_revenue: overallRevenue,
      },
      series,
    };
  }

  /**
   * The filters of an overview query as a WHERE fragment on the events or
   * the sessions table (empty when none applies): only the whitelisted
   * columns, `path` / `origin` as the session's entry page, the UTM columns
   * as the events' `__query.utm_*` properties. `alias` qualifies the
   * columns; `timezone` is the zone typed date filters read dates in.
   */
  getRawWhereClause(
    type: 'events' | 'sessions',
    filters: IChartEventFilter[],
    options: { alias?: string; timezone?: string } = {},
  ): Sql {
    const clauses = eventFilterClauses(
      filters.flatMap((item) => {
        if (!WHITELISTED_FILTERS.includes(item.name)) {
          return []
        }
        // Built without a project id, the ClickHouse clause never applied
        // cohort operators.
        if (item.operator === 'inCohort' || item.operator === 'notInCohort') {
          return [];
        }
        if (type === 'sessions') {
          if (item.name === 'path') {
            return [{ ...item, name: 'entry_path' }];
          }
          if (item.name === 'origin') {
            return [{ ...item, name: 'entry_origin' }];
          }
          return [item];
        }
        // events table has no top-level utm_* columns — those live in the
        // properties map under the __query.utm_* keys.
        if (UTM_COLUMNS.includes(item.name)) {
          return [{ ...item, name: `properties.__query.${item.name}` }];
        }
        return [item];
      }),
      {
        // Whitelisted columns never read the project (no cohort, group or
        // profile names).
        projectId: '',
        timezone: options.timezone ?? 'UTC',
        alias: options.alias,
        table: type,
      },
    );

    return clauses.length > 0 ? and(clauses) : empty;
  }

  async getTopPages({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
    limit,
  }: IGetTopPagesInput) {
    const ctx: TimeCtx = { timezone };
    return anQuery<{
      origin: string;
      path: string;
      sessions: number;
      pageviews: number;
      revenue?: number;
    }>(sql`
      SELECT
        e.origin,
        e.path,
        count(DISTINCT e.session_id) AS sessions,
        count(*) AS pageviews
        ${INCLUDE_REVENUE ? sql`, sum(e.revenue) AS revenue` : empty}
      FROM analytics.events e
      WHERE ${and([
        sql`e.project_id = ${projectId}`,
        sql`e.name = 'screen_view'`,
        sql`e.path <> ''`,
        createdBetween(raw('e.created_at'), { startDate, endDate }, ctx),
        this.getRawWhereClause('events', filters, { alias: 'e', timezone }),
      ])}
      GROUP BY e.origin, e.path
      ORDER BY sessions DESC, e.origin, e.path
      LIMIT ${limitOf(Math.min(limit ?? MAX_RECORDS_LIMIT, MAX_RECORDS_LIMIT))}
    `);
  }

  async getTopEntryExit({
    projectId,
    filters,
    startDate,
    endDate,
    mode,
    timezone,
    limit,
  }: IGetTopEntryExitInput) {
    if (!Object.hasOwn(ENTRY_EXIT_COLUMNS, mode)) {
      return [];
    }
    const ctx: TimeCtx = { timezone };
    const columns = ENTRY_EXIT_COLUMNS[mode];
    const params = { projectId, filters, startDate, endDate, timezone };

    return anQuery<{
      origin: string;
      path: string;
      sessions: number;
      pageviews: number;
      revenue?: number;
    }>(sql`
      SELECT
        ${columns.origin} AS origin,
        ${columns.path} AS path,
        count(*) AS sessions,
        sum(s.screen_view_count) AS pageviews
        ${INCLUDE_REVENUE ? sql`, sum(s.revenue) AS revenue` : empty}
      FROM analytics.sessions s
      WHERE ${and([
        sql`s.project_id = ${projectId}`,
        createdBetween(raw('s.created_at'), params, ctx),
        this.sessionsScope(params),
      ])}
      GROUP BY ${columns.origin}, ${columns.path}
      ORDER BY sessions DESC, origin, path
      LIMIT ${limitOf(Math.min(limit ?? MAX_RECORDS_LIMIT, MAX_RECORDS_LIMIT))}
    `);
  }

  /** Sessions per value of a sessions column (and its prefix column). */
  private getGenericItems(
    params: RangeInput & { column: string; limit: number },
  ): Promise<GenericRow[]> {
    const ctx: TimeCtx = { timezone: params.timezone };
    const prefixColumn = COLUMN_PREFIX_MAP[params.column] ?? null;
    const column = raw(`s.${params.column}`);
    const prefix = prefixColumn ? raw(`s.${prefixColumn}`) : null;

    return anQuery<GenericRow>(sql`
      SELECT
        ${prefix ? sql`${prefix} AS prefix,` : empty}
        NULLIF(${column}, '') AS name,
        count(*) AS sessions,
        sum(s.screen_view_count) AS pageviews
        ${INCLUDE_REVENUE ? sql`, sum(s.revenue) AS revenue` : empty}
      FROM analytics.sessions s
      WHERE ${and([
        sql`s.project_id = ${params.projectId}`,
        createdBetween(raw('s.created_at'), params, ctx),
        this.sessionsScope(params),
      ])}
      GROUP BY ${prefix ? sql`${prefix}, ` : empty}${column}
      ORDER BY sessions DESC, ${prefix ? sql`${prefix}, ` : empty}${column}
      LIMIT ${limitOf(params.limit)}
    `);
  }

  async getTopGeneric({
    projectId,
    filters,
    startDate,
    endDate,
    column,
    timezone,
  }: IGetTopGenericInput) {
    if (!(WHITELISTED_FILTERS.includes(column) && GENERIC_COLUMNS.has(column))) {
      return [];
    }

    return this.getGenericItems({
      projectId,
      filters,
      startDate,
      endDate,
      timezone,
      column,
      limit: MAX_RECORDS_LIMIT,
    });
  }

  async getTopGenericSeries({
    projectId,
    filters,
    startDate,
    endDate,
    column,
    interval,
    timezone,
  }: IGetTopGenericSeriesInput): Promise<{
    items: Array<{
      name: string;
      prefix?: string;
      data: Array<{
        date: string;
        sessions: number;
        pageviews: number;
        revenue?: number;
      }>;
      total: { sessions: number; pageviews: number; revenue?: number };
    }>;
  }> {
    if (!GENERIC_COLUMNS.has(column)) {
      return { items: [] };
    }
    const prefixColumn = COLUMN_PREFIX_MAP[column] ?? null;
    const TOP_LIMIT = 500;
    const ctx: TimeCtx = { timezone };
    const params = { projectId, filters, startDate, endDate, timezone };

    // Step 1: Get top items
    const topItems = await this.getGenericItems({
      ...params,
      column,
      limit: TOP_LIMIT,
    });

    if (topItems.length === 0) {
      return { items: [] };
    }

    // Step 2: Build time-series query for each top item. It always applied
    // the sessions filters, and with a page filter also the matching
    // sessions.
    const prefix = prefixColumn ? raw(`s.${prefixColumn}`) : null;
    const rows = await anQuery<GenericSeriesRow>(sql`
      SELECT
        ${bucketKey(raw('b.bucket'), interval)} AS bucket_key,
        ${bucketLabel(raw('b.bucket'), interval, ctx)} AS date,
        ${prefix ? sql`b.prefix,` : empty}
        NULLIF(b.value, '') AS name,
        count(*) AS sessions,
        sum(b.screen_view_count) AS pageviews
        ${INCLUDE_REVENUE ? sql`, sum(b.revenue) AS revenue` : empty}
      FROM (
        SELECT
          ${bucketOf(raw('s.created_at'), interval, ctx)} AS bucket,
          ${prefix ? sql`${prefix} AS prefix,` : empty}
          ${raw(`s.${column}`)} AS value,
          s.screen_view_count,
          s.revenue
        FROM analytics.sessions s
        WHERE ${and([
          sql`s.project_id = ${projectId}`,
          createdBetween(raw('s.created_at'), params, ctx),
          this.getRawWhereClause('sessions', filters, { alias: 's', timezone }),
          this.isPageFilter(filters) ? this.inDistinctSessions(params) : empty,
        ])}
      ) b
      GROUP BY b.bucket, ${prefix ? sql`b.prefix, ` : empty}b.value
      ORDER BY bucket_key
    `);

    // WITH FILL rows carry the column defaults: no name, prefix ''.
    const timeSeriesData = withFill(
      rows,
      (row) => row.bucket_key,
      fillBuckets(interval, startDate, endDate, timezone),
      (bucket): GenericSeriesRow => ({
        bucket_key: bucket.key,
        date: bucket.label,
        ...(prefixColumn ? { prefix: '' } : {}),
        name: null,
        sessions: 0,
        pageviews: 0,
        ...(INCLUDE_REVENUE ? { revenue: 0 } : {}),
      }),
    ).map(({ bucket_key: _key, ...row }) => ({
      ...row,
      date: toIsoDate(row.date),
    }));

    // Step 3: Group time-series data by item and calculate totals
    const itemsMap = new Map<
      string,
      {
        name: string;
        prefix?: string;
        data: Array<{
          date: string;
          sessions: number;
          pageviews: number;
          revenue?: number;
        }>;
        total: { sessions: number; pageviews: number; revenue?: number };
      }
    >();

    // Initialize items from topItems
    for (const item of topItems) {
      const key = `${item.prefix || ''}:${item.name}`;
      itemsMap.set(key, {
        name: item.name,
        prefix: item.prefix,
        data: [],
        total: {
          sessions: item.sessions,
          pageviews: item.pageviews,
          revenue: item.revenue ?? 0,
        },
      });
    }

    // Populate time-series data
    for (const row of timeSeriesData) {
      const key = `${row.prefix || ''}:${row.name}`;
      const item = itemsMap.get(key);
      if (item) {
        item.data.push({
          date: row.date,
          sessions: row.sessions,
          pageviews: row.pageviews,
          revenue: row.revenue,
        });
      }
    }

    return {
      items: Array.from(itemsMap.values()),
    };
  }

  async getUserJourney({
    projectId,
    filters,
    startDate,
    endDate,
    steps = 5,
    timezone,
  }: IGetUserJourneyInput): Promise<{
    nodes: Array<{
      id: string;
      label: string;
      nodeColor: string;
      percentage?: number;
      value?: number;
      step?: number;
    }>;
    links: Array<{ source: string; target: string; value: number }>;
  }> {
    // Config
    const TOP_ENTRIES = 3; // Only show top 3 entry pages
    const TOP_DESTINATIONS_PER_NODE = 3; // Top 3 destinations from each node

    // Color palette - each entry page gets a consistent color
    const COLORS = chartColors.map((color) => color.main);

    const ctx: TimeCtx = { timezone };

    // Steps 1–3 in one query: each session's path (consecutive repeats
    // collapsed, the first `steps` pages, cut before the first page seen
    // twice, at least two pages), the top entry pages, and the transitions
    // of the sessions that start on one of them.
    const rows = await anQuery<{
      kind: 'entry' | 'link';
      source: string;
      target: string | null;
      step: number | null;
      value: number;
    }>(sql`
      WITH views AS (
        SELECT
          e.session_id,
          e.origin || e.path AS page,
          lag(e.origin || e.path) OVER (PARTITION BY e.session_id ORDER BY e.created_at, e.id) AS previous_page,
          row_number() OVER (PARTITION BY e.session_id ORDER BY e.created_at, e.id) AS seq
        FROM analytics.events e
        WHERE ${and([
          sql`e.project_id = ${projectId}`,
          sql`e.name = 'screen_view'`,
          sql`e.path <> ''`,
          createdBetween(raw('e.created_at'), { startDate, endDate }, ctx),
          this.getRawWhereClause('events', filters, { alias: 'e', timezone }),
        ])}
      ),
      deduped AS (
        SELECT
          session_id,
          page,
          row_number() OVER (PARTITION BY session_id ORDER BY seq) AS pos
        FROM views
        WHERE previous_page IS NULL OR previous_page <> page
      ),
      firsts AS (
        SELECT
          session_id,
          page,
          pos,
          min(pos) OVER (PARTITION BY session_id, page) AS first_pos
        FROM deduped
        WHERE pos <= ${steps}
      ),
      repeats AS (
        SELECT
          session_id,
          page,
          pos,
          min(pos) FILTER (WHERE pos > first_pos) OVER (PARTITION BY session_id) AS repeat_pos
        FROM firsts
      ),
      paths AS (
        SELECT
          session_id,
          page,
          pos,
          count(*) OVER (PARTITION BY session_id) AS length
        FROM repeats
        WHERE repeat_pos IS NULL OR pos < repeat_pos
      ),
      entries AS (
        SELECT session_id, page AS entry_page
        FROM paths
        WHERE pos = 1 AND length >= 2
      ),
      top_entries AS (
        SELECT entry_page, count(*) AS count
        FROM entries
        GROUP BY entry_page
        ORDER BY count DESC, entry_page
        LIMIT ${TOP_ENTRIES}
      ),
      links AS (
        SELECT
          p.page AS source,
          lead(p.page) OVER (PARTITION BY p.session_id ORDER BY p.pos) AS target,
          p.pos AS step
        FROM paths p
        JOIN entries en ON en.session_id = p.session_id
        JOIN top_entries t ON t.entry_page = en.entry_page
      )
      SELECT 'entry' AS kind, entry_page AS source, NULL::text AS target, NULL::bigint AS step, count AS value
      FROM top_entries
      UNION ALL
      SELECT 'link' AS kind, source, target, step, count(*) AS value
      FROM links
      WHERE target IS NOT NULL
      GROUP BY source, target, step
      ORDER BY kind, step NULLS FIRST, value DESC, source, target
    `);

    const topEntries = rows
      .filter((row) => row.kind === 'entry')
      .map((row) => ({ entry_page: row.source, count: row.value }));

    if (topEntries.length === 0) {
      return { nodes: [], links: [] };
    }

    const totalSessions = topEntries.reduce((sum, e) => sum + e.count, 0);

    const transitions = rows
      .filter((row) => row.kind === 'link')
      .map((row) => ({
        source: row.source,
        target: row.target ?? '',
        step: row.step ?? 0,
        value: row.value,
      }));

    if (transitions.length === 0) {
      return { nodes: [], links: [] };
    }

    // Step 4: Build the sankey progressively step by step
    // Start with entry nodes, then follow top destinations at each step
    // Use unique node IDs by combining path with step to prevent circular references
    const nodes = new Map<
      string,
      { path: string; value: number; step: number; color: string }
    >();
    const links: Array<{ source: string; target: string; value: number }> = [];

    // Helper to create unique node ID
    const getNodeId = (path: string, step: number) => `${path}::step${step}`;

    // Group transitions by step
    const transitionsByStep = new Map<number, typeof transitions>();
    for (const t of transitions) {
      if (!transitionsByStep.has(t.step)) {
        transitionsByStep.set(t.step, []);
      }
      transitionsByStep.get(t.step)!.push(t);
    }

    // Initialize with entry pages (step 1)
    const activeNodes = new Map<string, string>(); // path -> nodeId
    topEntries.forEach((entry, idx) => {
      const nodeId = getNodeId(entry.entry_page, 1);
      nodes.set(nodeId, {
        path: entry.entry_page,
        value: entry.count,
        step: 1,
        color: COLORS[idx % COLORS.length]!,
      });
      activeNodes.set(entry.entry_page, nodeId);
    });

    // Process each step: from active nodes, find top destinations
    for (let step = 1; step < steps; step++) {
      const stepTransitions = transitionsByStep.get(step) || [];
      const nextActiveNodes = new Map<string, string>();

      // For each currently active node, find its top destinations
      for (const [sourcePath, sourceNodeId] of activeNodes) {
        // Get transitions FROM this source path
        const fromSource = stepTransitions
          .filter((t) => t.source === sourcePath)
          .sort((a, b) => b.value - a.value)
          .slice(0, TOP_DESTINATIONS_PER_NODE);

        for (const t of fromSource) {
          // Skip self-loops
          if (t.source === t.target) {
            continue;
          }

          const targetNodeId = getNodeId(t.target, step + 1);

          // Add link using unique node IDs
          links.push({
            source: sourceNodeId,
            target: targetNodeId,
            value: t.value,
          });

          // Add/update target node
          const existing = nodes.get(targetNodeId);
          if (existing) {
            existing.value += t.value;
          } else {
            // Inherit color from source or assign new
            const sourceData = nodes.get(sourceNodeId);
            nodes.set(targetNodeId, {
              path: t.target,
              value: t.value,
              step: step + 1,
              color: sourceData?.color || COLORS[nodes.size % COLORS.length]!,
            });
          }

          nextActiveNodes.set(t.target, targetNodeId);
        }
      }

      // Update active nodes for next iteration
      activeNodes.clear();
      for (const [path, nodeId] of nextActiveNodes) {
        activeNodes.set(path, nodeId);
      }

      // Stop if no more nodes to process
      if (activeNodes.size === 0) {
        break;
      }
    }

    // Step 5: Filter links by threshold (0.25% of total sessions)
    const MIN_LINK_PERCENT = 0.25;
    const minLinkValue = Math.ceil((totalSessions * MIN_LINK_PERCENT) / 100);
    const filteredLinks = links.filter((link) => link.value >= minLinkValue);

    // Step 6: Find all nodes referenced by remaining links
    const referencedNodeIds = new Set<string>();
    filteredLinks.forEach((link) => {
      referencedNodeIds.add(link.source);
      referencedNodeIds.add(link.target);
    });

    // Step 7: Recompute node values from filtered links (sum of incoming links)
    const nodeValuesFromLinks = new Map<string, number>();
    filteredLinks.forEach((link) => {
      // Add to target node value
      const current = nodeValuesFromLinks.get(link.target) || 0;
      nodeValuesFromLinks.set(link.target, current + link.value);
    });

    // For entry nodes (step 1), only keep them if they have outgoing links after filtering
    nodes.forEach((nodeData, nodeId) => {
      if (nodeData.step === 1) {
        const hasOutgoing = filteredLinks.some((l) => l.source === nodeId);
        if (!hasOutgoing) {
          // No outgoing links, remove entry node
          referencedNodeIds.delete(nodeId);
        }
      }
    });

    // Step 8: Build final nodes array sorted by step then value
    // Only include nodes that are referenced by filtered links
    const finalNodes = Array.from(nodes.entries())
      .filter(([id]) => referencedNodeIds.has(id))
      .map(([id, data]) => {
        // Use value from links for non-entry nodes, or original value for entry nodes with outgoing links
        const value =
          data.step === 1
            ? data.value
            : nodeValuesFromLinks.get(id) || data.value;
        return {
          id,
          label: data.path, // Add label for display
          nodeColor: data.color,
          percentage: (value / totalSessions) * 100,
          value,
          step: data.step,
        };
      })
      .sort((a, b) => {
        // Sort by step first, then by value descending
        if (a.step !== b.step) {
          return a.step - b.step;
        }
        return b.value - a.value;
      });

    // Sanity check: Ensure all link endpoints exist in nodes
    const nodeIds = new Set(finalNodes.map((n) => n.id));
    const invalidLinks = filteredLinks.filter(
      (link) => !(nodeIds.has(link.source) && nodeIds.has(link.target))
    );
    if (invalidLinks.length > 0) {
      console.warn(
        `UserJourney: Found ${invalidLinks.length} links with missing nodes`
      );
      // Remove invalid links
      const validLinks = filteredLinks.filter(
        (link) => nodeIds.has(link.source) && nodeIds.has(link.target)
      );
      return {
        nodes: finalNodes,
        links: validLinks,
      };
    }

    // Sanity check: Ensure steps are monotonic (should always be true, but verify)
    const stepsValid = finalNodes.every((node, idx, arr) => {
      if (idx === 0) {
        return true;
      }
      return node.step! >= arr[idx - 1]!.step!;
    });
    if (!stepsValid) {
      console.warn('UserJourney: Steps are not monotonic');
    }

    return {
      nodes: finalNodes,
      links: filteredLinks,
    };
  }

  async getTopEvents({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
    excludeEvents = ['session_start', 'session_end', 'screen_view'],
  }: {
    projectId: string;
    filters: IChartEventFilter[];
    startDate: string;
    endDate: string;
    timezone: string;
    excludeEvents?: string[];
  }): Promise<Array<{ name: string; count: number }>> {
    const ctx: TimeCtx = { timezone };
    const excludeWhere =
      excludeEvents.length > 0
        ? sql`e.name <> ALL(${excludeEvents}::text[])`
        : empty;

    return anQuery<{ name: string; count: number }>(sql`
      SELECT e.name, count(*) AS count
      FROM analytics.events e
      WHERE ${and([
        sql`e.project_id = ${projectId}`,
        createdBetween(raw('e.created_at'), { startDate, endDate }, ctx),
        this.getRawWhereClause('events', filters, { alias: 'e', timezone }),
        excludeWhere,
      ])}
      GROUP BY e.name
      ORDER BY count DESC, e.name
      LIMIT ${MAX_RECORDS_LIMIT}
    `);
  }

  async getTopLinkOut({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
  }: {
    projectId: string;
    filters: IChartEventFilter[];
    startDate: string;
    endDate: string;
    timezone: string;
  }): Promise<Array<{ href: string; count: number }>> {
    const ctx: TimeCtx = { timezone };
    const href = eventPropertyExpr('properties.href', {
      projectId,
      timezone,
      alias: 'e',
    });

    return anQuery<{ href: string; count: number }>(sql`
      SELECT l.href, count(*) AS count
      FROM (
        SELECT ${href} AS href
        FROM analytics.events e
        WHERE ${and([
          sql`e.project_id = ${projectId}`,
          sql`e.name = 'link_out'`,
          createdBetween(raw('e.created_at'), { startDate, endDate }, ctx),
          this.getRawWhereClause('events', filters, { alias: 'e', timezone }),
        ])}
      ) l
      WHERE l.href <> ''
      GROUP BY l.href
      ORDER BY count DESC, l.href
      LIMIT ${MAX_RECORDS_LIMIT}
    `);
  }

  async getMapData({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
  }: {
    projectId: string;
    filters: IChartEventFilter[];
    startDate: string;
    endDate: string;
    timezone: string;
  }): Promise<
    Array<{
      country: string;
      region?: string;
      city?: string;
      lat: number;
      lng: number;
      count: number;
    }>
  > {
    const ctx: TimeCtx = { timezone };

    // Note: there are no built-in lat/lng for countries/regions.
    // This would typically require a lookup table or external service
    // For now, we'll return the data structure but lat/lng would need to be
    // resolved on the frontend or via a separate lookup
    const results = await anQuery<{
      country: string;
      region: string | null;
      city: string | null;
      count: number;
    }>(sql`
      SELECT
        NULLIF(e.country, '') AS country,
        NULLIF(e.region, '') AS region,
        NULLIF(e.city, '') AS city,
        count(DISTINCT e.session_id) AS count
      FROM analytics.events e
      WHERE ${and([
        sql`e.project_id = ${projectId}`,
        createdBetween(raw('e.created_at'), { startDate, endDate }, ctx),
        this.getRawWhereClause('events', filters, { alias: 'e', timezone }),
        sql`e.country <> ''`,
      ])}
      GROUP BY e.country, e.region, e.city
      ORDER BY count DESC, e.country, e.region, e.city
      LIMIT ${MAX_RECORDS_LIMIT}
    `);

    // Return with placeholder lat/lng - these should be resolved via geocoding
    // or a lookup table on the frontend/backend
    return results.map((row) => ({
      country: row.country,
      region: row.region ?? undefined,
      city: row.city ?? undefined,
      lat: 0, // Placeholder - needs geocoding
      lng: 0, // Placeholder - needs geocoding
      count: row.count,
    }));
  }
}

export const overviewService = new OverviewService();

import { getSettingsForProject } from './organization.service';

export type TrafficColumn =
  | 'referrer'
  | 'referrer_name'
  | 'referrer_type'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'country'
  | 'region'
  | 'city'
  | 'device'
  | 'browser'
  | 'os';

export async function getTrafficBreakdownCore(input: {
  projectId: string;
  startDate: string;
  endDate: string;
  column: TrafficColumn;
  filters?: IChartEventFilter[];
}) {
  const { timezone } = await getSettingsForProject(input.projectId);
  return overviewService.getTopGeneric({
    projectId: input.projectId,
    filters: input.filters ?? [],
    startDate: input.startDate,
    endDate: input.endDate,
    column: input.column,
    timezone,
  });
}

// Columns whose daily series we can derive from the sessions table. Page/entry
// insights (path/origin) live on the events table and aren't covered here — the
// caller degrades to no series for those.
const SEGMENT_SERIES_COLUMNS: ReadonlySet<string> = new Set<TrafficColumn>([
  'referrer',
  'referrer_name',
  'referrer_type',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'country',
  'region',
  'city',
  'device',
  'browser',
  'os',
]);

export interface SegmentDailyPoint {
  date: string;
  sessions: number;
  pageviews: number;
}

// Daily breakdown for a single segment value (e.g. the "Twitter" referrer),
// so the explainer can see the *shape* of a change (one-off spike vs sustained
// growth) instead of only current-vs-baseline totals. Returns one point per day
// with zero-filled gaps; empty when the column isn't session-derived or the
// value never appears in the window.
export async function getSegmentDailySeriesCore(input: {
  projectId: string;
  column: string;
  value: string;
  startDate: string;
  endDate: string;
}): Promise<SegmentDailyPoint[]> {
  if (!SEGMENT_SERIES_COLUMNS.has(input.column)) {
    return [];
  }

  const { timezone } = await getSettingsForProject(input.projectId);
  const { items } = await overviewService.getTopGenericSeries({
    projectId: input.projectId,
    filters: [],
    startDate: input.startDate,
    endDate: input.endDate,
    column: input.column as TrafficColumn,
    interval: 'day',
    timezone,
  });

  // getTopGenericSeries reports empty values as null name; insights store the
  // empty referrer as "direct". Match the segment leniently.
  const target = input.value.toLowerCase();
  const matched = items.find((item) => {
    const name = (item.name ?? '').toLowerCase();
    return name === target || (name === '' && target === 'direct');
  });

  return (matched?.data ?? []).map((point) => ({
    date: point.date,
    sessions: Number(point.sessions ?? 0),
    pageviews: Number(point.pageviews ?? 0),
  }));
}

export interface GetAnalyticsOverviewInput {
  projectId: string;
  startDate: string;
  endDate: string;
  interval?: 'hour' | 'day' | 'week' | 'month';
  filters?: IChartEventFilter[];
}

export async function getAnalyticsOverviewCore(
  input: GetAnalyticsOverviewInput,
) {
  const { timezone } = await getSettingsForProject(input.projectId);
  const interval = input.interval ?? 'day';

  const result = await overviewService.getMetrics({
    projectId: input.projectId,
    filters: input.filters ?? [],
    startDate: input.startDate,
    endDate: input.endDate,
    interval,
    timezone,
  });

  return {
    summary: result.metrics,
    series: result.series,
    interval,
    startDate: input.startDate,
    endDate: input.endDate,
  };
}
