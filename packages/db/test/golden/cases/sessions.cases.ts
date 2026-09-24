import type { IChartEventFilter } from '@openpanel/validation';

import { DATASET_COHORTS } from '../../fixtures/analytics-dataset';
import {
  type GetSessionListOptions,
  getSessionDistinctValues,
  getSessionList,
  getSessionReplayChunksFrom,
  getSessionsCount,
  type IServiceSession,
  querySessionsCore,
  SESSION_DISTINCT_FIELDS,
  sessionService,
} from '../../../src/services/session.service';
import type { GoldenCase, GoldenContext } from '../harness';
import { cohortFilter, dayString, daysAgo, each, filter, pid, stablePage } from './events.cases';

/**
 * getSessionList orders by created_at only. Ties are sorted by id and ties
 * crossing the `take` edge are masked (see stablePage).
 */
async function stableSessionList(
  options: GetSessionListOptions,
  view?: (session: IServiceSession) => unknown,
) {
  const [result, extended] = await Promise.all([
    getSessionList(options),
    getSessionList({ ...options, take: options.take + 1 }),
  ]);
  return {
    items: stablePage(
      result.items,
      (session) => session.createdAt,
      (session) => session.id,
      { after: extended.items[options.take]?.createdAt },
      view,
    ),
    meta: result.meta,
  };
}

const compactSession = (session: IServiceSession) => ({
  id: session.id,
  createdAt: session.createdAt,
  profileId: session.profileId,
  entryPath: session.entryPath,
  exitPath: session.exitPath,
  referrerName: session.referrerName,
  isBounce: session.isBounce,
  screenViewCount: session.screenViewCount,
  eventCount: session.eventCount,
  duration: session.duration,
  revenue: session.revenue,
  groups: session.groups,
});

type ListInput = readonly [string, { filters?: IChartEventFilter[]; search?: string }];

/** The count and first rows of the last 30 days, like the sessions page. */
function filteredLists(ctx: GoldenContext, inputs: readonly ListInput[]) {
  return each(inputs, async (input) => {
    const scope = { projectId: pid('sthlm'), startDate: daysAgo(ctx, 30), endDate: ctx.anchor, ...input };
    return {
      count: await getSessionsCount(scope),
      list: await stableSessionList({ ...scope, take: 6 }, compactSession),
    };
  });
}

const SEARCHES: ListInput[] = ['docs', 'GOOGLE', 'github.com/openpanel', '%', '_', 'ö'].map((search) => [
  JSON.stringify(search),
  { search },
]);

const byFilters = (label: string, filters: IChartEventFilter[]): ListInput => [label, { filters }];

const SESSION_FILTERS: ListInput[] = [
  byFilters('is_bounce is true', [filter('session.is_bounce', 'is', ['true'])]),
  byFilters('is_bounce isNot true', [filter('session.is_bounce', 'isNot', ['true'])]),
  byFilters('screen_view_count gt 4', [filter('session.screen_view_count', 'gt', ['4'])]),
  byFilters('duration gte 600000', [filter('session.duration', 'gte', ['600000'])]),
  byFilters('revenue gt 0', [filter('session.revenue', 'gt', ['0'])]),
  byFilters('event_count is 3,4', [filter('session.event_count', 'is', ['3', '4'])]),
  byFilters('performed_event is revenue', [filter('session.performed_event', 'is', ['revenue'])]),
  byFilters('performed_event isNot button_click,link_out', [
    filter('session.performed_event', 'isNot', ['button_click', 'link_out']),
  ]),
];

const PROFILE_GROUP_COHORT_FILTERS: ListInput[] = [
  byFilters('profile plan is pro', [filter('profile.properties.plan', 'is', ['pro'])]),
  byFilters('profile email endsWith .se', [filter('profile.email', 'endsWith', ['.se'])]),
  byFilters('group name is Acme Inc', [filter('group.name', 'is', ['Acme Inc'])]),
  byFilters('group plan isNot enterprise', [filter('group.properties.plan', 'isNot', ['enterprise'])]),
  byFilters('inCohort powerUsers', [cohortFilter('inCohort', DATASET_COHORTS.powerUsers.id)]),
  byFilters('notInCohort freePlan and not bounced', [
    cohortFilter('notInCohort', DATASET_COHORTS.freePlan.id),
    filter('session.is_bounce', 'is', ['false']),
  ]),
  // Plain columns are not handled by buildFilterWhere: the filter is dropped.
  byFilters('country is XX (dropped)', [filter('country', 'is', ['XX'])]),
];

export const group = 'sessions';

export const cases: GoldenCase[] = [
  // --- getSessionList (trpc session.list): windows and cursors ------------------------
  {
    name: 'getSessionList sthlm default window',
    run: () => stableSessionList({ projectId: pid('sthlm'), take: 50, filters: [] }),
  },
  {
    name: 'getSessionList ny default window take 4',
    run: () => stableSessionList({ projectId: pid('ny'), take: 4 }),
  },
  {
    name: 'getSessionList utc cursor 2 days ago',
    run: (ctx) => stableSessionList({ projectId: pid('utc'), take: 20, cursor: daysAgo(ctx, 2) }),
  },
  {
    name: 'getSessionList sthlm cursor expands the window to the DST clusters',
    run: (ctx) => stableSessionList({ projectId: pid('sthlm'), take: 10, cursor: daysAgo(ctx, 150) }),
  },
  {
    name: 'getSessionList sthlm 7d range, two pages',
    run: async (ctx) => {
      const options = { projectId: pid('sthlm'), take: 25, startDate: daysAgo(ctx, 7), endDate: ctx.anchor };
      const first = await stableSessionList(options, compactSession);
      const second = first.meta.next
        ? await stableSessionList({ ...options, cursor: new Date(first.meta.next) }, compactSession)
        : null;
      return { first, second };
    },
  },
  {
    name: 'getSessionList ny DST day range',
    run: () =>
      stableSessionList({
        projectId: pid('ny'),
        take: 50,
        startDate: new Date('2026-03-08T00:00:00Z'),
        endDate: new Date('2026-03-08T23:59:59Z'),
      }),
  },
  {
    name: 'getSessionList profile scopes',
    run: async (ctx) => ({
      sthlmAlice: await stableSessionList({ projectId: pid('sthlm'), profileId: 'user-alice', take: 10 }),
      nyDevice30d: await stableSessionList(
        { projectId: pid('ny'), profileId: 'dev-gold-021', take: 50, startDate: daysAgo(ctx, 30), endDate: ctx.anchor },
        compactSession,
      ),
    }),
  },

  // --- getSessionList + getSessionsCount: search and filters -----------------------------
  {
    name: 'getSessionList sthlm 30d searches',
    run: (ctx) => filteredLists(ctx, SEARCHES),
  },
  {
    name: 'getSessionList sthlm 30d session filters',
    run: (ctx) => filteredLists(ctx, SESSION_FILTERS),
  },
  {
    name: 'getSessionList sthlm 30d profile, group and cohort filters',
    run: (ctx) => filteredLists(ctx, PROFILE_GROUP_COHORT_FILTERS),
  },
  {
    name: 'getSessionsCount scopes',
    run: async (ctx) => ({
      sthlmAll: await getSessionsCount({ projectId: pid('sthlm') }),
      nyAll: await getSessionsCount({ projectId: pid('ny') }),
      utc7d: await getSessionsCount({ projectId: pid('utc'), startDate: daysAgo(ctx, 7), endDate: ctx.anchor }),
      // Only a start date: no date condition at all.
      utcStartOnly: await getSessionsCount({ projectId: pid('utc'), startDate: daysAgo(ctx, 7) }),
      nyBob: await getSessionsCount({ projectId: pid('ny'), profileId: 'user-bob' }),
      nyBobSearchPricing: await getSessionsCount({ projectId: pid('ny'), profileId: 'user-bob', search: 'pricing' }),
      sthlmDstDay: await getSessionsCount({
        projectId: pid('sthlm'),
        startDate: new Date('2026-03-29T00:00:00Z'),
        endDate: new Date('2026-03-29T12:00:00Z'),
      }),
    }),
  },

  // --- replay chunks (trpc session.replayChunksFrom) ----------------------------------------
  {
    name: 'getSessionReplayChunksFrom sthlm replay session',
    run: (ctx) => {
      const sessionId = ctx.datasets.sthlm.replayChunks[0]!.session_id;
      return each(
        ([0, 1, 3] as const).map((fromIndex) => [`from ${fromIndex}`, fromIndex] as const),
        (fromIndex) => getSessionReplayChunksFrom(sessionId, pid('sthlm'), fromIndex),
      );
    },
  },
  {
    name: 'getSessionReplayChunksFrom misses',
    run: async (ctx) => ({
      noReplay: await getSessionReplayChunksFrom(ctx.datasets.ny.sessions[0]!.id, pid('ny'), 0),
      wrongProject: await getSessionReplayChunksFrom(
        ctx.datasets.utc.replayChunks.at(-1)!.session_id,
        pid('sthlm'),
        0,
      ),
    }),
  },

  // --- distinct values (trpc session.distinctValues) --------------------------------------------
  {
    name: 'getSessionDistinctValues sthlm',
    run: () =>
      each(
        SESSION_DISTINCT_FIELDS.map((field) => [field, field] as const),
        (field) => getSessionDistinctValues(pid('sthlm'), field),
      ),
    // ORDER BY count() DESC: equal counts tie.
    unordered: [...SESSION_DISTINCT_FIELDS],
  },
  {
    name: 'getSessionDistinctValues ny country and utc device',
    run: async () => ({
      nyCountry: await getSessionDistinctValues(pid('ny'), 'country'),
      utcDevice: await getSessionDistinctValues(pid('utc'), 'device'),
    }),
    unordered: ['nyCountry', 'utcDevice'],
  },

  // --- sessionService.byId (trpc session.byId, event details) --------------------------------
  {
    name: 'sessionService.byId sthlm replay session',
    run: (ctx) => sessionService.byId(ctx.datasets.sthlm.replayChunks[0]!.session_id, pid('sthlm')),
  },
  {
    name: 'sessionService.byId ny oldest session',
    run: (ctx) => sessionService.byId(ctx.datasets.ny.sessions[0]!.id, pid('ny')),
  },
  {
    name: 'sessionService.byId utc identified session',
    run: (ctx) => {
      const session = ctx.datasets.utc.sessions.findLast((row) => row.profile_id === 'user-alice');
      return sessionService.byId(session!.id, pid('utc'));
    },
  },
  {
    name: 'sessionService.byId unknown session',
    run: () => sessionService.byId('sess-does-not-exist', pid('sthlm')),
  },
  {
    name: 'sessionService.byId session of another project',
    run: (ctx) => sessionService.byId(ctx.datasets.sthlm.sessions.at(-1)!.id, pid('ny')),
  },

  // --- querySessionsCore (insights API / MCP): no ORDER BY, so each call keeps
  // --- its matches under the limit and is compared as a set.
  {
    name: 'querySessionsCore sthlm referrerName Reddit',
    run: () => querySessionsCore({ projectId: pid('sthlm'), referrerName: 'Reddit', limit: 100 }),
    unordered: [''],
  },
  {
    name: 'querySessionsCore column filters',
    run: async (ctx) => ({
      nyTabletIos: await querySessionsCore({ projectId: pid('ny'), device: 'tablet', os: 'iOS', limit: 100 }),
      utcGoteborg: await querySessionsCore({ projectId: pid('utc'), country: 'SE', city: 'Göteborg', limit: 100 }),
      sthlmFirefoxSearch: await querySessionsCore({
        projectId: pid('sthlm'),
        browser: 'Firefox',
        referrerType: 'search',
        limit: 100,
      }),
      nyTwitter: await querySessionsCore({
        projectId: pid('ny'),
        referrer: 'https://t.co/',
        startDate: dayString(ctx, 14),
        limit: 100,
      }),
    }),
    unordered: ['nyTabletIos', 'utcGoteborg', 'sthlmFirefoxSearch', 'nyTwitter'],
  },
  {
    name: 'querySessionsCore utc profile with the default limit',
    run: (ctx) => querySessionsCore({ projectId: pid('utc'), profileId: 'user-alice', startDate: dayString(ctx, 14) }),
    unordered: [''],
  },
  {
    name: 'querySessionsCore sthlm DST range bounce filter',
    run: () =>
      querySessionsCore({
        projectId: pid('sthlm'),
        startDate: '2026-03-28 00:00:00',
        endDate: '2026-03-30 00:00:00',
        filters: [filter('session.is_bounce', 'is', ['false'])],
        limit: 100,
      }),
    unordered: [''],
  },
  {
    name: 'querySessionsCore prefixed filters',
    run: async (ctx) => ({
      nyProfileAndGroup: await querySessionsCore({
        projectId: pid('ny'),
        filters: [
          filter('profile.properties.plan', 'is', ['free', 'pro']),
          filter('group.type', 'is', ['company']),
        ],
        startDate: dayString(ctx, 14),
        limit: 100,
      }),
      utcPerformedPurchase7d: await querySessionsCore({
        projectId: pid('utc'),
        startDate: dayString(ctx, 7),
        endDate: ctx.anchor.toISOString(),
        filters: [filter('session.performed_event', 'is', ['purchase'])],
        limit: 100,
      }),
    }),
    unordered: ['nyProfileAndGroup', 'utcPerformedPurchase7d'],
  },
];
