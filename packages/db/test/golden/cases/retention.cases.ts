import { DateTime } from '@openpanel/common';
import type { IChartEventFilter, IChartRange } from '@openpanel/validation';

import { DATASET_COHORTS } from '../../fixtures/analytics-dataset';
import {
  type IRetentionCriteria,
  type IRetentionInterval,
  getEngagementCore,
  getRetentionCohort,
  getRetentionCohortCore,
  getRetentionLastSeenSeries,
  getRetentionSeries,
  getRollingActiveUsers,
  getRollingActiveUsersCore,
  getWeeklyRetentionSeriesCore,
} from '../../../src/services/retention.service';
import { GOLDEN_PROJECTS, type GoldenCase, type GoldenProjectKey } from '../harness';
import { FILTERS, window } from './common';

// getRetentionLastSeenSeries / getEngagementCore bucket by
// dateDiff('day', last_active, today()): the server's date, not the frozen
// anchor. The ported service has to measure against the anchor's (UTC) date.

function cohortFilter(
  operator: 'inCohort' | 'notInCohort',
  cohortId: string,
): IChartEventFilter {
  return { id: `cohort:${operator}`, name: 'cohort', operator, value: [], cohortIds: [cohortId] };
}

interface CohortOptions {
  firstEvent: string[];
  secondEvent: string[];
  criteria?: IRetentionCriteria;
  interval?: IRetentionInterval;
  filters?: IChartEventFilter[];
}

/** The input the tRPC `chart.cohort` procedure hands to getRetentionCohort. */
function cohortCase(
  name: string,
  project: GoldenProjectKey,
  range: IChartRange,
  options: CohortOptions,
): GoldenCase {
  return {
    name,
    run: () => {
      const { projectId, startDate, endDate } = window(project, range);
      return getRetentionCohort({ projectId, startDate, endDate, ...options });
    },
  };
}

const POWER_USERS = cohortFilter('inCohort', DATASET_COHORTS.powerUsers.id);
const NOT_FREE_PLAN = cohortFilter('notInCohort', DATASET_COHORTS.freePlan.id);

export const group = 'retention';

export const cases: GoldenCase[] = [
  // --- getRetentionCohort: events, criteria, intervals -------------------------------
  ...(['on_or_after', 'on'] as const).map((criteria) =>
    cohortCase(`getRetentionCohort sthlm 30d day session_start ${criteria}`, 'sthlm', '30d', {
      firstEvent: ['session_start'],
      secondEvent: ['session_start'],
      criteria,
      interval: 'day',
    }),
  ),
  cohortCase('getRetentionCohort sthlm 3m week screen_view on', 'sthlm', '3m', {
    firstEvent: ['screen_view'],
    secondEvent: ['screen_view'],
    criteria: 'on',
    interval: 'week',
  }),
  cohortCase('getRetentionCohort sthlm 12m month view>click', 'sthlm', '12m', {
    firstEvent: ['screen_view'],
    secondEvent: ['button_click'],
    interval: 'month',
  }),
  cohortCase('getRetentionCohort ny 30d day view>revenue,purchase', 'ny', '30d', {
    firstEvent: ['screen_view'],
    secondEvent: ['revenue', 'purchase'],
    interval: 'day',
  }),
  cohortCase('getRetentionCohort ny 3m week signup>screen_view', 'ny', '3m', {
    firstEvent: ['signup'],
    secondEvent: ['screen_view'],
    interval: 'week',
  }),
  cohortCase('getRetentionCohort ny 7d hour session_start', 'ny', '7d', {
    firstEvent: ['session_start'],
    secondEvent: ['session_start'],
    interval: 'hour',
  }),
  cohortCase('getRetentionCohort utc 30d day any activity', 'utc', '30d', {
    firstEvent: [],
    secondEvent: [],
    interval: 'day',
  }),
  cohortCase('getRetentionCohort utc 3m week click>link_out on', 'utc', '3m', {
    firstEvent: ['button_click'],
    secondEvent: ['link_out'],
    criteria: 'on',
    interval: 'week',
  }),
  cohortCase('getRetentionCohort sthlm 30d week view,click>purchase on', 'sthlm', '30d', {
    firstEvent: ['screen_view', 'button_click'],
    secondEvent: ['purchase'],
    criteria: 'on',
    interval: 'week',
  }),
  {
    name: 'getRetentionCohort sthlm last 8 full weeks week session_start',
    run: () => {
      // Sunday-to-Saturday weeks, like toStartOfWeek.
      const today = DateTime.now().setZone(GOLDEN_PROJECTS.sthlm.timezone).startOf('day');
      const sunday = today.minus({ days: today.weekday % 7 });
      return getRetentionCohort({
        projectId: GOLDEN_PROJECTS.sthlm.id,
        firstEvent: ['session_start'],
        secondEvent: ['session_start'],
        interval: 'week',
        startDate: sunday.minus({ weeks: 8 }).toFormat('yyyy-MM-dd HH:mm:ss'),
        endDate: sunday.minus({ seconds: 1 }).toFormat('yyyy-MM-dd HH:mm:ss'),
      });
    },
  },
  {
    name: 'getRetentionCohort utc ISO bounds day',
    run: () => {
      const today = DateTime.utc().startOf('day');
      return getRetentionCohort({
        projectId: GOLDEN_PROJECTS.utc.id,
        firstEvent: ['screen_view'],
        secondEvent: ['screen_view'],
        interval: 'day',
        startDate: today.minus({ days: 23 }).toISO()!,
        endDate: today.minus({ days: 10 }).endOf('day').set({ millisecond: 0 }).toISO()!,
      });
    },
  },
  {
    name: 'getRetentionCohort sthlm window without data',
    run: () =>
      getRetentionCohort({
        projectId: GOLDEN_PROJECTS.sthlm.id,
        firstEvent: ['session_start'],
        secondEvent: ['session_start'],
        interval: 'day',
        startDate: '2025-01-01 00:00:00',
        endDate: '2025-01-10 23:59:59',
      }),
  },

  // --- getRetentionCohort: audience filters -----------------------------------------------
  cohortCase('getRetentionCohort sthlm 30d week countrySE', 'sthlm', '30d', {
    firstEvent: ['session_start'],
    secondEvent: ['session_start'],
    interval: 'week',
    filters: FILTERS.countrySE,
  }),
  cohortCase('getRetentionCohort ny 3m week utm isNotNull', 'ny', '3m', {
    firstEvent: ['session_start'],
    secondEvent: ['screen_view'],
    interval: 'week',
    filters: [{ id: 'utm', name: 'properties.__query.utm_source', operator: 'isNotNull', value: [] }],
  }),
  cohortCase('getRetentionCohort sthlm 30d week inCohort power users', 'sthlm', '30d', {
    firstEvent: ['session_start'],
    secondEvent: ['session_start'],
    interval: 'week',
    filters: [POWER_USERS],
  }),
  cohortCase('getRetentionCohort sthlm 3m week notInCohort free plan', 'sthlm', '3m', {
    firstEvent: ['screen_view'],
    secondEvent: ['button_click'],
    interval: 'week',
    filters: [NOT_FREE_PLAN],
  }),
  cohortCase('getRetentionCohort sthlm 30d day inCohort and desktop', 'sthlm', '30d', {
    firstEvent: ['session_start'],
    secondEvent: ['session_start'],
    interval: 'day',
    filters: [POWER_USERS, { id: 'device', name: 'device', operator: 'is', value: ['desktop'] }],
  }),

  // --- getRetentionCohortCore (insights API / MCP): last 12 weeks, any activity ----------
  ...(['sthlm', 'ny'] as const).map((project) => ({
    name: `getRetentionCohortCore ${project}`,
    run: () => getRetentionCohortCore(GOLDEN_PROJECTS[project].id),
  })),

  // --- week-over-week retention ---------------------------------------------------------
  {
    name: 'getWeeklyRetentionSeriesCore sthlm',
    run: () => getWeeklyRetentionSeriesCore(GOLDEN_PROJECTS.sthlm.id),
  },
  {
    name: 'getRetentionSeries ny',
    run: () => getRetentionSeries({ projectId: GOLDEN_PROJECTS.ny.id }),
  },

  // --- rolling active users (GROUP BY date without ORDER BY) ---------------------------------
  ...(
    [
      ['sthlm', 1],
      ['sthlm', 30],
      ['ny', 14],
    ] as const
  ).map(([project, days]) => ({
    name: `getRollingActiveUsersCore ${project} ${days}d`,
    run: () => getRollingActiveUsersCore({ projectId: GOLDEN_PROJECTS[project].id, days }),
    unordered: ['series'],
  })),
  {
    name: 'getRollingActiveUsers utc 7d',
    run: () => getRollingActiveUsers({ projectId: GOLDEN_PROJECTS.utc.id, days: 7 }),
    unordered: [''],
  },

  // --- last seen / engagement ------------------------------------------------------------
  {
    name: 'getRetentionLastSeenSeries ny',
    run: () => getRetentionLastSeenSeries({ projectId: GOLDEN_PROJECTS.ny.id }),
  },
  ...(['sthlm', 'utc'] as const).map((project) => ({
    name: `getEngagementCore ${project}`,
    run: () => getEngagementCore(GOLDEN_PROJECTS[project].id),
  })),
];
