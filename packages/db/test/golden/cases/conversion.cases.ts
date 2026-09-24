import { DateTime } from '@openpanel/common';
import type {
  IChartEventFilter,
  IChartEventItem,
  IChartRange,
  IInterval,
} from '@openpanel/validation';

import { DATASET_COHORTS } from '../../fixtures/analytics-dataset';
import { conversionService } from '../../../src/services/conversion.service';
import { GOLDEN_PROJECTS, type GoldenCase, type GoldenProjectKey } from '../harness';
import { FILTERS, explicitWindow, window } from './common';

// Conversion buckets each funnel group by `any(toStartOf<interval>(created_at))`
// over its rows, so a group whose rows span two buckets has no defined
// bucket. The cases keep every group inside one bucket:
// - session funnels in the Stockholm and New York zones, where no session
//   crosses local midnight, over windows that end with yesterday (the
//   dataset's newest sessions run up to the anchor and can straddle today's
//   midnight, depending on the capture time);
// - profile funnels over windows that are a single bucket.
// No session funnels on the UTC project: its late-night sessions cross
// midnight.

type Window = ReturnType<typeof window>;

const FORMAT = 'yyyy-MM-dd HH:mm:ss';

/** The window of `range`, ending with yesterday in the project's zone. */
function untilYesterday(project: GoldenProjectKey, range: IChartRange): Window {
  const win = window(project, range);
  const today = DateTime.now().setZone(win.timezone).startOf('day');
  return { ...win, endDate: today.minus({ seconds: 1 }).toFormat(FORMAT) };
}

/** Last week, Sunday to Saturday (toStartOfWeek's weeks), in the project's zone. */
function lastWeek(project: GoldenProjectKey): Window {
  const { id, timezone } = GOLDEN_PROJECTS[project];
  const today = DateTime.now().setZone(timezone).startOf('day');
  const sunday = today.minus({ days: today.weekday % 7 });
  return {
    projectId: id,
    timezone,
    startDate: sunday.minus({ weeks: 1 }).toFormat(FORMAT),
    endDate: sunday.minus({ seconds: 1 }).toFormat(FORMAT),
  };
}

/** Last calendar month in the project's zone, ending at 23:59:59. */
function lastMonth(project: GoldenProjectKey): Window {
  const { id, timezone } = GOLDEN_PROJECTS[project];
  const month = DateTime.now().setZone(timezone).startOf('month');
  return {
    projectId: id,
    timezone,
    startDate: month.minus({ months: 1 }).toFormat(FORMAT),
    endDate: month.minus({ seconds: 1 }).toFormat(FORMAT),
  };
}

function filter(
  name: string,
  operator: IChartEventFilter['operator'],
  value: IChartEventFilter['value'],
): IChartEventFilter {
  return { id: `${name}:${operator}`, name, operator, value };
}

function event(name: string, filters: IChartEventFilter[] = []): IChartEventItem {
  return { type: 'event', name, segment: 'event', filters };
}

function pair(a: IChartEventItem, b: IChartEventItem): IChartEventItem[] {
  return [
    { ...a, id: 'A' },
    { ...b, id: 'B' },
  ];
}

interface ConversionOptions {
  breakdowns?: string[];
  globalFilters?: IChartEventFilter[];
  funnelWindow?: number;
  funnelGroup?: 'session_id' | 'profile_id';
  limit?: number;
}

/** The input the tRPC `chart.conversion` procedure hands to getConversion. */
function conversionInput(
  win: Window,
  interval: IInterval,
  series: IChartEventItem[],
  options: ConversionOptions = {},
) {
  return {
    ...win,
    interval,
    series,
    breakdowns: (options.breakdowns ?? []).map((name) => ({ id: name, name })),
    globalFilters: options.globalFilters,
    limit: options.limit,
    options: {
      type: 'funnel' as const,
      funnelWindow: options.funnelWindow,
      funnelGroup: options.funnelGroup,
    },
  };
}

function conversionCase(
  name: string,
  win: () => Window,
  interval: IInterval,
  series: IChartEventItem[],
  options: ConversionOptions = {},
): GoldenCase {
  return {
    name,
    run: () => conversionService.getConversion(conversionInput(win(), interval, series, options)),
  };
}

/** Session funnel over `range` up to yesterday (see the note at the top). */
function sessionCase(
  name: string,
  project: GoldenProjectKey,
  range: IChartRange,
  interval: IInterval,
  series: IChartEventItem[],
  options: ConversionOptions = {},
): GoldenCase {
  return conversionCase(
    `getConversion ${project} ${range} until yesterday ${interval} ${name}`,
    () => untilYesterday(project, range),
    interval,
    series,
    options,
  );
}

const START_TO_CHECKOUT = pair(event('session_start'), event('screen_view', [filter('path', 'is', ['/checkout'])]));
const PRICING_TO_REVENUE = pair(event('screen_view', [filter('path', 'is', ['/pricing'])]), event('revenue'));
const START_TO_PURCHASE = pair(event('session_start'), event('purchase'));
const VIEW_TO_CLICK = pair(event('screen_view'), event('button_click'));

export const group = 'conversion';

export const cases: GoldenCase[] = [
  // --- intervals (session funnels) ----------------------------------------------------
  sessionCase('start>checkout', 'sthlm', '30d', 'day', START_TO_CHECKOUT),
  sessionCase('pricing>revenue', 'sthlm', '30d', 'week', PRICING_TO_REVENUE),
  sessionCase('start>purchase', 'sthlm', '3m', 'month', START_TO_PURCHASE),
  sessionCase('start>checkout', 'ny', '30d', 'day', START_TO_CHECKOUT),
  sessionCase('view>signup', 'ny', '3m', 'week', pair(event('screen_view'), event('signup'))),

  // --- breakdowns -----------------------------------------------------------------
  sessionCase('start>checkout by device', 'sthlm', '30d', 'day', START_TO_CHECKOUT, {
    breakdowns: ['device'],
  }),
  // ClickHouse stores an unknown country as NUL-padded FixedString(2), which
  // skips the '(not set)' label; country breakdowns leave it out.
  sessionCase('view>click by country (known countries)', 'ny', '30d', 'week', VIEW_TO_CLICK, {
    breakdowns: ['country'],
    globalFilters: [filter('country', 'isNotNull', [])],
  }),
  // The limit stops the whole reduce once `limit` series exist, so the
  // series keep only the rows seen before that (event_day, b_0 order).
  sessionCase('view>click by referrer_name limit 3', 'sthlm', '30d', 'week', VIEW_TO_CLICK, {
    breakdowns: ['referrer_name'],
    limit: 3,
  }),
  sessionCase('start>checkout by utm_source', 'sthlm', '30d', 'week', START_TO_CHECKOUT, {
    breakdowns: ['properties.__query.utm_source'],
  }),
  sessionCase('start>purchase by device and browser', 'ny', '30d', 'week', START_TO_PURCHASE, {
    breakdowns: ['device', 'browser'],
  }),
  sessionCase('view>click by profile plan', 'sthlm', '3m', 'month', VIEW_TO_CLICK, {
    breakdowns: ['profile.properties.plan'],
  }),
  sessionCase('view>click by group name', 'sthlm', '3m', 'month', VIEW_TO_CLICK, {
    breakdowns: ['group.name'],
  }),
  sessionCase('view>click by cohort power users', 'sthlm', '3m', 'week', VIEW_TO_CLICK, {
    breakdowns: [`cohort:${DATASET_COHORTS.powerUsers.id}`],
  }),
  sessionCase('pricing>revenue by has_profile', 'ny', '30d', 'week', PRICING_TO_REVENUE, {
    breakdowns: ['has_profile'],
  }),

  // --- profile funnels over single-bucket windows ------------------------------------------
  conversionCase('getConversion sthlm today day profile view>click', () => window('sthlm', 'today'), 'day', VIEW_TO_CLICK, {
    funnelGroup: 'profile_id',
  }),
  conversionCase(
    'getConversion ny yesterday day profile start>checkout',
    () => window('ny', 'yesterday'),
    'day',
    START_TO_CHECKOUT,
    { funnelGroup: 'profile_id' },
  ),
  conversionCase(
    'getConversion sthlm last month month profile start>purchase',
    () => lastMonth('sthlm'),
    'month',
    START_TO_PURCHASE,
    { funnelGroup: 'profile_id', funnelWindow: 720 },
  ),
  conversionCase(
    'getConversion utc last week week profile pricing>revenue by device',
    () => lastWeek('utc'),
    'week',
    PRICING_TO_REVENUE,
    { funnelGroup: 'profile_id', funnelWindow: 168, breakdowns: ['device'] },
  ),

  // --- windows and filters ------------------------------------------------------------
  sessionCase('window 36s start>click', 'sthlm', '30d', 'week', pair(event('session_start'), event('button_click')), {
    funnelWindow: 0.01,
  }),
  sessionCase('start>checkout global countrySE', 'sthlm', '30d', 'week', START_TO_CHECKOUT, {
    globalFilters: FILTERS.countrySE,
  }),
  sessionCase(
    'checkout>big revenue',
    'ny',
    '3m',
    'month',
    pair(event('screen_view', [filter('path', 'is', ['/checkout'])]), event('revenue', [filter('revenue', 'gt', [1000])])),
  ),
  sessionCase(
    'same event home>pricing',
    'sthlm',
    '30d',
    'week',
    pair(event('screen_view', [filter('path', 'is', ['/'])]), event('screen_view', [filter('path', 'is', ['/pricing'])])),
  ),
  sessionCase(
    'inCohort power users view>click',
    'sthlm',
    '3m',
    'week',
    pair(
      event('screen_view', [
        { id: 'cohort', name: 'cohort', operator: 'inCohort', value: [], cohortIds: [DATASET_COHORTS.powerUsers.id] },
      ]),
      event('button_click'),
    ),
  ),

  // --- DST ------------------------------------------------------------------------
  conversionCase(
    'getConversion sthlm DST weekend day start>view',
    () => explicitWindow('sthlm', '2026-03-28 00:00:00', '2026-03-30 23:59:59'),
    'day',
    pair(event('session_start'), event('screen_view')),
  ),
  conversionCase(
    'getConversion ny DST weekend day start>view',
    () => explicitWindow('ny', '2026-03-07 00:00:00', '2026-03-09 23:59:59'),
    'day',
    pair(event('session_start'), event('screen_view')),
  ),

  // --- validation errors (thrown before querying) ---------------------------------------
  {
    name: 'getConversion error with one event',
    run: () =>
      conversionService.getConversion(
        conversionInput(window('sthlm', '30d'), 'day', [{ ...event('screen_view'), id: 'A' }]),
      ),
  },
  {
    name: 'getConversion error without dates',
    run: () =>
      conversionService.getConversion({
        ...conversionInput(window('sthlm', '30d'), 'day', START_TO_CHECKOUT),
        endDate: null,
      }),
  },
];
