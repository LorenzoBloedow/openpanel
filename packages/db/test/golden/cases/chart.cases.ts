/**
 * Report charts over time: the chart engine (normalize -> plan -> fetch ->
 * compute -> format) behind the `chart.chart` tRPC procedure (line, area,
 * histogram, metric and map charts), and through it getChartSql and
 * getEventFiltersWhereClause. Inputs are built the way the router receives
 * them — a zod-parsed report — and handed to ChartEngine.execute unchanged.
 *
 * Series order: format() sorts series by sum, and ties keep the order the
 * rows came back in, so every case with breakdowns or several series marks
 * `series` unordered. The "filter matrix" cases put one filter variant per
 * series, labelled with the series displayName.
 */
import type {
  IChartBreakdown,
  IChartEventFilter,
  IChartRange,
  IInterval,
  IReportInput,
  zChartEventItem,
} from '@openpanel/validation';
import { zReportInput } from '@openpanel/validation';
import type { z } from 'zod';

import { ChartEngine } from '../../../src/engine';
import { DATASET_COHORTS } from '../../fixtures/analytics-dataset';
import {
  GOLDEN_PROJECTS,
  type GoldenCase,
  type GoldenContext,
  type GoldenProjectKey,
} from '../harness';

// --- helpers (shared with chart-aggregate.cases.ts) ----------------------------

export type ReportRequest = Omit<z.input<typeof zReportInput>, 'projectId'>;
type SeriesItem = z.input<typeof zChartEventItem>;
type EventItem = Extract<SeriesItem, { type: 'event' }>;
type FormulaItem = Extract<SeriesItem, { type: 'formula' }>;

/** A request, or one built from the context (anchor-relative dates). */
export type RequestSpec = ReportRequest | ((ctx: GoldenContext) => ReportRequest);

export const SV = 'screen_view';

export const COHORT = {
  powerUsers: DATASET_COHORTS.powerUsers.id,
  freePlan: DATASET_COHORTS.freePlan.id,
} as const;

/** Series order is only defined up to ties in their sums. */
export const UNORDERED_SERIES = { unordered: ['series'] };

/** The report the chart router hands the engine (zod defaults applied). */
export function reportInput(
  project: GoldenProjectKey,
  spec: RequestSpec,
  ctx: GoldenContext,
): IReportInput {
  const request = typeof spec === 'function' ? spec(ctx) : spec;
  return zReportInput.parse({
    ...request,
    projectId: GOLDEN_PROJECTS[project].id,
  });
}

export function event(
  name: string,
  extra: Omit<EventItem, 'type' | 'name'> = {},
): EventItem {
  return { type: 'event', name, ...extra };
}

export function formula(
  expression: string,
  extra: Omit<FormulaItem, 'type' | 'formula'> = {},
): FormulaItem {
  return { type: 'formula', formula: expression, ...extra };
}

export function filter(
  name: string,
  operator: IChartEventFilter['operator'],
  value: IChartEventFilter['value'] = [],
  extra: Partial<IChartEventFilter> = {},
): IChartEventFilter {
  return { name, operator, value, ...extra };
}

export function by(...names: string[]): IChartBreakdown[] {
  return names.map((name) => ({ id: name, name }));
}

const DAY_MS = 86_400_000;

/** The UTC calendar date `days` before the anchor, as 'YYYY-MM-DD'. */
export function dayBefore(anchor: Date, days: number): string {
  return new Date(anchor.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

function chartCase(
  name: string,
  project: GoldenProjectKey,
  spec: RequestSpec,
  options: Pick<GoldenCase, 'unordered' | 'tolerance' | 'ignoreKeys'> = {},
): GoldenCase {
  return {
    name,
    run: (ctx) => ChartEngine.execute(reportInput(project, spec, ctx)),
    ...options,
  };
}

// --- ranges x intervals x time zones -------------------------------------------

const RANGES: [GoldenProjectKey, IChartRange, IInterval, string][] = [
  ['sthlm', '30d', 'day', SV],
  ['ny', '30d', 'day', SV],
  ['utc', '30d', 'day', SV],
  ['sthlm', '7d', 'hour', SV],
  ['sthlm', 'today', 'hour', SV],
  ['ny', 'today', 'hour', '*'],
  ['ny', 'yesterday', 'hour', SV],
  ['utc', 'last24h', 'hour', 'session_start'],
  ['sthlm', '30min', 'minute', '*'],
  ['ny', 'lastHour', 'minute', '*'],
  ['sthlm', '3m', 'week', SV],
  ['ny', '6m', 'week', '*'],
  ['sthlm', '12m', 'month', SV],
  ['utc', 'yearToDate', 'month', '*'],
];

const rangeCases = RANGES.map(([project, range, interval, name]) =>
  chartCase(`range ${project} ${range} ${interval} ${name}`, project, {
    range,
    interval,
    series: [event(name)],
  }),
);

// --- segments ------------------------------------------------------------------

const SEGMENTS: [string, GoldenProjectKey, IChartRange, IInterval, EventItem][] = [
  ['user', 'sthlm', '30d', 'day', event(SV, { segment: 'user' })],
  ['session', 'sthlm', '30d', 'day', event(SV, { segment: 'session' })],
  ['group', 'sthlm', '30d', 'day', event('*', { segment: 'group' })],
  ['user_average', 'sthlm', '30d', 'day', event(SV, { segment: 'user_average' })],
  [
    'one_event_per_user',
    'sthlm',
    '30d',
    'day',
    event(SV, { segment: 'one_event_per_user' }),
  ],
  [
    'property_sum revenue',
    'sthlm',
    '30d',
    'day',
    event('revenue', { segment: 'property_sum', property: 'revenue' }),
  ],
  [
    'property_min revenue',
    'sthlm',
    '30d',
    'day',
    event('revenue', { segment: 'property_min', property: 'revenue' }),
  ],
  [
    'property_average properties.price',
    'sthlm',
    '30d',
    'day',
    event('button_click', {
      segment: 'property_average',
      property: 'properties.price',
    }),
  ],
  [
    'property_max properties.item.qty',
    'sthlm',
    '30d',
    'day',
    event('purchase', { segment: 'property_max', property: 'properties.item.qty' }),
  ],
  [
    'property_max duration',
    'sthlm',
    '30d',
    'day',
    event('session_end', { segment: 'property_max', property: 'duration' }),
  ],
  [
    'property_sum profile.properties.age',
    'sthlm',
    '30d',
    'day',
    event(SV, { segment: 'property_sum', property: 'profile.properties.age' }),
  ],
  [
    'property_sum without a property (plain count)',
    'sthlm',
    '30d',
    'day',
    event('revenue', { segment: 'property_sum' }),
  ],
  [
    'one_event_per_user with group and profile filters',
    'sthlm',
    '30d',
    'day',
    event('*', {
      segment: 'one_event_per_user',
      filters: [
        filter('group.properties.plan', 'is', ['enterprise', 'pro']),
        filter('profile.properties.age', 'gte', ['30'], { type: 'number' }),
      ],
    }),
  ],
  ['one_event_per_user', 'utc', '7d', 'day', event('*', { segment: 'one_event_per_user' })],
  [
    'property_sum revenue',
    'ny',
    '12m',
    'month',
    event('revenue', { segment: 'property_sum', property: 'revenue' }),
  ],
];

const segmentCases = SEGMENTS.map(([label, project, range, interval, series]) =>
  chartCase(
    `segment ${label} ${project} ${range} ${interval} ${series.name}`,
    project,
    { range, interval, series: [series] },
  ),
);

// --- filters (getEventFiltersWhereClause), sthlm 30d by day -----------------------

type FilterSpec = IChartEventFilter[] | ((ctx: GoldenContext) => IChartEventFilter[]);

function resolveFilters(spec: FilterSpec, ctx: GoldenContext) {
  return typeof spec === 'function' ? spec(ctx) : spec;
}

const FILTER_CASES: [string, string, FilterSpec][] = [
  // top-level event columns
  ['country is SE', SV, [filter('country', 'is', ['SE'])]],
  ['country is SE|US', SV, [filter('country', 'is', ['SE', 'US'])]],
  ['browser isNot Chrome|Firefox', SV, [filter('browser', 'isNot', ['Chrome', 'Firefox'])]],
  ['referrer_name isNull', SV, [filter('referrer_name', 'isNull')]],
  ['duration gt 60000 (numeric column)', SV, [filter('duration', 'gt', ['60000'])]],
  ['revenue gte 1999 (numeric column)', 'revenue', [filter('revenue', 'gte', ['1999'])]],
  [
    'created_at gte a local time 7 days before the anchor',
    SV,
    (ctx) => [filter('created_at', 'gte', [`${dayBefore(ctx.anchor, 7)} 12:00:00`])],
  ],
  // field-name aliases
  ['referrerName is Google (camelCase alias)', SV, [filter('referrerName', 'is', ['Google'])]],
  ['utm_source is newsletter (bare utm name)', SV, [filter('utm_source', 'is', ['newsletter'])]],
  // event properties
  [
    'properties.__query.utm_campaign is spring_launch|launch_week',
    SV,
    [filter('properties.__query.utm_campaign', 'is', ['spring_launch', 'launch_week'])],
  ],
  [
    'properties.__title is a quoted unicode title',
    SV,
    [filter('properties.__title', 'is', ["Hello, world — it's here"])],
  ],
  [
    'properties.button is cta and properties.variant isNot a',
    'button_click',
    [filter('properties.button', 'is', ['cta']), filter('properties.variant', 'isNot', ['a'])],
  ],
  [
    "properties.price lt 10 untyped ('free' reads as 0)",
    'button_click',
    [filter('properties.price', 'lt', ['10'])],
  ],
  [
    'properties.item.sku is sku-1 (dotted key)',
    'purchase',
    [filter('properties.item.sku', 'is', ['sku-1'])],
  ],
  [
    'properties.item[*] is sku-2 (wildcard key)',
    'purchase',
    [filter('properties.item[*]', 'is', ['sku-2'])],
  ],
  // has_profile, and filters the where-clause builder drops
  ['has_profile is true', SV, [filter('has_profile', 'is', ['true'])]],
  ['unknown column is dropped', SV, [filter('totally_made_up_column', 'is', ['x'])]],
  [
    'profile.email is dropped (only profile.properties.* filters apply)',
    SV,
    [filter('profile.email', 'endsWith', ['example.com'])],
  ],
  // profile properties (profile join)
  ['profile.properties.plan is pro', SV, [filter('profile.properties.plan', 'is', ['pro'])]],
  [
    'profile.properties.age gt 30 untyped',
    SV,
    [filter('profile.properties.age', 'gt', ['30'])],
  ],
  [
    'profile.properties.company.name isNotNull',
    SV,
    [filter('profile.properties.company.name', 'isNotNull')],
  ],
  // groups (ARRAY JOIN groups + groups table)
  ['group.name is Acme Inc', SV, [filter('group.name', 'is', ['Acme Inc'])]],
  [
    'group.properties.plan is pro|enterprise',
    '*',
    [filter('group.properties.plan', 'is', ['pro', 'enterprise'])],
  ],
  ['group.id isNot acme', '*', [filter('group.id', 'isNot', ['acme'])]],
  [
    'group.properties.seats gt 10 untyped (operator unsupported for groups)',
    '*',
    [filter('group.properties.seats', 'gt', ['10'])],
  ],
  // cohorts (cohort_members)
  [
    'inCohort power users',
    SV,
    [filter('cohort', 'inCohort', [], { cohortIds: [COHORT.powerUsers] })],
  ],
  [
    'notInCohort free plan',
    SV,
    [filter('cohort', 'notInCohort', [], { cohortIds: [COHORT.freePlan] })],
  ],
  [
    'inCohort power users|free plan',
    SV,
    [
      filter('cohort', 'inCohort', [], {
        cohortIds: [COHORT.powerUsers, COHORT.freePlan],
      }),
    ],
  ],
  [
    'inCohort via the legacy cohortId field',
    SV,
    [filter('cohort', 'inCohort', [], { cohortId: COHORT.freePlan })],
  ],
];

const filterCases = FILTER_CASES.map(([label, name, filters]) =>
  chartCase(`filter ${label} sthlm 30d day ${name}`, 'sthlm', (ctx) => ({
    range: '30d',
    interval: 'day',
    series: [event(name, { filters: resolveFilters(filters, ctx) })],
  })),
);

/** [series label, event, filters] — one series per filter variant. */
type MatrixRow = [string, string, FilterSpec];

function filterMatrixCase(name: string, rows: MatrixRow[]): GoldenCase {
  return chartCase(
    `filter matrix ${name} sthlm 30d day`,
    'sthlm',
    (ctx) => ({
      range: '30d',
      interval: 'day',
      series: rows.map(([label, eventName, filters]) =>
        event(eventName, { displayName: label, filters: resolveFilters(filters, ctx) }),
      ),
    }),
    UNORDERED_SERIES,
  );
}

const filterMatrixCases: GoldenCase[] = [
  filterMatrixCase('column string operators', [
    ['path contains docs', SV, [filter('path', 'contains', ['docs'])]],
    ['path doesNotContain docs', SV, [filter('path', 'doesNotContain', ['docs'])]],
    ['path startsWith /docs|/blog', SV, [filter('path', 'startsWith', ['/docs', '/blog'])]],
    ['path endsWith profile|started', SV, [filter('path', 'endsWith', ['profile', 'started'])]],
    [
      'path regex /docs/|^/pricing$ (outer slashes stripped)',
      SV,
      [filter('path', 'regex', ['/docs/', '^/pricing$'])],
    ],
    ['path isNot /|/pricing', SV, [filter('path', 'isNot', ['/', '/pricing'])]],
    ['origin is https://app.example.com', SV, [filter('origin', 'is', ['https://app.example.com'])]],
  ]),
  filterMatrixCase('property string operators', [
    ['__title contains ing', SV, [filter('properties.__title', 'contains', ['ing'])]],
    ['__title doesNotContain Docs', SV, [filter('properties.__title', 'doesNotContain', ['Docs'])]],
    ['__title startsWith Get|Set', SV, [filter('properties.__title', 'startsWith', ['Get', 'Set'])]],
    ['__title endsWith s', SV, [filter('properties.__title', 'endsWith', ['s'])]],
    ['__title regex ^(Docs|Pricing)$', SV, [filter('properties.__title', 'regex', ['^(Docs|Pricing)$'])]],
    ['__title isNot Docs', SV, [filter('properties.__title', 'isNot', ['Docs'])]],
    ['__title isNot Docs|Pricing', SV, [filter('properties.__title', 'isNot', ['Docs', 'Pricing'])]],
  ]),
  filterMatrixCase('property null checks and untyped comparisons', [
    ['utm_source isNull', SV, [filter('properties.__query.utm_source', 'isNull')]],
    ['utm_source isNotNull', SV, [filter('properties.__query.utm_source', 'isNotNull')]],
    ['price gte 9.99 untyped', 'button_click', [filter('properties.price', 'gte', ['9.99'])]],
    ["price lte 0 untyped ('free' reads as 0)", 'button_click', [filter('properties.price', 'lte', ['0'])]],
    ['item.qty gt 1|2 untyped (any value)', 'purchase', [filter('properties.item.qty', 'gt', ['1', '2'])]],
  ]),
  filterMatrixCase('group operators', [
    ['group.name contains Inc', '*', [filter('group.name', 'contains', ['Inc'])]],
    ['group.name doesNotContain Inc', '*', [filter('group.name', 'doesNotContain', ['Inc'])]],
    ['group.name startsWith Glo|Ini', '*', [filter('group.name', 'startsWith', ['Glo', 'Ini'])]],
    ['group.name endsWith tech', '*', [filter('group.name', 'endsWith', ['tech'])]],
    ['group.name regex ^(Acme|Initech)', '*', [filter('group.name', 'regex', ['^(Acme|Initech)'])]],
    ['group.name isNot Initech|Acme Inc', '*', [filter('group.name', 'isNot', ['Initech', 'Acme Inc'])]],
    [
      'group.properties.billing.country isNull',
      '*',
      [filter('group.properties.billing.country', 'isNull')],
    ],
    [
      'group.properties.billing.country isNotNull',
      '*',
      [filter('group.properties.billing.country', 'isNotNull')],
    ],
    ['group.type is company', '*', [filter('group.type', 'is', ['company'])]],
  ]),
  filterMatrixCase('typed casts', [
    [
      'price number lt 10',
      'button_click',
      [filter('properties.price', 'lt', ['10'], { type: 'number' })],
    ],
    [
      'price number isNot 0|19',
      'button_click',
      [filter('properties.price', 'isNot', ['0', '19'], { type: 'number' })],
    ],
    [
      '__bounce boolean is true',
      'session_end',
      [filter('properties.__bounce', 'is', ['true'], { type: 'boolean' })],
    ],
    [
      '__bounce boolean isNot true',
      'session_end',
      [filter('properties.__bounce', 'isNot', ['true'], { type: 'boolean' })],
    ],
    [
      'item.qty number gt 1',
      'purchase',
      [filter('properties.item.qty', 'gt', ['1'], { type: 'number' })],
    ],
    [
      'duration number gte 60000 (column)',
      SV,
      [filter('duration', 'gte', ['60000'], { type: 'number' })],
    ],
    [
      'created_at date lt 20 days before the anchor',
      SV,
      (ctx) => [filter('created_at', 'lt', [dayBefore(ctx.anchor, 20)], { type: 'date' })],
    ],
    [
      'created_at datetime gte 7 days before the anchor 12:00',
      SV,
      (ctx) => [
        filter('created_at', 'gte', [`${dayBefore(ctx.anchor, 7)} 12:00:00`], {
          type: 'datetime',
        }),
      ],
    ],
    [
      'profile.properties.age number lt 30',
      SV,
      [filter('profile.properties.age', 'lt', ['30'], { type: 'number' })],
    ],
    [
      'group.properties.seats number lt 10',
      '*',
      [filter('group.properties.seats', 'lt', ['10'], { type: 'number' })],
    ],
  ]),
];

const moreFilterCases: GoldenCase[] = [
  chartCase('filter inCohort free plan ny 30d day screen_view', 'ny', {
    range: '30d',
    interval: 'day',
    series: [
      event(SV, {
        filters: [filter('cohort', 'inCohort', [], { cohortIds: [COHORT.freePlan] })],
      }),
    ],
  }),
  chartCase(
    'filter globalFilters country is SE over two series sthlm 30d day',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      globalFilters: [filter('country', 'is', ['SE'])],
      series: [
        event(SV),
        event('button_click', { filters: [filter('properties.button', 'is', ['cta'])] }),
      ],
    },
    UNORDERED_SERIES,
  ),
];

// --- breakdowns ------------------------------------------------------------------

const breakdownCases: GoldenCase[] = [
  chartCase(
    'breakdown device sthlm 30d day screen_view',
    'sthlm',
    { range: '30d', interval: 'day', series: [event(SV)], breakdowns: by('device') },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown country+device (country isNotNull) sthlm 30d day screen_view',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [event(SV, { filters: [filter('country', 'isNotNull')] })],
      breakdowns: by('country', 'device'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown referrer_name (empty value unlabeled) sthlm 30d day screen_view',
    'sthlm',
    { range: '30d', interval: 'day', series: [event(SV)], breakdowns: by('referrer_name') },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown properties.__query.utm_source sthlm 30d day session_start',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [event('session_start')],
      breakdowns: by('properties.__query.utm_source'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown utm_campaign (bare utm name) sthlm 30d week screen_view',
    'sthlm',
    { range: '30d', interval: 'week', series: [event(SV)], breakdowns: by('utm_campaign') },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown name sthlm 7d day all events',
    'sthlm',
    { range: '7d', interval: 'day', series: [event('*')], breakdowns: by('name') },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown properties.item.sku sthlm 30d day purchase sum of item.qty',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [
        event('purchase', { segment: 'property_sum', property: 'properties.item.qty' }),
      ],
      breakdowns: by('properties.item.sku'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown profile.properties.plan sthlm 30d day screen_view users',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [event(SV, { segment: 'user' })],
      breakdowns: by('profile.properties.plan'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown profile.last_name (profile column) sthlm 30d day screen_view users',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [event(SV, { segment: 'user' })],
      breakdowns: by('profile.last_name'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown group.name sthlm 30d day screen_view sessions',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [event(SV, { segment: 'session' })],
      breakdowns: by('group.name'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown group.properties.plan sthlm 30d week all events',
    'sthlm',
    {
      range: '30d',
      interval: 'week',
      series: [event('*')],
      breakdowns: by('group.properties.plan'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown group.id sthlm 30d day all events groups',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [event('*', { segment: 'group' })],
      breakdowns: by('group.id'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown cohort:power users sthlm 30d day screen_view users',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [event(SV, { segment: 'user' })],
      breakdowns: by(`cohort:${COHORT.powerUsers}`),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown all cohorts sthlm 30d day screen_view',
    'sthlm',
    { range: '30d', interval: 'day', series: [event(SV)], breakdowns: by('cohort') },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown all cohorts on a project without cohorts ny 30d day screen_view',
    'ny',
    { range: '30d', interval: 'day', series: [event(SV)], breakdowns: by('cohort') },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown cohort:free plan ny 30d day screen_view',
    'ny',
    {
      range: '30d',
      interval: 'day',
      series: [event(SV)],
      breakdowns: by(`cohort:${COHORT.freePlan}`),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown has_profile sthlm 30d day screen_view',
    'sthlm',
    { range: '30d', interval: 'day', series: [event(SV)], breakdowns: by('has_profile') },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown unknown field is dropped sthlm 30d day screen_view',
    'sthlm',
    { range: '30d', interval: 'day', series: [event(SV)], breakdowns: by('temple_name') },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown device limit 2 sthlm 30d day screen_view',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      limit: 2,
      series: [event(SV)],
      breakdowns: by('device'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown device over two series sthlm 30d day',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [event(SV, { displayName: 'Page views' }), event('session_start')],
      breakdowns: by('device'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown referrer_type+device ny 7d day screen_view',
    'ny',
    {
      range: '7d',
      interval: 'day',
      series: [event(SV)],
      breakdowns: by('referrer_type', 'device'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'breakdown utm_source sthlm 30d day screen_view one_event_per_user',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [event(SV, { segment: 'one_event_per_user' })],
      breakdowns: by('properties.__query.utm_source'),
    },
    UNORDERED_SERIES,
  ),
];

// --- formulas --------------------------------------------------------------------

const formulaCases: GoldenCase[] = [
  chartCase(
    'formula A/B*100 sthlm 30d day',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [event('button_click'), event(SV), formula('A/B*100')],
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'formula displayName and hideSeries sthlm 30d week',
    'sthlm',
    {
      range: '30d',
      interval: 'week',
      series: [
        event(SV, { segment: 'user' }),
        event(SV),
        formula('B/A', { displayName: 'Views per user', hideSeries: ['A', 'B'] }),
      ],
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'formula chained C=A-B D=C*2 ny 7d day',
    'ny',
    {
      range: '7d',
      interval: 'day',
      series: [event('session_start'), event('session_end'), formula('A-B'), formula('C*2')],
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'formula A/B by device sthlm 30d day',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      series: [event('button_click'), event(SV), formula('A/B')],
      breakdowns: by('device'),
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'formula revenue per session with previous sthlm 30d day',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      previous: true,
      series: [
        event('revenue', { segment: 'property_sum', property: 'revenue' }),
        event('session_start'),
        formula('A/B/100', { displayName: 'Revenue per session' }),
      ],
    },
    UNORDERED_SERIES,
  ),
  chartCase(
    'formula division by zero and functions utc 30d day',
    'utc',
    {
      range: '30d',
      interval: 'day',
      series: [event(SV), event('signup'), formula('round(A/B)'), formula('max(A, B) - min(A, B)')],
    },
    UNORDERED_SERIES,
  ),
];

// --- previous period ----------------------------------------------------------------

const previousCases: GoldenCase[] = [
  chartCase('previous sthlm 30d day screen_view', 'sthlm', {
    range: '30d',
    interval: 'day',
    previous: true,
    series: [event(SV)],
  }),
  chartCase('previous ny 7d hour all events', 'ny', {
    range: '7d',
    interval: 'hour',
    previous: true,
    series: [event('*')],
  }),
  chartCase('previous sthlm 12m month screen_view (empty prior year)', 'sthlm', {
    range: '12m',
    interval: 'month',
    previous: true,
    series: [event(SV)],
  }),
  chartCase(
    'previous sthlm 30d day screen_view by device',
    'sthlm',
    {
      range: '30d',
      interval: 'day',
      previous: true,
      series: [event(SV)],
      breakdowns: by('device'),
    },
    UNORDERED_SERIES,
  ),
];

// --- chart types (same SQL as linear) ------------------------------------------------

const chartTypeCases: GoldenCase[] = [
  chartCase('chartType metric (metric average) sthlm 30d day screen_view', 'sthlm', {
    chartType: 'metric',
    metric: 'average',
    range: '30d',
    interval: 'day',
    series: [event(SV)],
  }),
  chartCase('chartType histogram ny 7d day button_click', 'ny', {
    chartType: 'histogram',
    range: '7d',
    interval: 'day',
    series: [event('button_click')],
  }),
  // Empty countries are left out: ClickHouse returns them NUL-padded
  // (FixedString(2)), which the engine keeps as a label of its own.
  chartCase(
    'chartType map by country (country isNotNull) ny 7d day screen_view',
    'ny',
    {
      chartType: 'map',
      range: '7d',
      interval: 'day',
      series: [event(SV, { filters: [filter('country', 'isNotNull')] })],
      breakdowns: by('country'),
    },
    UNORDERED_SERIES,
  ),
];

// --- explicit windows: DST edges and anchor-relative custom ranges -------------------

const windowCases: GoldenCase[] = [
  chartCase('dst sthlm 2026-03-28..30 hour all events', 'sthlm', {
    range: 'custom',
    startDate: '2026-03-28 00:00:00',
    endDate: '2026-03-30 23:59:59',
    interval: 'hour',
    series: [event('*')],
  }),
  chartCase('dst sthlm 2026-03-28..30 day all events (date-only bounds)', 'sthlm', {
    range: 'custom',
    startDate: '2026-03-28',
    endDate: '2026-03-30',
    interval: 'day',
    series: [event('*')],
  }),
  chartCase('dst sthlm 2026-03-29 01:00..04:59 minute all events', 'sthlm', {
    range: 'custom',
    startDate: '2026-03-29 01:00:00',
    endDate: '2026-03-29 04:59:59',
    interval: 'minute',
    series: [event('*')],
  }),
  chartCase('dst sthlm 2026-03-01..04-30 week all events', 'sthlm', {
    range: 'custom',
    startDate: '2026-03-01',
    endDate: '2026-04-30',
    interval: 'week',
    series: [event('*')],
  }),
  chartCase('dst ny 2026-03-07..09 hour all events', 'ny', {
    range: 'custom',
    startDate: '2026-03-07 00:00:00',
    endDate: '2026-03-09 23:59:59',
    interval: 'hour',
    series: [event('*')],
  }),
  chartCase('dst ny 2026-03-01..15 day screen_view', 'ny', {
    range: 'custom',
    startDate: '2026-03-01',
    endDate: '2026-03-15',
    interval: 'day',
    series: [event(SV)],
  }),
  chartCase('dst ny 2026-02-01..04-30 month all events', 'ny', {
    range: 'custom',
    startDate: '2026-02-01',
    endDate: '2026-04-30',
    interval: 'month',
    series: [event('*')],
  }),
  chartCase(
    'dst ny 2026-03-08 hour users by device',
    'ny',
    {
      range: 'custom',
      startDate: '2026-03-08',
      endDate: '2026-03-08',
      interval: 'hour',
      series: [event('*', { segment: 'user' })],
      breakdowns: by('device'),
    },
    UNORDERED_SERIES,
  ),
  chartCase('window sthlm 14..8 days before the anchor day screen_view', 'sthlm', (ctx) => ({
    range: 'custom',
    startDate: dayBefore(ctx.anchor, 14),
    endDate: dayBefore(ctx.anchor, 8),
    interval: 'day',
    series: [event(SV)],
  })),
  chartCase('window ny 3 days before 06:00..2 days before 18:30 hour sessions', 'ny', (ctx) => ({
    range: 'custom',
    startDate: `${dayBefore(ctx.anchor, 3)} 06:00:00`,
    endDate: `${dayBefore(ctx.anchor, 2)} 18:30:00`,
    interval: 'hour',
    series: [event(SV, { segment: 'session' })],
  })),
  chartCase('window utc 30d range with an explicit endDate only', 'utc', (ctx) => ({
    range: '30d',
    endDate: `${dayBefore(ctx.anchor, 10)} 23:59:59`,
    interval: 'day',
    series: [event(SV)],
  })),
  // No WITH FILL for an inverted window; the empty breakdown result then
  // falls back to the query without breakdowns (also empty).
  chartCase(
    'window sthlm inverted (end before start) by device',
    'sthlm',
    (ctx) => ({
      range: 'custom',
      startDate: dayBefore(ctx.anchor, 5),
      endDate: dayBefore(ctx.anchor, 10),
      interval: 'day',
      series: [event(SV)],
      breakdowns: by('device'),
    }),
    UNORDERED_SERIES,
  ),
];

export const group = 'chart';

export const cases: GoldenCase[] = [
  ...rangeCases,
  ...segmentCases,
  ...filterCases,
  ...filterMatrixCases,
  ...moreFilterCases,
  ...breakdownCases,
  ...formulaCases,
  ...previousCases,
  ...chartTypeCases,
  ...windowCases,
];
