import type { IChartRange } from '@openpanel/validation';

import { getGscOverview, getGscPages, getGscQueries } from '../../../src/gsc';
import {
  gscGetOverviewCore,
  gscGetQueryOpportunitiesCore,
  gscGetTopPagesCore,
} from '../../../src/services/gsc.service';
import type { GoldenCase, GoldenContext, GoldenProjectKey } from '../harness';
import { window } from './common';
import { pid, ranked, utcDay } from './pages.cases';

/**
 * The 'YYYY-MM-DD' bounds the gsc router passes (resolveDates: the chart
 * range in the project's zone, cut to the day).
 */
function rangeDays(project: GoldenProjectKey, range: IChartRange) {
  const { startDate, endDate } = window(project, range);
  return { startDate: startDate.slice(0, 10), endDate: endDate.slice(0, 10) };
}

/** Explicit bounds relative to the anchor (the dataset has days 30..3 ago). */
function daysAgo(ctx: GoldenContext, from: number, to: number) {
  return { startDate: utcDay(ctx, -from), endDate: utcDay(ctx, -to) };
}

interface Bounds {
  startDate: string;
  endDate: string;
}

function overviewCase(
  project: GoldenProjectKey,
  label: string,
  bounds: (ctx: GoldenContext) => Bounds,
  interval?: 'day' | 'week' | 'month',
): GoldenCase {
  return {
    name: `getGscOverview ${project} ${label} ${interval ?? 'default'}`,
    run: (ctx) => {
      const { startDate, endDate } = bounds(ctx);
      return getGscOverview(pid(project), startDate, endDate, interval);
    },
  };
}

function pagesCase(
  project: GoldenProjectKey,
  label: string,
  bounds: (ctx: GoldenContext) => Bounds,
  limit?: number,
): GoldenCase {
  return {
    name: `getGscPages ${project} ${label}${limit ? ` limit ${limit}` : ''}`,
    run: async (ctx) => {
      const { startDate, endDate } = bounds(ctx);
      return ranked(
        await getGscPages(pid(project), startDate, endDate, limit),
        (row) => row.clicks,
        (row) => row.page,
        limit ?? 100,
        limit ? await getGscPages(pid(project), startDate, endDate, 10_000) : undefined,
      );
    },
  };
}

function queriesCase(
  project: GoldenProjectKey,
  label: string,
  bounds: (ctx: GoldenContext) => Bounds,
  limit?: number,
): GoldenCase {
  return {
    name: `getGscQueries ${project} ${label}${limit ? ` limit ${limit}` : ''}`,
    run: async (ctx) => {
      const { startDate, endDate } = bounds(ctx);
      return ranked(
        await getGscQueries(pid(project), startDate, endDate, limit),
        (row) => row.clicks,
        (row) => row.query,
        limit ?? 100,
        limit ? await getGscQueries(pid(project), startDate, endDate, 10_000) : undefined,
      );
    },
  };
}

export const group = 'gsc';

// getGscCannibalization, getGscPageDetails and getGscQueryDetails call the
// Search Console API (gscConnection + OAuth token), not the stored rows, so
// they are not captured here.
export const cases: GoldenCase[] = [
  overviewCase('sthlm', '30d', () => rangeDays('sthlm', '30d'), 'day'),
  // Week/month buckets: the WHERE compares the bucketed `date` alias.
  overviewCase('sthlm', '30d', () => rangeDays('sthlm', '30d'), 'week'),
  overviewCase('sthlm', '3m', () => rangeDays('sthlm', '3m'), 'month'),
  overviewCase('ny', '7d', () => rangeDays('ny', '7d')),
  overviewCase('utc', 'days 20..10 ago', (ctx) => daysAgo(ctx, 20, 10), 'day'),
  overviewCase('utc', 'days 20..10 ago', (ctx) => daysAgo(ctx, 20, 10), 'week'),
  overviewCase('utc', 'days 60..40 ago (no data)', (ctx) => daysAgo(ctx, 60, 40), 'day'),

  pagesCase('sthlm', '30d', () => rangeDays('sthlm', '30d')),
  pagesCase('ny', '7d', () => rangeDays('ny', '7d')),
  pagesCase('utc', 'days 20..10 ago', (ctx) => daysAgo(ctx, 20, 10), 2),

  queriesCase('sthlm', '30d', () => rangeDays('sthlm', '30d')),
  queriesCase('ny', '3m', () => rangeDays('ny', '3m')),
  queriesCase('utc', 'days 15..5 ago', (ctx) => daysAgo(ctx, 15, 5), 2),

  // gsc.service Core wrappers (MCP tools): JS summaries over the reads above.
  {
    name: 'gscGetOverviewCore sthlm 30d week',
    run: () =>
      gscGetOverviewCore({
        projectId: pid('sthlm'),
        ...rangeDays('sthlm', '30d'),
        interval: 'week',
      }),
  },
  {
    name: 'gscGetTopPagesCore utc 30d',
    run: async () =>
      ranked(
        await gscGetTopPagesCore({ projectId: pid('utc'), ...rangeDays('utc', '30d') }),
        (row) => row.clicks,
        (row) => row.page,
        100,
      ),
  },
  ...(
    [
      ['sthlm', undefined],
      ['ny', 2000],
    ] as const
  ).map(([project, minImpressions]) => ({
    name: `gscGetQueryOpportunitiesCore ${project} 30d min ${minImpressions ?? 'default'}`,
    run: async () => {
      const result = await gscGetQueryOpportunitiesCore({
        projectId: pid(project),
        ...rangeDays(project, '30d'),
        minImpressions,
      });
      return {
        ...result,
        opportunities: ranked(
          result.opportunities,
          (row) => row.opportunity_score,
          (row) => row.query,
        ),
      };
    },
  })),
];
