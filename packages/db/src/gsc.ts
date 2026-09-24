import { cacheable } from '@openpanel/redis';
import { anQuery } from './analytics/client';
import { type Sql, sql } from './analytics/sql';
import { type GscWriteRow, upsertGscRows } from './analytics/writers';
import { decrypt, encrypt } from './encryption';
import { createLogger } from '@openpanel/logger';
import { db } from './prisma-client';

const logger = createLogger({ name: 'db:gsc' });

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

async function refreshGscToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: Date }> {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not set in this environment'
    );
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to refresh GSC token: ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  return { accessToken: data.access_token, expiresAt };
}

export async function getGscAccessToken(projectId: string): Promise<string> {
  const conn = await db.gscConnection.findUniqueOrThrow({
    where: { projectId },
  });

  if (
    conn.accessTokenExpiresAt &&
    conn.accessTokenExpiresAt.getTime() > Date.now() + 60_000
  ) {
    logger.info(
      { projectId, expiresAt: conn.accessTokenExpiresAt },
      'GSC using cached access token',
    );
    return decrypt(conn.accessToken);
  }

  logger.info(
    {
      projectId,
      expiresAt: conn.accessTokenExpiresAt,
      hasRefreshToken: !!conn.refreshToken,
    },
    'GSC access token expired, attempting refresh',
  );

  try {
    const { accessToken, expiresAt } = await refreshGscToken(
      decrypt(conn.refreshToken)
    );
    await db.gscConnection.update({
      where: { projectId },
      data: { accessToken: encrypt(accessToken), accessTokenExpiresAt: expiresAt },
    });
    logger.info(
      { projectId, expiresAt },
      'GSC token refreshed successfully',
    );
    return accessToken;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to refresh token';
    logger.error(
      { err: error, projectId, errorMessage },
      'GSC token refresh failed',
    );
    await db.gscConnection.update({
      where: { projectId },
      data: {
        lastSyncStatus: 'token_expired',
        lastSyncError: errorMessage,
      },
    });
    throw new Error(
      `GSC token refresh failed for project ${projectId}: ${errorMessage}`
    );
  }
}

export async function listGscSites(projectId: string): Promise<GscSite[]> {
  const accessToken = await getGscAccessToken(projectId);
  const res = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to list GSC sites: ${text}`);
  }

  const data = (await res.json()) as {
    siteEntry?: Array<{ siteUrl: string; permissionLevel: string }>;
  };
  return data.siteEntry ?? [];
}

interface GscApiRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface GscDimensionFilter {
  dimension: string;
  operator: string;
  expression: string;
}

interface GscFilterGroup {
  filters: GscDimensionFilter[];
}

async function queryGscSearchAnalytics(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
  dimensions: string[],
  dimensionFilterGroups?: GscFilterGroup[]
): Promise<GscApiRow[]> {
  const encodedSiteUrl = encodeURIComponent(siteUrl);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`;

  const allRows: GscApiRow[] = [];
  let startRow = 0;
  const rowLimit = 25000;

  while (true) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions,
        rowLimit,
        startRow,
        dataState: 'all',
        ...(dimensionFilterGroups && { dimensionFilterGroups }),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GSC query failed for dimensions [${dimensions.join(',')}]: ${text}`);
    }

    const data = (await res.json()) as { rows?: GscApiRow[] };
    const rows = data.rows ?? [];
    allRows.push(...rows);

    if (rows.length < rowLimit) break;
    startRow += rowLimit;
  }

  return allRows;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type GscTable = 'gsc_daily' | 'gsc_pages_daily' | 'gsc_queries_daily';
type GscRow = GscWriteRow & { page?: string; query?: string };

/** Rows per upsert statement: the batch travels as one JSON parameter. */
const GSC_WRITE_BATCH = 5000;

/**
 * Store synced rows; a re-synced day replaces what was there (the
 * ReplacingMergeTree(synced_at) tables before). A key the API returned
 * twice keeps its last row: one upsert can't update a row twice. Rows go in
 * key order, so syncs of overlapping days (nightly and backfill) lock rows
 * in the same order instead of deadlocking.
 */
async function writeGscRows(table: GscTable, rows: GscRow[]): Promise<void> {
  const byKey = new Map<string, GscRow>();
  for (const row of rows) {
    byKey.set(`${row.date}\u0000${row.page ?? row.query ?? ''}`, row);
  }
  const unique = [...byKey.keys()].sort().map((key) => byKey.get(key)!);
  for (let i = 0; i < unique.length; i += GSC_WRITE_BATCH) {
    await upsertGscRows(table, unique.slice(i, i + GSC_WRITE_BATCH));
  }
}

export async function syncGscData(
  projectId: string,
  startDate: Date,
  endDate: Date
): Promise<void> {
  const conn = await db.gscConnection.findUniqueOrThrow({
    where: { projectId },
  });

  if (!conn.siteUrl) {
    throw new Error('No GSC site URL configured for this project');
  }

  const accessToken = await getGscAccessToken(projectId);
  const start = formatDate(startDate);
  const end = formatDate(endDate);
  const syncedAt = new Date().toISOString();

  // 1. Daily totals — authoritative numbers for overview chart
  const dailyRows = await queryGscSearchAnalytics(
    accessToken,
    conn.siteUrl,
    start,
    end,
    ['date']
  );

  await writeGscRows(
    'gsc_daily',
    dailyRows.map((row) => ({
      project_id: projectId,
      date: row.keys[0] ?? '',
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
      synced_at: syncedAt,
    })),
  );

  // 2. Per-page breakdown
  const pageRows = await queryGscSearchAnalytics(
    accessToken,
    conn.siteUrl,
    start,
    end,
    ['date', 'page']
  );

  await writeGscRows(
    'gsc_pages_daily',
    pageRows.map((row) => ({
      project_id: projectId,
      date: row.keys[0] ?? '',
      page: row.keys[1] ?? '',
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
      synced_at: syncedAt,
    })),
  );

  // 3. Per-query breakdown
  const queryRows = await queryGscSearchAnalytics(
    accessToken,
    conn.siteUrl,
    start,
    end,
    ['date', 'query']
  );

  await writeGscRows(
    'gsc_queries_daily',
    queryRows.map((row) => ({
      project_id: projectId,
      date: row.keys[0] ?? '',
      query: row.keys[1] ?? '',
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
      synced_at: syncedAt,
    })),
  );
}

/** 'YYYY-MM-DD' (month and day may be one digit, as ClickHouse allowed). */
const GSC_DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/**
 * A range bound as a calendar day, or null when it isn't one: ClickHouse
 * rejected such bounds (datetimes included) with an error; now they match
 * nothing.
 */
function toGscDay(value: string): string | null {
  const match = GSC_DAY.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealDay =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return isRealDay ? date.toISOString().slice(0, 10) : null;
}

/** Both range bounds as calendar days, or null when the range matches nothing. */
function gscDateRange(startDate: string, endDate: string) {
  const start = toGscDay(startDate);
  const end = toGscDay(endDate);
  return start && end ? { start, end } : null;
}

/** LIMIT as ClickHouse's UInt32 parameter took it: a whole, non-negative count. */
function gscLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
}

/**
 * The bucket of a GSC `date` as ClickHouse computed it on its Date column:
 * toStartOfWeek (mode 0, weeks start on Sunday) and toStartOfMonth. GSC
 * dates are calendar days already, so this is date arithmetic — no time
 * zone, and nothing depends on the connection's TimeZone.
 */
function gscBucket(interval: 'day' | 'week' | 'month'): Sql {
  switch (interval) {
    case 'week':
      return sql`(date - extract(dow FROM date)::int)`;
    case 'month':
      return sql`date_trunc('month', date::timestamp)::date`;
    default:
      return sql`date`;
  }
}

export async function getGscOverview(
  projectId: string,
  startDate: string,
  endDate: string,
  interval: 'day' | 'week' | 'month' = 'day'
): Promise<
  Array<{
    date: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>
> {
  const range = gscDateRange(startDate, endDate);
  if (!range) {
    return [];
  }

  // ClickHouse's WHERE compared the `date` alias, i.e. the bucket: a week or
  // month counts when its first day is inside the range, with all its days.
  // (`date >= start` follows from that and keeps the scan on the key.)
  return anQuery(sql`
    SELECT
      to_char(b.bucket, 'YYYY-MM-DD') AS date,
      sum(b.clicks) AS clicks,
      sum(b.impressions) AS impressions,
      avg(b.ctr) AS ctr,
      avg(b.position) AS position
    FROM (
      SELECT ${gscBucket(interval)} AS bucket, clicks, impressions, ctr, position
      FROM analytics.gsc_daily
      WHERE project_id = ${projectId} AND date >= ${range.start}::date
    ) b
    WHERE b.bucket >= ${range.start}::date AND b.bucket <= ${range.end}::date
    GROUP BY b.bucket
    ORDER BY b.bucket ASC
  `);
}

export async function getGscPages(
  projectId: string,
  startDate: string,
  endDate: string,
  limit = 100
): Promise<
  Array<{
    page: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>
> {
  const range = gscDateRange(startDate, endDate);
  if (!range) {
    return [];
  }

  return anQuery(sql`
    SELECT
      page,
      sum(clicks) AS clicks,
      sum(impressions) AS impressions,
      avg(ctr) AS ctr,
      avg(position) AS position
    FROM analytics.gsc_pages_daily
    WHERE project_id = ${projectId}
      AND date >= ${range.start}::date
      AND date <= ${range.end}::date
    GROUP BY page
    ORDER BY sum(clicks) DESC, page ASC
    LIMIT ${gscLimit(limit)}
  `);
}

export interface GscCannibalizedQuery {
  query: string;
  totalImpressions: number;
  totalClicks: number;
  pages: Array<{
    page: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
}

export const getGscCannibalization = cacheable(
  async (
    projectId: string,
    startDate: string,
    endDate: string
  ): Promise<GscCannibalizedQuery[]> => {
    const conn = await db.gscConnection.findUniqueOrThrow({
      where: { projectId },
    });
    const accessToken = await getGscAccessToken(projectId);

    const rows = await queryGscSearchAnalytics(
      accessToken,
      conn.siteUrl,
      startDate,
      endDate,
      ['query', 'page']
    );

    const map = new Map<
      string,
      {
        totalImpressions: number;
        totalClicks: number;
        pages: GscCannibalizedQuery['pages'];
      }
    >();

    for (const row of rows) {
      const query = row.keys[0] ?? '';
      // Strip hash fragments — GSC records heading anchors (e.g. /page#section)
      // as separate URLs but Google treats them as the same page
      let page = row.keys[1] ?? '';
      try {
        const u = new URL(page);
        u.hash = '';
        page = u.toString();
      } catch {
        page = page.split('#')[0] ?? page;
      }

      const entry = map.get(query) ?? {
        totalImpressions: 0,
        totalClicks: 0,
        pages: [],
      };
      entry.totalImpressions += row.impressions;
      entry.totalClicks += row.clicks;
      // Merge into existing page entry if already seen (from a different hash variant)
      const existing = entry.pages.find((p) => p.page === page);
      if (existing) {
        const totalImpressions = existing.impressions + row.impressions;
        if (totalImpressions > 0) {
          existing.position =
            (existing.position * existing.impressions + row.position * row.impressions) / totalImpressions;
        }
        existing.clicks += row.clicks;
        existing.impressions += row.impressions;
        existing.ctr =
          existing.impressions > 0 ? existing.clicks / existing.impressions : 0;
      } else {
        entry.pages.push({
          page,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        });
      }
      map.set(query, entry);
    }

    return [...map.entries()]
      .filter(([, v]) => v.pages.length >= 2 && v.totalImpressions >= 100)
      .sort(([, a], [, b]) => b.totalImpressions - a.totalImpressions)
      .slice(0, 50)
      .map(([query, v]) => ({
        query,
        totalImpressions: v.totalImpressions,
        totalClicks: v.totalClicks,
        pages: v.pages.sort((a, b) =>
          a.position !== b.position
            ? a.position - b.position
            : b.impressions - a.impressions
        ),
      }));
  },
  60 * 60 * 4
);

export async function getGscPageDetails(
  projectId: string,
  page: string,
  startDate: string,
  endDate: string
): Promise<{
  timeseries: Array<{ date: string; clicks: number; impressions: number; ctr: number; position: number }>;
  queries: Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number }>;
}> {
  const conn = await db.gscConnection.findUniqueOrThrow({ where: { projectId } });
  const accessToken = await getGscAccessToken(projectId);
  const filterGroups: GscFilterGroup[] = [{ filters: [{ dimension: 'page', operator: 'equals', expression: page }] }];

  const [timeseriesRows, queryRows] = await Promise.all([
    queryGscSearchAnalytics(accessToken, conn.siteUrl, startDate, endDate, ['date'], filterGroups),
    queryGscSearchAnalytics(accessToken, conn.siteUrl, startDate, endDate, ['query'], filterGroups),
  ]);

  return {
    timeseries: timeseriesRows.map((row) => ({
      date: row.keys[0] ?? '',
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    })),
    queries: queryRows.map((row) => ({
      query: row.keys[0] ?? '',
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    })),
  };
}

export async function getGscQueryDetails(
  projectId: string,
  query: string,
  startDate: string,
  endDate: string
): Promise<{
  timeseries: Array<{ date: string; clicks: number; impressions: number; ctr: number; position: number }>;
  pages: Array<{ page: string; clicks: number; impressions: number; ctr: number; position: number }>;
}> {
  const conn = await db.gscConnection.findUniqueOrThrow({ where: { projectId } });
  const accessToken = await getGscAccessToken(projectId);
  const filterGroups: GscFilterGroup[] = [{ filters: [{ dimension: 'query', operator: 'equals', expression: query }] }];

  const [timeseriesRows, pageRows] = await Promise.all([
    queryGscSearchAnalytics(accessToken, conn.siteUrl, startDate, endDate, ['date'], filterGroups),
    queryGscSearchAnalytics(accessToken, conn.siteUrl, startDate, endDate, ['page'], filterGroups),
  ]);

  return {
    timeseries: timeseriesRows.map((row) => ({
      date: row.keys[0] ?? '',
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    })),
    pages: pageRows.map((row) => ({
      page: row.keys[0] ?? '',
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    })),
  };
}

export async function getGscQueries(
  projectId: string,
  startDate: string,
  endDate: string,
  limit = 100
): Promise<
  Array<{
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>
> {
  const range = gscDateRange(startDate, endDate);
  if (!range) {
    return [];
  }

  return anQuery(sql`
    SELECT
      query,
      sum(clicks) AS clicks,
      sum(impressions) AS impressions,
      avg(ctr) AS ctr,
      avg(position) AS position
    FROM analytics.gsc_queries_daily
    WHERE project_id = ${projectId}
      AND date >= ${range.start}::date
      AND date <= ${range.end}::date
    GROUP BY query
    ORDER BY sum(clicks) DESC, query ASC
    LIMIT ${gscLimit(limit)}
  `);
}
