import type { IChartEventFilter, IChartRange, IInterval } from '@openpanel/validation';

import {
  getEntryExitPagesCore,
  getPageConversionsCore,
  getPagePerformanceCore,
  getTopPagesCore,
  pagesService,
} from '../../../src/services/pages.service';
import {
  GOLDEN_PROJECTS,
  type GoldenCase,
  type GoldenContext,
  type GoldenProjectKey,
} from '../harness';
import { FILTERS, explicitWindow, window } from './common';

// --- helpers (also used by the gsc, counts and routers groups) ----------------

const DAY = 86_400_000;

export function pid(project: GoldenProjectKey) {
  return GOLDEN_PROJECTS[project].id;
}

/** 'YYYY-MM-DD' (UTC) `days` after the anchor; negative is before. */
export function utcDay(ctx: GoldenContext, days: number) {
  return new Date(ctx.anchor.getTime() + days * DAY).toISOString().slice(0, 10);
}

/**
 * The date-only range the MCP tools and the insights API pass to the *Core
 * functions (resolveDateRange: `days` ago until today, both 'YYYY-MM-DD').
 */
export function lastDays(ctx: GoldenContext, days: number) {
  return { startDate: utcDay(ctx, -days), endDate: utcDay(ctx, 0) };
}

function keyText(value: unknown) {
  return value instanceof Date ? value.toISOString() : JSON.stringify(value ?? null);
}

function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A list the service orders by `key`. Rows tied on the key come back in
 * whatever order the engine reads them, so each run of ties is sorted by
 * `tieBreak` while the runs keep the returned order (a wrong ORDER BY still
 * fails). When `limit` cut the list, the rows tied with the last row may be
 * any rows of their tie, so they are reduced to `{ tiedAtLimit: key }` —
 * unless `uncut` (the same list fetched without the cut) shows that the first
 * row past the limit has another key, i.e. no tie crosses the cut.
 */
export function ranked<T>(
  rows: T[],
  key: (row: T) => unknown,
  tieBreak: (row: T) => string,
  limit?: number,
  uncut?: T[],
): unknown[] {
  const out: unknown[] = [];
  let run: T[] = [];
  const flush = () => {
    out.push(...run.sort((a, b) => compareText(tieBreak(a), tieBreak(b))));
    run = [];
  };
  for (const row of rows) {
    if (run.length > 0 && keyText(key(run[0]!)) !== keyText(key(row))) {
      flush();
    }
    run.push(row);
  }
  const wasCut = limit !== undefined && rows.length >= limit;
  const next = uncut && limit !== undefined ? uncut[limit] : undefined;
  const tieCrossesCut =
    wasCut &&
    run.length > 0 &&
    (uncut === undefined ||
      (next !== undefined && keyText(key(next)) === keyText(key(run[0]!))));
  if (tieCrossesCut) {
    out.push(...run.map((row) => ({ tiedAtLimit: key(row) })));
  } else {
    flush();
  }
  return out;
}

const pageKey = (row: { origin?: string; path?: string }) => `${row.origin}|${row.path}`;

// --- cases ----------------------------------------------------------------------

type PerformanceSort = 'sessions' | 'pageviews' | 'bounce_rate' | 'avg_duration';

function pagePerformanceCase(
  project: GoldenProjectKey,
  options: {
    search?: string;
    sortBy?: PerformanceSort;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
  },
): GoldenCase {
  const label = [
    options.sortBy ?? 'default',
    options.sortOrder ?? '',
    options.search ? `search=${options.search}` : '',
    options.limit ? `limit ${options.limit}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    name: `getPagePerformanceCore ${project} last 30 days ${label}`,
    run: async (ctx) => {
      const input = { projectId: pid(project), ...lastDays(ctx, 30), ...options };
      const result = await getPagePerformanceCore(input);
      const column = options.sortBy ?? 'sessions';
      const cut = result.total_pages > result.shown;
      const uncut = cut ? (await getPagePerformanceCore({ ...input, limit: 1000 })).pages : undefined;
      return {
        ...result,
        // Sorted in JS by one column; ties keep the (arbitrary) SQL order.
        pages: ranked(
          result.pages,
          (page) => page[column],
          pageKey,
          cut ? result.shown : undefined,
          uncut,
        ),
      };
    },
  };
}

function topPagesServiceCase(
  project: GoldenProjectKey,
  range: IChartRange,
  limit?: number,
): GoldenCase {
  return {
    name: `PagesService.getTopPages ${project} ${range}${limit ? ` limit ${limit}` : ''}`,
    run: async () => {
      const input = window(project, range);
      return ranked(
        await pagesService.getTopPages({ ...input, limit }),
        (row) => row.sessions,
        pageKey,
        limit,
        limit ? await pagesService.getTopPages(input) : undefined,
      );
    },
  };
}

function timeseriesCase(
  name: string,
  input: () => {
    projectId: string;
    timezone: string;
    startDate: string;
    endDate: string;
  },
  interval: IInterval,
  filter: { filterOrigin?: string; filterPath?: string } = {},
): GoldenCase {
  return {
    name: `PagesService.getPageTimeseries ${name}`,
    run: async () =>
      ranked(
        await pagesService.getPageTimeseries({ ...input(), interval, ...filter }),
        (row) => row.date,
        pageKey,
      ),
  };
}

function conversionsCase(
  project: GoldenProjectKey,
  conversionEvent: string,
  options: { days?: number; windowHours?: number; limit?: number } = {},
): GoldenCase {
  const days = options.days ?? 30;
  const label = [
    options.windowHours ? `window ${options.windowHours}h` : '',
    options.limit ? `limit ${options.limit}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    name: `getPageConversionsCore ${project} ${conversionEvent} last ${days} days ${label}`.trim(),
    run: async (ctx) => {
      const input = {
        projectId: pid(project),
        ...lastDays(ctx, days),
        conversionEvent,
        windowHours: options.windowHours,
      };
      return ranked(
        await getPageConversionsCore({ ...input, limit: options.limit }),
        (row) => row.unique_converters,
        pageKey,
        options.limit ?? 100,
        options.limit ? await getPageConversionsCore({ ...input, limit: 1000 }) : undefined,
      );
    },
  };
}

function topPagesCoreCase(
  name: string,
  input: (ctx: GoldenContext) => {
    projectId: string;
    startDate: string;
    endDate: string;
    limit?: number;
    filters?: IChartEventFilter[];
  },
): GoldenCase {
  return {
    name: `getTopPagesCore ${name}`,
    run: async (ctx) => {
      const params = input(ctx);
      return ranked(
        await getTopPagesCore(params),
        (row) => row.sessions,
        pageKey,
        params.limit ?? 1000,
        params.limit ? await getTopPagesCore({ ...params, limit: undefined }) : undefined,
      );
    },
  };
}

function entryExitCoreCase(
  name: string,
  mode: 'entry' | 'exit',
  input: (ctx: GoldenContext) => {
    projectId: string;
    startDate: string;
    endDate: string;
    limit?: number;
    filters?: IChartEventFilter[];
  },
): GoldenCase {
  return {
    name: `getEntryExitPagesCore ${name}`,
    run: async (ctx) => {
      const params = input(ctx);
      interface Row {
        origin: string;
        path: string;
        sessions: number;
      }
      const rows = (await getEntryExitPagesCore({ ...params, mode })) as Row[];
      const uncut = params.limit
        ? ((await getEntryExitPagesCore({ ...params, mode, limit: undefined })) as Row[])
        : undefined;
      return ranked(rows, (row) => row.sessions, pageKey, params.limit ?? 1000, uncut);
    },
  };
}

export const group = 'pages';

export const cases: GoldenCase[] = [
  // getTopPagesCore: overview top pages in the project's zone, called with
  // date-only bounds (the end day itself is excluded: 'YYYY-MM-DD' is midnight).
  topPagesCoreCase('sthlm last 30 days', (ctx) => ({
    projectId: pid('sthlm'),
    ...lastDays(ctx, 30),
  })),
  topPagesCoreCase('ny last 7 days', (ctx) => ({ projectId: pid('ny'), ...lastDays(ctx, 7) })),
  topPagesCoreCase('utc last 30 days limit 3', (ctx) => ({
    projectId: pid('utc'),
    ...lastDays(ctx, 30),
    limit: 3,
  })),
  topPagesCoreCase('sthlm DST weekend', () => {
    const { projectId, startDate, endDate } = explicitWindow(
      'sthlm',
      '2026-03-28 00:00:00',
      '2026-03-30 23:59:59',
    );
    return { projectId, startDate, endDate };
  }),

  // getEntryExitPagesCore
  entryExitCoreCase('sthlm entry last 30 days', 'entry', (ctx) => ({
    projectId: pid('sthlm'),
    ...lastDays(ctx, 30),
  })),
  entryExitCoreCase('sthlm exit last 30 days', 'exit', (ctx) => ({
    projectId: pid('sthlm'),
    ...lastDays(ctx, 30),
  })),
  entryExitCoreCase('ny entry last 30 days browserNotChrome', 'entry', (ctx) => ({
    projectId: pid('ny'),
    ...lastDays(ctx, 30),
    filters: FILTERS.browserNotChrome,
  })),
  entryExitCoreCase('utc exit last 30 days limit 2', 'exit', (ctx) => ({
    projectId: pid('utc'),
    ...lastDays(ctx, 30),
    limit: 2,
  })),

  // getPagePerformanceCore: PagesService.getTopPages (titles, durations,
  // bounce rate) sorted and annotated in JS.
  pagePerformanceCase('sthlm', {}),
  pagePerformanceCase('sthlm', { sortBy: 'pageviews', sortOrder: 'asc' }),
  pagePerformanceCase('sthlm', { sortBy: 'bounce_rate', sortOrder: 'desc' }),
  pagePerformanceCase('sthlm', { sortBy: 'avg_duration', sortOrder: 'asc', limit: 3 }),
  pagePerformanceCase('ny', { search: 'docs' }),
  pagePerformanceCase('ny', { search: 'Pricing', sortBy: 'avg_duration' }),
  pagePerformanceCase('utc', { search: 'app.example' }),
  pagePerformanceCase('utc', { search: 'no-such-page' }),

  // PagesService.getTopPages as the event.pages / previousPages routes call it.
  topPagesServiceCase('sthlm', '7d'),
  topPagesServiceCase('ny', 'today'),
  topPagesServiceCase('utc', '30d', 2),

  // PagesService.getPageTimeseries (WITH FILL over the window).
  timeseriesCase('sthlm 30d day', () => window('sthlm', '30d'), 'day'),
  timeseriesCase('sthlm 7d hour', () => window('sthlm', '7d'), 'hour'),
  timeseriesCase('ny 3m week', () => window('ny', '3m'), 'week'),
  timeseriesCase('utc 12m month', () => window('utc', '12m'), 'month'),
  timeseriesCase('sthlm 30d day /pricing', () => window('sthlm', '30d'), 'day', {
    filterOrigin: 'https://example.com',
    filterPath: '/pricing',
  }),
  timeseriesCase(
    'sthlm DST weekend hour',
    () => explicitWindow('sthlm', '2026-03-28 00:00:00', '2026-03-30 23:59:59'),
    'hour',
  ),
  timeseriesCase(
    'ny DST fortnight day',
    () => explicitWindow('ny', '2026-03-01 00:00:00', '2026-03-15 23:59:59'),
    'day',
  ),

  // getPageConversionsCore: pages viewed before a conversion event.
  conversionsCase('sthlm', 'revenue'),
  conversionsCase('sthlm', 'purchase', { windowHours: 1 }),
  conversionsCase('ny', 'signup', { days: 60, windowHours: 168 }),
  conversionsCase('utc', 'button_click', { limit: 3 }),
  conversionsCase('ny', 'link_out', { days: 7, windowHours: 2 }),
];
