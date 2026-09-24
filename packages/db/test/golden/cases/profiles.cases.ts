import type { IChartEventFilter } from '@openpanel/validation';

import { DATASET_COHORTS } from '../../fixtures/analytics-dataset';
import {
  type FindProfilesInput,
  findProfilesCore,
  getProfileById,
  getProfileList,
  getProfileListCount,
  getProfileMetrics,
  getProfileMetricsCore,
  getProfilePropertyKeys,
  getProfileSessionsCore,
  getProfileWithEvents,
  getProfiles,
  type IServiceProfile,
} from '../../../src/services/profile.service';
import type { GoldenCase } from '../harness';
import { cohortFilter, daysAgo, each, filter, pid, stableLimit, stablePage } from './events.cases';

type ProfileListOptions = Parameters<typeof getProfileList>[0];

const byCreatedAt = (profile: IServiceProfile) => profile.createdAt;
const byId = (profile: { id: string }) => profile.id;
const ids = (profile: IServiceProfile) => profile.id;

/**
 * getProfileList orders by created_at only, and an identified user usually
 * shares created_at with the device it was first seen on. Ties are sorted by
 * id; ties crossing the page edges (found with one-row pages around it) are
 * masked, see stablePage.
 */
async function stableProfileList(
  options: ProfileListOptions,
  view?: (profile: IServiceProfile) => unknown,
) {
  const rows = await getProfileList(options);
  const offset = (options.cursor ?? 0) * options.take;
  const neighbour = async (at: number) =>
    at < 0 ? undefined : (await getProfileList({ ...options, take: 1, cursor: at }))[0]?.createdAt;
  return stablePage(
    rows,
    byCreatedAt,
    byId,
    { before: await neighbour(offset - 1), after: await neighbour(offset + options.take) },
    view,
  );
}

/** What trpc profile.list returns: the page and the matching count. */
async function profileList(options: ProfileListOptions, view?: (profile: IServiceProfile) => unknown) {
  return {
    count: await getProfileListCount(options),
    data: await stableProfileList(options, view),
  };
}

/** Matching ids for each search string (sthlm, one page of 50). */
function searches(values: string[]) {
  return each(
    values.map((search) => [JSON.stringify(search), search] as const),
    (search) => profileList({ projectId: pid('sthlm'), take: 50, search }, ids),
  );
}

/** Matching ids for each filter set (sthlm, one page of 50). */
function filtered(inputs: [string, IChartEventFilter[]][]) {
  return each(inputs, (filters) => profileList({ projectId: pid('sthlm'), take: 50, filters }, ids));
}

/** findProfilesCore rows (raw, created_at text), ties broken by id. */
function findProfiles(input: FindProfilesInput & { limit: number }) {
  return stableLimit(
    (limit) => findProfilesCore({ ...input, limit }),
    Math.min(input.limit, 100),
    (row) => row.created_at,
    byId,
  );
}

export const group = 'profiles';

export const cases: GoldenCase[] = [
  // --- getProfileById / getProfiles ---------------------------------------------------
  {
    name: 'getProfileById sthlm user-alice',
    run: () => getProfileById('user-alice', pid('sthlm')),
  },
  {
    name: 'getProfileById ny user-chloe',
    run: () => getProfileById('user-chloe', pid('ny')),
  },
  {
    name: 'getProfileById utc anonymous device',
    run: () => getProfileById('dev-gold-000', pid('utc')),
  },
  {
    name: 'getProfileById misses',
    run: async () => ({
      unknown: await getProfileById('user-zed', pid('sthlm')),
      emptyId: await getProfileById('', pid('sthlm')),
      emptyProject: await getProfileById('user-alice', ''),
      quoted: await getProfileById("user-alice' OR '1'='1", pid('sthlm')),
    }),
  },
  {
    name: 'getProfiles',
    run: async () => ({
      mixed: await getProfiles(
        ['user-alice', 'user-bob', '', 'nope', 'user-alice', 'dev-gold-005', 'dev-gold-031'],
        pid('sthlm'),
      ),
      empty: await getProfiles(['', ''], pid('ny')),
    }),
    unordered: ['mixed'],
  },

  // --- getProfileList / getProfileListCount (trpc profile.list) ---------------------------
  {
    name: 'getProfileList sthlm all (full rows)',
    run: () => profileList({ projectId: pid('sthlm'), take: 50, filters: [] }),
  },
  {
    name: 'getProfileList ny identified (full rows)',
    run: () => profileList({ projectId: pid('ny'), take: 50, isExternal: true }),
  },
  {
    name: 'getProfileList utc anonymous',
    run: () => profileList({ projectId: pid('utc'), take: 50, isExternal: false }, ids),
  },
  {
    name: 'getProfileList sthlm pages of 10',
    run: async () => {
      const pages: unknown[] = [];
      for (const cursor of [0, 1, 2, 3, 4, 5]) {
        pages.push(await profileList({ projectId: pid('sthlm'), take: 10, cursor }, ids));
      }
      return pages;
    },
  },
  {
    name: 'getProfileList ny identified pages of 3',
    run: async () => {
      const pages: unknown[] = [];
      for (const cursor of [0, 1, 2]) {
        pages.push(await profileList({ projectId: pid('ny'), take: 3, cursor, isExternal: true }, ids));
      }
      return pages;
    },
  },
  {
    name: 'getProfileList sthlm search names and tokens',
    run: () =>
      searches([
        'alice',
        'Alice Andersson',
        'andersson ALICE',
        '  hana  ',
        // Every token has to match: "globex" is no profile field.
        'eve smith globex',
        // Only the first five tokens count: "zzz" would match nobody.
        'alice andersson example com user zzz',
        'user-farah',
        'dev-gold-03',
      ]),
  },
  {
    name: 'getProfileList sthlm search case and unicode',
    run: () => searches(['Chloé', 'CHLOÉ', 'chloe', 'öberg', 'ÖBERG', 'EXAMPLE.JP']),
  },
  {
    name: 'getProfileList sthlm search special characters',
    run: () => searches(["O'Brien", "o'b", '%', '_', '', "'; DROP TABLE profiles; --", '"', '-gold-']),
  },
  {
    name: 'getProfileList sthlm property filters',
    run: () =>
      filtered([
        ['plan is pro', [filter('profile.properties.plan', 'is', ['pro'])]],
        ['plan isNot free,pro', [filter('profile.properties.plan', 'isNot', ['free', 'pro'])]],
        ['company name is acme', [filter('profile.properties.company.name', 'is', ['acme'])]],
        ['email contains EXAMPLE.COM', [filter('profile.email', 'contains', ['EXAMPLE.COM'])]],
        ['last_name startsWith O', [filter('profile.last_name', 'startsWith', ['O'])]],
        ['first_name isNull', [filter('profile.first_name', 'isNull', [])]],
        ['city isNotNull and device mobile', [filter('profile.properties.city', 'isNotNull', []), filter('profile.properties.device', 'is', ['mobile'])]],
        ['os regex', [filter('profile.properties.os', 'regex', ['^(iOS|Android)$'])]],
        // Unprefixed properties are event filters: dropped on profiles.
        ['properties.plan is pro (dropped)', [filter('properties.plan', 'is', ['pro'])]],
      ]),
  },
  {
    name: 'getProfileList sthlm comparison filters',
    run: (ctx) =>
      filtered([
        // Untyped comparison of the property text: '34' > '4' is false.
        ['age gt 4 as text', [filter('profile.properties.age', 'gt', ['4'])]],
        ['age gt 4 as number', [filter('profile.properties.age', 'gt', ['4'], { type: 'number' })]],
        ['age lte 30 as number', [filter('profile.properties.age', 'lte', [30], { type: 'number' })]],
        ['created_at gte 56 days ago as datetime', [filter('profile.created_at', 'gte', [daysAgo(ctx, 56).toISOString()], { type: 'datetime' })]],
      ]),
  },
  {
    name: 'getProfileList sthlm group and cohort filters',
    run: () =>
      filtered([
        ['group name is Globex Corporation', [filter('group.name', 'is', ['Globex Corporation'])]],
        ['group type is company', [filter('group.type', 'is', ['company'])]],
        ['group seats gt 10 as number', [filter('group.properties.seats', 'gt', ['10'], { type: 'number' })]],
        ['inCohort powerUsers', [cohortFilter('inCohort', DATASET_COHORTS.powerUsers.id)]],
        ['notInCohort freePlan', [cohortFilter('notInCohort', DATASET_COHORTS.freePlan.id)]],
      ]),
  },
  {
    name: 'getProfileList ny search + isExternal + filter',
    run: () =>
      profileList(
        {
          projectId: pid('ny'),
          take: 50,
          search: 'example',
          isExternal: true,
          filters: [filter('profile.properties.plan', 'is', ['free', 'enterprise'])],
        },
        ids,
      ),
  },

  // --- profile metrics (trpc profile.metrics, insights getProfileMetrics) ----------------
  {
    name: 'getProfileMetrics sthlm user-alice',
    run: () => getProfileMetrics('user-alice', pid('sthlm')),
  },
  {
    name: 'getProfileMetrics ny anonymous device',
    run: () => getProfileMetrics('dev-gold-021', pid('ny')),
  },
  {
    name: 'getProfileMetrics utc unknown profile',
    run: () => getProfileMetrics('user-zed', pid('utc')),
  },
  {
    name: 'getProfileMetricsCore',
    run: async () => ({
      nyBob: await getProfileMetricsCore({ projectId: pid('ny'), profileId: 'user-bob' }),
      sthlmDstVisitor: await getProfileMetricsCore({ projectId: pid('sthlm'), profileId: 'dev-gold-030' }),
    }),
  },

  // --- findProfilesCore (insights API / MCP) --------------------------------------------------
  {
    name: 'findProfilesCore sthlm defaults',
    run: () => findProfiles({ projectId: pid('sthlm'), limit: 20 }),
  },
  {
    name: 'findProfilesCore ny oldest first',
    run: () => findProfiles({ projectId: pid('ny'), sortOrder: 'asc', limit: 5 }),
  },
  {
    name: 'findProfilesCore sthlm name and email',
    run: async () => ({
      name: await findProfiles({ projectId: pid('sthlm'), name: 'Gustav Öberg', limit: 20 }),
      email: await findProfiles({ projectId: pid('sthlm'), email: 'EXAMPLE.SE', limit: 20 }),
      both: await findProfiles({ projectId: pid('sthlm'), name: 'a', email: 'example.com', limit: 20 }),
    }),
  },
  {
    name: 'findProfilesCore utc profile properties',
    run: async () => ({
      country: await findProfiles({ projectId: pid('utc'), country: 'SE', limit: 100 }),
      city: await findProfiles({ projectId: pid('utc'), city: 'Göteborg', limit: 100 }),
      device: await findProfiles({ projectId: pid('utc'), device: 'mobile', browser: 'Mobile Safari', limit: 100 }),
    }),
  },
  {
    name: 'findProfilesCore activity conditions',
    run: async () => ({
      sthlmInactive10d: await findProfiles({ projectId: pid('sthlm'), inactiveDays: 10, limit: 100 }),
      nyMinSessions14: await findProfiles({ projectId: pid('ny'), minSessions: 14, limit: 100 }),
      utcPerformedSignup: await findProfiles({ projectId: pid('utc'), performedEvent: 'signup', limit: 100 }),
    }),
  },
  {
    name: 'findProfilesCore sthlm filters and a capped limit',
    run: () =>
      findProfiles({
        projectId: pid('sthlm'),
        filters: [filter('profile.properties.plan', 'is', ['enterprise', 'free'])],
        sortOrder: 'asc',
        limit: 500,
      }),
  },
  {
    name: 'findProfilesCore ny combined',
    run: () =>
      findProfiles({ projectId: pid('ny'), country: 'US', device: 'desktop', minSessions: 5, limit: 100 }),
  },

  // --- getProfileWithEvents / getProfileSessionsCore (insights API / MCP) ------------------------
  {
    name: 'getProfileWithEvents sthlm user-alice 10 events',
    run: async () => {
      const result = await getProfileWithEvents(pid('sthlm'), 'user-alice', 10);
      return {
        profile: result.profile,
        recent_events: await stableLimit(
          async (limit) => (await getProfileWithEvents(pid('sthlm'), 'user-alice', limit)).recent_events,
          10,
          (event) => event.created_at,
          byId,
        ),
      };
    },
  },
  {
    name: 'getProfileWithEvents ny anonymous device and unknown profile',
    run: async () => {
      const device = await getProfileWithEvents(pid('ny'), 'dev-gold-021', 100);
      return {
        device: {
          profile: device.profile,
          recent_events: await stableLimit(
            async (limit) => (await getProfileWithEvents(pid('ny'), 'dev-gold-021', limit)).recent_events,
            100,
            (event) => event.created_at,
            byId,
            (event) => ({ id: event.id, name: event.name, created_at: event.created_at, session_id: event.session_id }),
          ),
        },
        unknown: await getProfileWithEvents(pid('ny'), 'user-zed'),
      };
    },
  },
  {
    name: 'getProfileSessionsCore',
    run: async () => ({
      utcHana5: await stableLimit(
        (limit) => getProfileSessionsCore(pid('utc'), 'user-hana', limit),
        5,
        (session) => session.created_at,
        byId,
      ),
      sthlmDstVisitor: await stableLimit(
        (limit) => getProfileSessionsCore(pid('sthlm'), 'dev-gold-030', limit),
        20,
        (session) => session.created_at,
        byId,
      ),
    }),
  },

  // --- property keys (chart property picker) --------------------------------------------------
  {
    name: 'getProfilePropertyKeys',
    run: async () => ({
      sthlm: await getProfilePropertyKeys(pid('sthlm')),
      ny: await getProfilePropertyKeys(pid('ny')),
      unknown: await getProfilePropertyKeys('golden-none'),
    }),
  },
];
