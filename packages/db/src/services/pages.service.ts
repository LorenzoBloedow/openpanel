import type { IChartEventFilter, IInterval } from '@openpanel/validation';
import { anQuery } from '../analytics/client';
import { type Sql, and, empty, or, raw, sql } from '../analytics/sql';
import { type TimeCtx, parseTimestamp } from '../analytics/time';
import {
  MS_TO_NEXT_VIEW,
  bucketKey,
  bucketLabel,
  bucketOf,
  chRound,
  createdBetween,
  fillBuckets,
  withFill,
} from './overview-buckets';

export interface IGetPagesInput {
  projectId: string;
  startDate: string;
  endDate: string;
  timezone: string;
  search?: string;
  limit?: number;
}

export interface IPageTimeseriesRow {
  origin: string;
  path: string;
  date: string;
  pageviews: number;
  sessions: number;
}

export interface ITopPage {
  origin: string;
  path: string;
  title: string;
  sessions: number;
  pageviews: number;
  avg_duration: number;
  bounce_rate: number;
}

const DAY_MS = 86_400_000;
/** getPageConversionsCore ran without session_timezone. */
const UTC: TimeCtx = { timezone: 'UTC' };
/** How far back page titles are looked up. */
const TITLE_LOOKBACK_DAYS = 30;

export class PagesService {
  /** Takes (and ignores) the ClickHouse client it used to be built with. */
  // biome-ignore lint/complexity/noUselessConstructor: callers still pass the client
  constructor(_client?: unknown) {
    // Nothing to keep: the queries use the analytics pool.
  }

  async getTopPages({
    projectId,
    startDate,
    endDate,
    timezone,
    search,
    limit,
  }: IGetPagesInput): Promise<ITopPage[]> {
    const ctx: TimeCtx = { timezone };
    const range = { startDate, endDate };
    // The JS clock, not now(): a frozen clock (tests) must hold here too.
    const titlesSince = new Date(
      Date.now() - TITLE_LOOKBACK_DAYS * DAY_MS,
    ).toISOString();

    // Case-sensitive LIKE on the path, the origin or the title, as before.
    const pattern = `%${search}%`;
    const searchWhere: Sql = search
      ? sql`WHERE ${or([
          sql`e.path LIKE ${pattern}::text`,
          sql`e.origin LIKE ${pattern}::text`,
          sql`pt.title LIKE ${pattern}::text`,
        ])}`
      : empty;

    return anQuery<ITopPage>(sql`
      WITH page_titles AS (
        SELECT DISTINCT ON (t.origin || t.path)
          t.origin || t.path AS page_key,
          COALESCE(t.properties ->> '__title', '') AS title
        FROM analytics.events t
        WHERE t.project_id = ${projectId}
          AND t.name = 'screen_view'
          AND t.created_at >= ${titlesSince}::timestamptz
        ORDER BY t.origin || t.path, t.created_at DESC
      ),
      screen_view_durations AS (
        SELECT
          e.session_id,
          e.path,
          e.origin,
          ${MS_TO_NEXT_VIEW} AS duration
        FROM analytics.events e
        WHERE ${and([
          sql`e.project_id = ${projectId}`,
          sql`e.name = 'screen_view'`,
          sql`e.path <> ''`,
          createdBetween(raw('e.created_at'), range, ctx),
        ])}
      )
      SELECT
        e.origin,
        e.path,
        COALESCE(pt.title, '') AS title,
        count(DISTINCT e.session_id) AS sessions,
        count(*) AS pageviews,
        ${chRound(sql`avg(e.duration::double precision) / 1000 / 60`, 2)} AS avg_duration,
        ${chRound(sql`(count(DISTINCT e.session_id) FILTER (WHERE s.is_bounce))::double precision * 100 / NULLIF(count(DISTINCT e.session_id), 0)`, 2)} AS bounce_rate
      FROM screen_view_durations e
      LEFT JOIN analytics.sessions s
        ON s.project_id = ${projectId}
        AND s.id = e.session_id
        AND ${createdBetween(raw('s.created_at'), range, ctx)}
      LEFT JOIN page_titles pt ON pt.page_key = e.origin || e.path
      ${searchWhere}
      GROUP BY e.origin, e.path, pt.title
      ORDER BY sessions DESC, e.origin, e.path
      ${limit !== undefined ? sql`LIMIT ${Math.max(0, Math.trunc(limit))}` : empty}
    `);
  }

  async getPageTimeseries({
    projectId,
    startDate,
    endDate,
    timezone,
    interval,
    filterOrigin,
    filterPath,
  }: IGetPagesInput & {
    interval: IInterval;
    filterOrigin?: string;
    filterPath?: string;
  }): Promise<IPageTimeseriesRow[]> {
    const ctx: TimeCtx = { timezone };

    const rows = await anQuery<IPageTimeseriesRow & { bucket_key: string }>(sql`
      SELECT
        b.origin,
        b.path,
        ${bucketKey(raw('b.bucket'), interval)} AS bucket_key,
        ${bucketLabel(raw('b.bucket'), interval, ctx)} AS date,
        count(*) AS pageviews,
        count(DISTINCT b.session_id) AS sessions
      FROM (
        SELECT
          ${bucketOf(raw('e.created_at'), interval, ctx)} AS bucket,
          e.origin,
          e.path,
          e.session_id
        FROM analytics.events e
        WHERE ${and([
          sql`e.project_id = ${projectId}`,
          sql`e.name = 'screen_view'`,
          sql`e.path <> ''`,
          createdBetween(raw('e.created_at'), { startDate, endDate }, ctx),
          filterOrigin ? sql`e.origin = ${filterOrigin}::text` : empty,
          filterPath ? sql`e.path = ${filterPath}::text` : empty,
        ])}
      ) b
      GROUP BY b.origin, b.path, b.bucket
      ORDER BY bucket_key, b.origin, b.path
    `);

    // WITH FILL rows carry the column defaults.
    return withFill(
      rows,
      (row) => row.bucket_key,
      fillBuckets(interval, startDate, endDate, timezone),
      (bucket) => ({
        origin: '',
        path: '',
        bucket_key: bucket.key,
        date: bucket.label,
        pageviews: 0,
        sessions: 0,
      }),
    ).map(({ bucket_key: _key, ...row }) => row);
  }
}

export const pagesService = new PagesService();

import { OverviewService } from './overview.service';
import { getSettingsForProject } from './organization.service';

const _overviewServiceForPages = new OverviewService();

export async function getTopPagesCore(input: {
  projectId: string;
  startDate: string;
  endDate: string;
  limit?: number;
  filters?: IChartEventFilter[];
}) {
  const { timezone } = await getSettingsForProject(input.projectId);
  return _overviewServiceForPages.getTopPages({
    projectId: input.projectId,
    filters: input.filters ?? [],
    startDate: input.startDate,
    endDate: input.endDate,
    timezone,
    limit: input.limit,
  });
}

export async function getEntryExitPagesCore(input: {
  projectId: string;
  startDate: string;
  endDate: string;
  mode: 'entry' | 'exit';
  limit?: number;
  filters?: IChartEventFilter[];
}) {
  const { timezone } = await getSettingsForProject(input.projectId);
  return _overviewServiceForPages.getTopEntryExit({
    projectId: input.projectId,
    filters: input.filters ?? [],
    startDate: input.startDate,
    endDate: input.endDate,
    mode: input.mode,
    timezone,
    limit: input.limit,
  });
}

export async function getPagePerformanceCore(input: {
  projectId: string;
  startDate: string;
  endDate: string;
  search?: string;
  sortBy?: 'sessions' | 'pageviews' | 'bounce_rate' | 'avg_duration';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
}) {
  const { timezone } = await getSettingsForProject(input.projectId);
  const pages = await pagesService.getTopPages({
    projectId: input.projectId,
    startDate: input.startDate,
    endDate: input.endDate,
    timezone,
    search: input.search,
    limit: 1000,
  });

  const col = input.sortBy ?? 'sessions';
  const dir = input.sortOrder === 'asc' ? 1 : -1;
  const sorted = [...pages].sort(
    (a, b) => dir * ((a[col] ?? 0) < (b[col] ?? 0) ? -1 : 1),
  );
  const results = sorted.slice(0, input.limit ?? 50);

  const annotated = results.map((p) => ({
    ...p,
    seo_signals: {
      high_bounce: p.bounce_rate > 70,
      low_engagement: p.avg_duration < 1,
      good_landing_page: p.bounce_rate < 40 && p.avg_duration > 2,
    },
  }));

  return {
    total_pages: pages.length,
    shown: annotated.length,
    pages: annotated,
  };
}

export interface IPageConversionRow {
  path: string;
  origin: string;
  unique_converters: number;
  total_visitors: number;
  conversion_rate: number;
}

export async function getPageConversionsCore(input: {
  projectId: string;
  startDate: string;
  endDate: string;
  conversionEvent: string;
  windowHours?: number;
  limit?: number;
}): Promise<IPageConversionRow[]> {
  const { projectId, startDate, endDate, conversionEvent, windowHours = 24, limit = 100 } = input;
  const hours = Math.trunc(Number(windowHours));
  const rowLimit = Math.trunc(Number(limit));
  // ClickHouse rejected a window or a limit that isn't a number; now they
  // match nothing.
  if (!(Number.isFinite(hours) && Number.isFinite(rowLimit))) {
    return [];
  }
  // This query ran without session_timezone: the bounds are UTC, and text
  // that isn't a date matches nothing.
  const inRange = (column: Sql) =>
    sql`${column} BETWEEN ${parseTimestamp(sql`${startDate}::text`, UTC)} AND ${parseTimestamp(sql`${endDate}::text`, UTC)}`;

  // A page counts a profile once when it viewed the page in the window
  // hours before one of its conversions (the DISTINCT profile/page pairs of
  // the ClickHouse join).
  return anQuery<IPageConversionRow>(sql`
    WITH conversion_events AS (
      SELECT profile_id, created_at AS conv_time
      FROM analytics.events
      WHERE project_id = ${projectId}
        AND name = ${conversionEvent}::text
        AND ${inRange(raw('created_at'))}
    ),
    converters AS (
      SELECT e.path, e.origin, count(DISTINCT e.profile_id) AS unique_converters
      FROM analytics.events e
      WHERE e.project_id = ${projectId}
        AND e.name = 'screen_view'
        AND e.path <> ''
        AND ${inRange(raw('e.created_at'))}
        AND EXISTS (
          SELECT 1
          FROM conversion_events c
          WHERE c.profile_id = e.profile_id
            AND e.created_at < c.conv_time
            AND e.created_at >= c.conv_time - make_interval(hours => ${hours})
        )
      GROUP BY e.path, e.origin
    ),
    total_visitors AS (
      SELECT path, origin, count(DISTINCT session_id) AS visitors
      FROM analytics.events
      WHERE project_id = ${projectId}
        AND name = 'screen_view'
        AND path <> ''
        AND ${inRange(raw('created_at'))}
      GROUP BY path, origin
    )
    SELECT
      c.path,
      c.origin,
      c.unique_converters,
      tv.visitors AS total_visitors,
      ${chRound(sql`100.0::double precision * c.unique_converters / tv.visitors`, 2)} AS conversion_rate
    FROM converters c
    LEFT JOIN total_visitors tv ON tv.path = c.path AND tv.origin = c.origin
    ORDER BY c.unique_converters DESC, c.path, c.origin
    LIMIT ${Math.max(0, rowLimit)}
  `);
}
