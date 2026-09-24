import type { IChartRange, IInterval } from '@openpanel/validation';

import { overviewService } from '../../../src/services/overview.service';
import type { GoldenCase } from '../harness';
import { FILTERS, explicitWindow, window } from './common';

type Project = 'sthlm' | 'ny' | 'utc';

const METRIC_WINDOWS: [Project, IChartRange, IInterval][] = [
  ['sthlm', '30d', 'day'],
  ['sthlm', '7d', 'day'],
  ['sthlm', 'today', 'hour'],
  ['sthlm', '3m', 'week'],
  ['sthlm', '12m', 'month'],
  ['ny', '30d', 'day'],
  ['ny', 'yesterday', 'hour'],
  ['utc', '30min', 'minute'],
];

const GENERIC_COLUMNS = [
  'referrer',
  'referrer_name',
  'referrer_type',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'region',
  'country',
  'city',
  'device',
  'brand',
  'model',
  'browser',
  'browser_version',
  'os',
  'os_version',
] as const;

export const group = 'overview';

export const cases: GoldenCase[] = [
  ...METRIC_WINDOWS.flatMap(([project, range, interval]) =>
    (['none', 'countrySE', 'pathDocs'] as const).map((filters) => ({
      name: `getMetrics ${project} ${range} ${interval} ${filters}`,
      run: () =>
        overviewService.getMetrics({
          ...window(project, range),
          interval,
          filters: FILTERS[filters],
        }),
    })),
  ),
  {
    name: 'getMetrics sthlm DST week hour',
    run: () =>
      overviewService.getMetrics({
        ...explicitWindow('sthlm', '2026-03-28 00:00:00', '2026-03-30 23:59:59'),
        interval: 'hour',
        filters: [],
      }),
  },
  {
    name: 'getMetrics ny DST day',
    run: () =>
      overviewService.getMetrics({
        ...explicitWindow('ny', '2026-03-01 00:00:00', '2026-03-15 23:59:59'),
        interval: 'day',
        filters: [],
      }),
  },
  ...(['none', 'countrySE', 'referrerGoogle', 'pathDocs'] as const).map((filters) => ({
    name: `getTopPages sthlm 30d ${filters}`,
    run: () =>
      overviewService.getTopPages({ ...window('sthlm', '30d'), filters: FILTERS[filters] }),
    unordered: [''],
  })),
  ...(['entry', 'exit'] as const).flatMap((mode) =>
    (['none', 'browserNotChrome'] as const).map((filters) => ({
      name: `getTopEntryExit sthlm 30d ${mode} ${filters}`,
      run: () =>
        overviewService.getTopEntryExit({
          ...window('sthlm', '30d'),
          mode,
          filters: FILTERS[filters],
        }),
      unordered: [''],
    })),
  ),
  ...GENERIC_COLUMNS.map((column) => ({
    name: `getTopGeneric sthlm 30d ${column}`,
    run: () =>
      overviewService.getTopGeneric({ ...window('sthlm', '30d'), column, filters: [] }),
    unordered: [''],
  })),
  ...(['referrer_name', 'country', 'browser'] as const).map((column) => ({
    name: `getTopGeneric ny 7d ${column} mobileInUS`,
    run: () =>
      overviewService.getTopGeneric({
        ...window('ny', '7d'),
        column,
        filters: FILTERS.mobileInUS,
      }),
    unordered: [''],
  })),
  ...(['referrer_name', 'country', 'device'] as const).map((column) => ({
    name: `getTopGenericSeries sthlm 30d day ${column}`,
    run: () =>
      overviewService.getTopGenericSeries({
        ...window('sthlm', '30d'),
        interval: 'day',
        column,
        filters: [],
      }),
    unordered: ['items', 'items.*.data'],
  })),
  {
    name: 'getUserJourney sthlm 30d 5',
    run: () =>
      overviewService.getUserJourney({ ...window('sthlm', '30d'), steps: 5, filters: [] }),
    unordered: ['nodes', 'links'],
  },
  {
    name: 'getUserJourney ny 12m 3 countrySE',
    run: () =>
      overviewService.getUserJourney({
        ...window('ny', '12m'),
        steps: 3,
        filters: FILTERS.countrySE,
      }),
    unordered: ['nodes', 'links'],
  },
  ...(['none', 'utmNewsletter'] as const).map((filters) => ({
    name: `getTopEvents sthlm 30d ${filters}`,
    run: () =>
      overviewService.getTopEvents({
        ...window('sthlm', '30d'),
        filters: FILTERS[filters],
        excludeEvents: ['session_start', 'session_end'],
      }),
    unordered: [''],
  })),
  {
    name: 'getTopLinkOut sthlm 30d',
    run: () => overviewService.getTopLinkOut({ ...window('sthlm', '30d'), filters: [] }),
    unordered: [''],
  },
  ...(['none', 'pathDocs'] as const).map((filters) => ({
    name: `getMapData sthlm 30d ${filters}`,
    run: () => overviewService.getMapData({ ...window('sthlm', '30d'), filters: FILTERS[filters] }),
    unordered: [''],
  })),
];
