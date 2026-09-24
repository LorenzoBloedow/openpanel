import { DateTime } from '@openpanel/common';
import type {
  IChartEventFilter,
  IChartEventItem,
  IChartRange,
} from '@openpanel/validation';

import { DATASET_COHORTS } from '../../fixtures/analytics-dataset';
import { getChartPrevStartEndDate } from '../../../src/services/date.service';
import { funnelService, getFunnelCore } from '../../../src/services/funnel.service';
import { GOLDEN_PROJECTS, type GoldenCase, type GoldenProjectKey } from '../harness';
import { FILTERS, explicitWindow, window } from './common';

type Window = ReturnType<typeof window>;

function filter(
  name: string,
  operator: IChartEventFilter['operator'],
  value: IChartEventFilter['value'],
  extra: Partial<IChartEventFilter> = {},
): IChartEventFilter {
  return { id: `${name}:${operator}`, name, operator, value, ...extra };
}

function cohortFilter(
  operator: 'inCohort' | 'notInCohort',
  cohortId: string,
): IChartEventFilter {
  return { id: `cohort:${operator}`, name: 'cohort', operator, value: [], cohortIds: [cohortId] };
}

const KNOWN_COUNTRY = filter('country', 'isNotNull', []);

const STEP_IDS = ['A', 'B', 'C', 'D', 'E'];

/** A funnel step as the report editor builds it. */
function step(
  name: string,
  filters: IChartEventFilter[] = [],
  displayName?: string,
): Omit<IChartEventItem & { type: 'event' }, 'id'> {
  return { type: 'event', name, segment: 'event', filters, ...(displayName ? { displayName } : {}) };
}

function steps(...items: ReturnType<typeof step>[]): IChartEventItem[] {
  return items.map((item, index) => ({ ...item, id: STEP_IDS[index] }));
}

interface FunnelOptions {
  breakdowns?: string[];
  globalFilters?: IChartEventFilter[];
  funnelWindow?: number;
  funnelGroup?: string;
}

/** The input the tRPC `chart.funnel` procedure hands to getFunnel. */
function funnelInput(
  win: Window,
  range: IChartRange,
  series: IChartEventItem[],
  options: FunnelOptions = {},
) {
  return {
    ...win,
    chartType: 'funnel' as const,
    interval: 'day' as const,
    range,
    previous: false,
    metric: 'sum' as const,
    series,
    breakdowns: (options.breakdowns ?? []).map((name) => ({ id: name, name })),
    globalFilters: options.globalFilters,
    options: {
      type: 'funnel' as const,
      funnelWindow: options.funnelWindow,
      funnelGroup: options.funnelGroup,
    },
  };
}

function funnelCase(
  name: string,
  project: GoldenProjectKey,
  range: IChartRange,
  series: IChartEventItem[],
  options: FunnelOptions = {},
): GoldenCase {
  return {
    name,
    run: () => funnelService.getFunnel(funnelInput(window(project, range), range, series, options)),
    // Series are sorted by their summed step counts; equal sums keep the
    // (undefined) row order of the query.
    unordered: options.breakdowns?.length ? [''] : [],
  };
}

async function withNonStrictOrdering<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FUNNEL_NON_STRICT_ORDERING;
  process.env.FUNNEL_NON_STRICT_ORDERING = '1';
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.FUNNEL_NON_STRICT_ORDERING;
    } else {
      process.env.FUNNEL_NON_STRICT_ORDERING = previous;
    }
  }
}

// --- reusable funnels -----------------------------------------------------------

const CHECKOUT = steps(
  step('session_start'),
  step('screen_view', [filter('path', 'is', ['/checkout'])], 'Checkout page'),
  step('revenue'),
  step('purchase'),
);

const FIVE_STEPS = steps(
  step('session_start'),
  step('screen_view'),
  step('button_click', [filter('properties.button', 'is', ['cta'])]),
  step('revenue'),
  step('purchase'),
);

const ENGAGEMENT = steps(step('screen_view'), step('button_click'), step('link_out'));

const PAGE_PATH = steps(
  step('screen_view', [filter('path', 'is', ['/'])]),
  step('screen_view', [filter('path', 'is', ['/pricing'])]),
  step('screen_view', [filter('path', 'is', ['/checkout'])]),
);

const PRICING_TO_REVENUE = steps(
  step('screen_view', [filter('path', 'is', ['/pricing'])]),
  step('revenue'),
);

const VIEW_TO_CLICK = steps(step('screen_view'), step('button_click'));

const CLICK_TO_PURCHASE = steps(step('button_click'), step('purchase'));

export const group = 'funnel';

export const cases: GoldenCase[] = [
  // --- step counts --------------------------------------------------------------
  funnelCase('getFunnel sthlm 30d 3 steps screen_view>button_click>link_out', 'sthlm', '30d', ENGAGEMENT),
  funnelCase('getFunnel sthlm 30d 4 steps checkout', 'sthlm', '30d', CHECKOUT),
  funnelCase('getFunnel sthlm 30d 5 steps cta purchase', 'sthlm', '30d', FIVE_STEPS),
  funnelCase(
    'getFunnel sthlm 30d repeated screen_view x3',
    'sthlm',
    '30d',
    steps(step('screen_view'), step('screen_view'), step('screen_view')),
  ),
  funnelCase('getFunnel sthlm 30d page path home>pricing>checkout', 'sthlm', '30d', PAGE_PATH),
  funnelCase(
    'getFunnel sthlm 30d unknown second step',
    'sthlm',
    '30d',
    steps(step('screen_view'), step('does_not_exist')),
  ),
  funnelCase(
    'getFunnel sthlm 30d session_end last step',
    'sthlm',
    '30d',
    steps(step('screen_view', [filter('path', 'startsWith', ['/docs'])]), step('button_click'), step('session_end')),
  ),

  // --- windows, grouping and ordering ---------------------------------------------
  ...([1, 24, 720] as const).map((hours) =>
    funnelCase(`getFunnel sthlm 3m profile window ${hours}h pricing>revenue`, 'sthlm', '3m', PRICING_TO_REVENUE, {
      funnelGroup: 'profile_id',
      funnelWindow: hours,
    }),
  ),
  funnelCase('getFunnel sthlm 3m session window 24h pricing>revenue', 'sthlm', '3m', PRICING_TO_REVENUE, {
    funnelGroup: 'session_id',
    funnelWindow: 24,
  }),
  funnelCase('getFunnel sthlm 30d session window 3min', 'sthlm', '30d', steps(step('session_start'), step('screen_view'), step('button_click')), {
    funnelWindow: 0.05,
  }),
  funnelCase('getFunnel ny 30d profile default window signup>purchase', 'ny', '30d', steps(step('signup'), step('screen_view'), step('purchase')), {
    funnelGroup: 'profile_id',
  }),
  {
    name: 'getFunnel sthlm 30d no options (session default)',
    run: () =>
      funnelService.getFunnel({
        ...funnelInput(window('sthlm', '30d'), '30d', CHECKOUT),
        options: undefined,
      }),
  },
  funnelCase('getFunnel sthlm 30d funnelGroup group', 'sthlm', '30d', VIEW_TO_CLICK, { funnelGroup: 'group' }),
  ...(['sthlm', 'ny'] as const).flatMap((project) => [
    funnelCase(`getFunnel ${project} 12m strict click>link_out`, project, '12m', steps(step('button_click'), step('link_out'))),
    {
      name: `getFunnel ${project} 12m non-strict click>link_out`,
      run: () =>
        withNonStrictOrdering(() =>
          funnelService.getFunnel(
            funnelInput(window(project, '12m'), '12m', steps(step('button_click'), step('link_out'))),
          ),
        ),
    },
  ]),
  {
    name: 'getFunnel ny 12m non-strict purchase>screen_view',
    run: () =>
      withNonStrictOrdering(() =>
        funnelService.getFunnel(
          funnelInput(window('ny', '12m'), '12m', steps(step('purchase'), step('screen_view'))),
        ),
      ),
  },
  funnelCase('getFunnel ny 12m strict purchase>screen_view', 'ny', '12m', steps(step('purchase'), step('screen_view'))),

  // --- filters ------------------------------------------------------------------
  funnelCase('getFunnel sthlm 30d global countrySE checkout', 'sthlm', '30d', CHECKOUT, {
    globalFilters: FILTERS.countrySE,
  }),
  funnelCase('getFunnel ny 30d global mobileInUS engagement', 'ny', '30d', ENGAGEMENT, {
    globalFilters: FILTERS.mobileInUS,
  }),
  funnelCase(
    'getFunnel sthlm 30d utm newsletter entry',
    'sthlm',
    '30d',
    steps(step('session_start', FILTERS.utmNewsletter), step('screen_view', [filter('path', 'is', ['/pricing'])]), step('button_click')),
  ),
  funnelCase(
    'getFunnel sthlm 30d property filters href/revenue/sku',
    'sthlm',
    '30d',
    steps(
      step('link_out', [filter('properties.href', 'contains', ['github', 'twitter'])]),
      step('revenue', [filter('revenue', 'gt', [1000])]),
      step('purchase', [filter('properties.item.sku', 'is', ['sku-1'])]),
    ),
  ),
  funnelCase(
    'getFunnel ny 30d title regex and typed price',
    'ny',
    '30d',
    steps(
      step('screen_view', [filter('properties.__title', 'regex', ['^(Pricing|Docs)$'])]),
      step('button_click', [filter('properties.price', 'gte', ['10'], { type: 'number' })]),
    ),
  ),
  funnelCase(
    'getFunnel utc 30d null checks utm campaign',
    'utc',
    '30d',
    steps(
      step('session_start', [filter('properties.__query.utm_campaign', 'isNotNull', [])]),
      step('button_click', [filter('properties.variant', 'isNot', ['b'])]),
    ),
  ),
  funnelCase(
    'getFunnel sthlm 30d isNull referrer then doesNotContain path',
    'sthlm',
    '30d',
    steps(
      step('session_start', [filter('referrer_name', 'isNull', [])]),
      step('screen_view', [filter('path', 'doesNotContain', ['docs'])]),
      step('button_click', [filter('properties.button', 'is', ['nav', 'footer'])]),
    ),
  ),
  funnelCase(
    'getFunnel utc 30d endsWith path and lte qty',
    'utc',
    '30d',
    steps(
      step('screen_view', [filter('path', 'endsWith', ['out'])]),
      step('purchase', [filter('properties.item.qty', 'lte', ['2'])]),
    ),
  ),
  funnelCase(
    'getFunnel ny 30d path regex with slashes and price lt',
    'ny',
    '30d',
    steps(
      // Bare-column regexes drop leading/trailing slashes: '/docs/' -> 'docs'.
      step('screen_view', [filter('path', 'regex', ['/docs/'])]),
      step('button_click', [filter('properties.price', 'lt', ['10'])]),
    ),
  ),
  funnelCase(
    'getFunnel sthlm 3m profile plan pro',
    'sthlm',
    '3m',
    steps(step('screen_view', [filter('profile.properties.plan', 'is', ['pro'])]), step('button_click')),
    { funnelGroup: 'profile_id' },
  ),
  funnelCase(
    'getFunnel sthlm 3m profile company.name and age',
    'sthlm',
    '3m',
    steps(
      step('screen_view', [filter('profile.properties.company.name', 'is', ['acme'])]),
      step('button_click', [filter('profile.properties.age', 'gte', ['30'])]),
    ),
  ),
  funnelCase('getFunnel sthlm 3m inCohort power users', 'sthlm', '3m', VIEW_TO_CLICK, {
    globalFilters: [cohortFilter('inCohort', DATASET_COHORTS.powerUsers.id)],
  }),
  funnelCase('getFunnel sthlm 3m notInCohort free plan profile', 'sthlm', '3m', CHECKOUT, {
    globalFilters: [cohortFilter('notInCohort', DATASET_COHORTS.freePlan.id)],
    funnelGroup: 'profile_id',
  }),
  funnelCase('getFunnel sthlm 3m group filter Acme', 'sthlm', '3m', VIEW_TO_CLICK, {
    globalFilters: [filter('group.name', 'is', ['Acme Inc'])],
  }),
  funnelCase(
    'getFunnel ny 3m group plan filter on step',
    'ny',
    '3m',
    steps(step('screen_view', [filter('group.properties.plan', 'is', ['enterprise', 'pro'])]), step('button_click')),
  ),
  // has_profile with session grouping fails in ClickHouse (the argMax
  // profile_id alias shadows the column), so these group by profile.
  funnelCase('getFunnel utc 30d has_profile true profile', 'utc', '30d', VIEW_TO_CLICK, {
    globalFilters: [filter('has_profile', 'is', ['true'])],
    funnelGroup: 'profile_id',
  }),

  // --- breakdowns ---------------------------------------------------------------
  ...(
    [
      ['sthlm', 'referrer_name'],
      ['ny', 'device'],
      ['utc', 'path'],
    ] as const
  ).map(([project, breakdown]) =>
    funnelCase(`getFunnel ${project} 30d checkout by ${breakdown}`, project, '30d', CHECKOUT, {
      breakdowns: [breakdown],
    }),
  ),
  funnelCase('getFunnel sthlm 30d click>purchase by variant (entry step)', 'sthlm', '30d', CLICK_TO_PURCHASE, {
    breakdowns: ['properties.variant'],
  }),
  funnelCase('getFunnel ny 30d engagement by device and os', 'ny', '30d', ENGAGEMENT, {
    breakdowns: ['device', 'os'],
  }),
  funnelCase('getFunnel sthlm 3m profile plan breakdown', 'sthlm', '3m', VIEW_TO_CLICK, {
    breakdowns: ['profile.properties.plan'],
    funnelGroup: 'profile_id',
  }),
  funnelCase('getFunnel ny 3m profile email breakdown', 'ny', '3m', PRICING_TO_REVENUE, {
    breakdowns: ['profile.email'],
    funnelGroup: 'profile_id',
    funnelWindow: 720,
  }),
  funnelCase('getFunnel sthlm 3m group name breakdown', 'sthlm', '3m', VIEW_TO_CLICK, {
    breakdowns: ['group.name'],
  }),
  funnelCase('getFunnel ny 3m group plan breakdown', 'ny', '3m', CHECKOUT, {
    breakdowns: ['group.properties.plan'],
  }),
  funnelCase('getFunnel sthlm 3m cohort breakdown power users', 'sthlm', '3m', VIEW_TO_CLICK, {
    breakdowns: [`cohort:${DATASET_COHORTS.powerUsers.id}`],
  }),
  funnelCase('getFunnel utc 30d has_profile breakdown profile', 'utc', '30d', CHECKOUT, {
    breakdowns: ['has_profile'],
    funnelGroup: 'profile_id',
  }),
  funnelCase('getFunnel sthlm 30d aliased breakdowns utm_source referrerName', 'sthlm', '30d', VIEW_TO_CLICK, {
    breakdowns: ['utm_source', 'referrerName'],
  }),
  funnelCase('getFunnel sthlm 30d unknown breakdowns dropped', 'sthlm', '30d', CHECKOUT, {
    breakdowns: ['cohort', 'not_a_column'],
  }),
  // ClickHouse stores an unknown country as NUL-padded FixedString(2), which
  // skips the "Not set" normalisation; country breakdowns leave it out.
  funnelCase('getFunnel sthlm 30d country breakdown with global filters', 'sthlm', '30d', ENGAGEMENT, {
    breakdowns: ['country'],
    globalFilters: [KNOWN_COUNTRY, filter('device', 'is', ['desktop'])],
  }),

  // --- date ranges and time zones ---------------------------------------------------
  ...(
    [
      ['sthlm', '7d'],
      ['sthlm', 'today'],
      ['ny', 'lastMonth'],
      ['utc', 'yesterday'],
      ['utc', 'yearToDate'],
    ] as const
  ).map(([project, range]) =>
    funnelCase(`getFunnel ${project} ${range} checkout`, project, range, CHECKOUT),
  ),
  {
    name: 'getFunnel sthlm previous period of 30d',
    run: () => {
      const current = window('sthlm', '30d');
      return funnelService.getFunnel(
        funnelInput({ ...current, ...getChartPrevStartEndDate(current) }, '30d', ENGAGEMENT),
      );
    },
  },
  {
    name: 'getFunnel sthlm DST weekend session_start>screen_view>button_click',
    run: () =>
      funnelService.getFunnel(
        funnelInput(
          explicitWindow('sthlm', '2026-03-28 00:00:00', '2026-03-30 23:59:59'),
          'custom',
          steps(step('session_start'), step('screen_view'), step('button_click')),
        ),
      ),
  },
  {
    name: 'getFunnel ny DST weekend session_start>screen_view by device',
    run: () =>
      funnelService.getFunnel(
        funnelInput(
          explicitWindow('ny', '2026-03-07 00:00:00', '2026-03-09 23:59:59'),
          'custom',
          steps(step('session_start'), step('screen_view')),
          { breakdowns: ['device'] },
        ),
      ),
    unordered: [''],
  },
  {
    name: 'getFunnel sthlm DST window 02:00-04:00 local',
    run: () =>
      funnelService.getFunnel(
        funnelInput(
          explicitWindow('sthlm', '2026-03-29 02:00:00', '2026-03-29 04:00:00'),
          'custom',
          steps(step('session_start'), step('screen_view')),
        ),
      ),
  },

  // --- getFunnelCore (public insights API / MCP) ----------------------------------------
  {
    name: 'getFunnelCore sthlm 30d checkout',
    run: () =>
      getFunnelCore({
        ...window('sthlm', '30d'),
        steps: ['session_start', 'screen_view', 'revenue', 'purchase'],
      }),
  },
  {
    name: 'getFunnelCore ny 3m profile 1h',
    run: () =>
      getFunnelCore({
        ...window('ny', '3m'),
        steps: ['screen_view', 'button_click', 'purchase'],
        windowHours: 1,
        groupBy: 'profile_id',
      }),
  },
  {
    // The insights API passes explicit dates through as 'YYYY-MM-DD', which
    // the query reads as midnight: the end date itself is excluded.
    name: 'getFunnelCore utc date-only bounds',
    run: () => {
      const today = DateTime.utc().startOf('day');
      return getFunnelCore({
        projectId: GOLDEN_PROJECTS.utc.id,
        startDate: today.minus({ days: 50 }).toISODate()!,
        endDate: today.minus({ days: 10 }).toISODate()!,
        steps: ['screen_view', 'button_click', 'link_out'],
        windowHours: 720,
        groupBy: 'session_id',
      });
    },
  },
  {
    name: 'getFunnelCore sthlm 30d no matches',
    run: () =>
      getFunnelCore({
        ...window('sthlm', '30d'),
        steps: ['does_not_exist', 'screen_view'],
      }),
  },

  // --- validation errors (thrown before querying) ------------------------------------
  {
    name: 'getFunnel error without event series',
    run: () =>
      funnelService.getFunnel(
        funnelInput(window('sthlm', '30d'), '30d', [{ id: 'A', type: 'formula', formula: 'A' }]),
      ),
  },
  {
    name: 'getFunnel error without dates',
    run: () =>
      funnelService.getFunnel({
        ...funnelInput(window('sthlm', '30d'), '30d', CHECKOUT),
        startDate: undefined,
      }),
  },
];
