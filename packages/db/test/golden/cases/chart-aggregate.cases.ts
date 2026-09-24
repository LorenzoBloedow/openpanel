/**
 * Aggregate report charts: AggregateChartEngine (normalize -> one aggregate
 * query per event series -> compute -> format) behind the `chart.aggregate`
 * tRPC procedure (bar and pie charts; the MCP/report runners use it for
 * metric charts), and through it getAggregateChartSql. One data point per
 * series, dated with the window start.
 */
import { AggregateChartEngine } from '../../../src/engine';
import type { GoldenCase, GoldenProjectKey } from '../harness';
import {
  COHORT,
  type RequestSpec,
  SV,
  UNORDERED_SERIES,
  by,
  dayBefore,
  event,
  filter,
  formula,
  reportInput,
} from './chart.cases';

function aggregateCase(
  name: string,
  project: GoldenProjectKey,
  spec: RequestSpec,
  options: Pick<GoldenCase, 'unordered' | 'tolerance' | 'ignoreKeys'> = {},
): GoldenCase {
  return {
    name,
    run: (ctx) => AggregateChartEngine.execute(reportInput(project, spec, ctx)),
    ...options,
  };
}

const basicCases: GoldenCase[] = [
  aggregateCase('bar sthlm 30d screen_view', 'sthlm', {
    chartType: 'bar',
    range: '30d',
    series: [event(SV)],
  }),
  aggregateCase('pie ny 30d all events', 'ny', {
    chartType: 'pie',
    range: '30d',
    series: [event('*')],
  }),
  aggregateCase(
    'bar utc 7d three series',
    'utc',
    {
      chartType: 'bar',
      range: '7d',
      series: [event(SV), event('button_click', { displayName: 'Clicks' }), event('session_start')],
    },
    UNORDERED_SERIES,
  ),
  aggregateCase('bar sthlm 30min all events', 'sthlm', {
    chartType: 'bar',
    range: '30min',
    interval: 'minute',
    series: [event('*')],
  }),
  aggregateCase('metric utc 12m screen_view users', 'utc', {
    chartType: 'metric',
    range: '12m',
    interval: 'month',
    series: [event(SV, { segment: 'user' })],
  }),
];

const segmentCases: GoldenCase[] = (
  [
    ['user', event(SV, { segment: 'user' })],
    ['session', event(SV, { segment: 'session' })],
    ['group', event('*', { segment: 'group' })],
    ['user_average', event(SV, { segment: 'user_average' })],
    ['one_event_per_user', event(SV, { segment: 'one_event_per_user' })],
    [
      'one_event_per_user with group and profile filters',
      event('*', {
        segment: 'one_event_per_user',
        filters: [
          filter('group.properties.plan', 'is', ['enterprise', 'pro']),
          filter('profile.properties.age', 'gte', ['30'], { type: 'number' }),
        ],
      }),
    ],
    ['property_min revenue', event('revenue', { segment: 'property_min', property: 'revenue' })],
    [
      'property_average properties.price',
      event('button_click', { segment: 'property_average', property: 'properties.price' }),
    ],
    [
      'property_max duration',
      event('session_end', { segment: 'property_max', property: 'duration' }),
    ],
    [
      'property_sum profile.properties.age',
      event(SV, { segment: 'property_sum', property: 'profile.properties.age' }),
    ],
    [
      'property_average group.properties.seats',
      event('*', { segment: 'property_average', property: 'group.properties.seats' }),
    ],
  ] as const
).map(([label, series]) =>
  aggregateCase(`segment ${label} sthlm 30d ${series.name}`, 'sthlm', {
    chartType: 'bar',
    range: '30d',
    series: [series],
  }),
);

const breakdownCases: GoldenCase[] = [
  aggregateCase(
    'breakdown device sthlm 30d screen_view',
    'sthlm',
    { chartType: 'bar', range: '30d', series: [event(SV)], breakdowns: by('device') },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'breakdown referrer_name (empty value unlabeled) ny 30d session_start',
    'ny',
    {
      chartType: 'pie',
      range: '30d',
      series: [event('session_start')],
      breakdowns: by('referrer_name'),
    },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'breakdown country+device (country isNotNull) sthlm 30d screen_view',
    'sthlm',
    {
      chartType: 'bar',
      range: '30d',
      series: [event(SV, { filters: [filter('country', 'isNotNull')] })],
      breakdowns: by('country', 'device'),
    },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'breakdown profile.properties.plan with a profile.properties.age filter sthlm 30d screen_view users',
    'sthlm',
    {
      chartType: 'bar',
      range: '30d',
      series: [
        event(SV, {
          segment: 'user',
          filters: [filter('profile.properties.age', 'gte', ['30'], { type: 'number' })],
        }),
      ],
      breakdowns: by('profile.properties.plan'),
    },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'breakdown group.name sthlm 30d screen_view sessions',
    'sthlm',
    {
      chartType: 'bar',
      range: '30d',
      series: [event(SV, { segment: 'session' })],
      breakdowns: by('group.name'),
    },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'breakdown cohort:power users sthlm 30d screen_view',
    'sthlm',
    {
      chartType: 'bar',
      range: '30d',
      series: [event(SV)],
      breakdowns: by(`cohort:${COHORT.powerUsers}`),
    },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'breakdown all cohorts sthlm 30d screen_view users',
    'sthlm',
    {
      chartType: 'pie',
      range: '30d',
      series: [event(SV, { segment: 'user' })],
      breakdowns: by('cohort'),
    },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'breakdown all cohorts with only anonymous events (fallback) sthlm 30d screen_view',
    'sthlm',
    {
      chartType: 'bar',
      range: '30d',
      series: [event(SV, { filters: [filter('has_profile', 'is', ['false'])] })],
      breakdowns: by('cohort'),
    },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'breakdown device limit 2 sthlm 30d screen_view',
    'sthlm',
    {
      chartType: 'bar',
      range: '30d',
      limit: 2,
      series: [event(SV)],
      breakdowns: by('device'),
    },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'breakdown device of an event that never happened sthlm 30d',
    'sthlm',
    {
      chartType: 'bar',
      range: '30d',
      series: [event('never_tracked')],
      breakdowns: by('device'),
    },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'breakdown name dst sthlm 2026-03-29 all events',
    'sthlm',
    {
      chartType: 'bar',
      range: 'custom',
      startDate: '2026-03-29 00:00:00',
      endDate: '2026-03-29 23:59:59',
      series: [event('*')],
      breakdowns: by('name'),
    },
    UNORDERED_SERIES,
  ),
];

const filterCases: GoldenCase[] = [
  aggregateCase(
    'filter group.properties.plan and profile.properties.age sthlm 30d all events',
    'sthlm',
    {
      chartType: 'bar',
      range: '30d',
      series: [
        event('*', {
          filters: [
            filter('group.properties.plan', 'is', ['enterprise', 'free']),
            filter('profile.properties.age', 'gt', ['25'], { type: 'number' }),
          ],
        }),
      ],
    },
  ),
  aggregateCase(
    'filter globalFilters device is mobile over two series ny 30d',
    'ny',
    {
      chartType: 'bar',
      range: '30d',
      globalFilters: [filter('device', 'is', ['mobile'])],
      series: [event(SV), event('session_start', { segment: 'session' })],
    },
    UNORDERED_SERIES,
  ),
  aggregateCase('filter path contains docs window 14..8 days before the anchor', 'utc', (ctx) => ({
    chartType: 'bar',
    range: 'custom',
    startDate: dayBefore(ctx.anchor, 14),
    endDate: dayBefore(ctx.anchor, 8),
    series: [event(SV, { filters: [filter('path', 'contains', ['docs'])] })],
  })),
];

const previousAndFormulaCases: GoldenCase[] = [
  aggregateCase('previous ny 7d screen_view', 'ny', {
    chartType: 'bar',
    range: '7d',
    previous: true,
    series: [event(SV)],
  }),
  aggregateCase(
    'previous sthlm 30d screen_view by device',
    'sthlm',
    {
      chartType: 'bar',
      range: '30d',
      previous: true,
      series: [event(SV)],
      breakdowns: by('device'),
    },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'formula A/B by device sthlm 30d',
    'sthlm',
    {
      chartType: 'bar',
      range: '30d',
      series: [event('button_click'), event(SV), formula('A/B')],
      breakdowns: by('device'),
    },
    UNORDERED_SERIES,
  ),
  aggregateCase(
    'formula displayName hideSeries with previous ny 30d',
    'ny',
    {
      chartType: 'bar',
      range: '30d',
      previous: true,
      series: [
        event('revenue', { segment: 'property_sum', property: 'revenue' }),
        event('session_start'),
        formula('A/B/100', { displayName: 'Revenue per session', hideSeries: ['A'] }),
      ],
    },
    UNORDERED_SERIES,
  ),
];

export const group = 'chart-aggregate';

export const cases: GoldenCase[] = [
  ...basicCases,
  ...segmentCases,
  ...breakdownCases,
  ...filterCases,
  ...previousAndFormulaCases,
];
