import type {
  EventBasedCohortDefinition,
  EventCriteria,
  IChartEventFilter,
  PropertyBasedCohortDefinition,
} from '@openpanel/validation';

import { DATASET_COHORTS } from '../../fixtures/analytics-dataset';
import {
  computeCohort,
  computeEventBasedCohort,
  computePropertyBasedCohort,
  countCohort,
  countEventBasedCohort,
  countPropertyBasedCohort,
  getCohortCount,
  getCohortEventsPerDay,
  getCohortMemberEvents,
  getCohortMemberRoutes,
  getCohortMembers,
  getProfilesInCohort,
  listCohortMemberProfiles,
} from '../../../src/services/cohort.service';
import type { IServiceProfile } from '../../../src/services/profile.service';
import type { GoldenCase, GoldenContext } from '../harness';
import { cohortFilter, dayString, each, filter, pid, stableLimit, stablePage } from './events.cases';

const { powerUsers, freePlan } = DATASET_COHORTS;

function events(operator: 'and' | 'or', ...criteria: EventCriteria[]): EventBasedCohortDefinition {
  return { type: 'event', criteria: { operator, events: criteria } };
}

function did(
  name: string,
  timeframe: EventCriteria['timeframe'],
  extra: Partial<Pick<EventCriteria, 'filters' | 'frequency'>> = {},
): EventCriteria {
  return { name, filters: [], timeframe, ...extra };
}

function properties(operator: 'and' | 'or', ...filters: IChartEventFilter[]): PropertyBasedCohortDefinition {
  return { type: 'property', criteria: { operator, properties: filters } };
}

const last = (value: '7d' | '30d' | '90d' | '180d' | '365d') => ({ type: 'relative', value }) as const;
const since2026 = { type: 'absolute', start: '2026-01-01' } as const;

type Labelled<T> = readonly (readonly [string, T])[];

/**
 * Count and members of each event definition in sthlm, the way the cohort
 * preview computes them (nothing is stored). Labels hold no dots: they are
 * `unordered` paths.
 */
function eventCohorts(ctx: GoldenContext, definitions: Labelled<(ctx: GoldenContext) => EventBasedCohortDefinition>) {
  return each(definitions, async (definition) => ({
    count: await countEventBasedCohort(pid('sthlm'), definition(ctx)),
    members: await computeEventBasedCohort(pid('sthlm'), definition(ctx)),
  }));
}

function propertyCohorts(definitions: Labelled<PropertyBasedCohortDefinition>) {
  return each(definitions, async (definition) => ({
    count: await countPropertyBasedCohort(pid('sthlm'), definition),
    members: await computePropertyBasedCohort(pid('sthlm'), definition),
  }));
}

const membersOf = (definitions: Labelled<unknown>) => definitions.map(([label]) => `${label}.members`);

const RELATIVE_AND_FREQUENCY: Labelled<(ctx: GoldenContext) => EventBasedCohortDefinition> = [
  ['revenue in 30d', () => events('and', did('revenue', last('30d')))],
  ['session_start in 180d', () => events('and', did('session_start', last('180d')))],
  ['screen views lte 10 in 7d', () => events('and', did('screen_view', last('7d'), { frequency: { operator: 'lte', count: 10 } }))],
  ['exactly 2 link outs in 90d', () => events('and', did('link_out', last('90d'), { frequency: { operator: 'eq', count: 2 } }))],
];

const ABSOLUTE: Labelled<(ctx: GoldenContext) => EventBasedCohortDefinition> = [
  ['signup since 2026', () => events('and', did('signup', since2026))],
  [
    'screen_view between 20 and 10 days ago',
    (ctx) => events('and', did('screen_view', { type: 'absolute', start: dayString(ctx, 20), end: dayString(ctx, 10) })),
  ],
];

const EVENT_PROPERTIES: Labelled<(ctx: GoldenContext) => EventBasedCohortDefinition> = [
  [
    'cta clicks gte 3 in 90d',
    () =>
      events('and', did('button_click', last('90d'), {
        filters: [filter('properties.button', 'is', ['cta'])],
        frequency: { operator: 'gte', count: 3 },
      })),
  ],
  [
    'purchase of sku-1 in 30d',
    () => events('and', did('purchase', last('30d'), { filters: [filter('properties.item.sku', 'is', ['sku-1'])] })),
  ],
  [
    'property operators',
    () =>
      events(
        'or',
        did('button_click', last('30d'), { filters: [filter('properties.button', 'isNot', ['footer'])] }),
        did('link_out', last('30d'), { filters: [filter('properties.href', 'contains', ['github'])] }),
        did('link_out', last('90d'), { filters: [filter('properties.href', 'doesNotContain', ['github', 'twitter'])] }),
        did('button_click', last('7d'), { filters: [filter('properties.price', 'is', ['9.99', '19'])] }),
      ),
  ],
];

const NEVER_AND_COMBINED: Labelled<(ctx: GoldenContext) => EventBasedCohortDefinition> = [
  ['never did revenue in 30d', () => events('and', did('revenue', last('30d'), { frequency: { operator: 'eq', count: 0 } }))],
  [
    'never clicked a free price in 365d',
    () =>
      events('and', did('button_click', last('365d'), {
        filters: [filter('properties.price', 'is', ['free'])],
        frequency: { operator: 'lte', count: 0 },
      })),
  ],
  ['revenue and signup in 180d', () => events('and', did('revenue', last('180d')), did('signup', last('180d')))],
  ['link_out or signup in 7d', () => events('or', did('link_out', last('7d')), did('signup', last('7d')))],
  [
    'never did revenue but signed up',
    () =>
      events(
        'and',
        did('revenue', last('90d'), { frequency: { operator: 'eq', count: 0 } }),
        did('signup', since2026),
      ),
  ],
];

const PROFILE_PROPERTIES: Labelled<PropertyBasedCohortDefinition> = [
  ['plan is pro', properties('and', filter('profile.properties.plan', 'is', ['pro']))],
  ['plan isNot free', properties('and', filter('profile.properties.plan', 'isNot', ['free']))],
  ['plan is free or enterprise', properties('and', filter('profile.properties.plan', 'is', ['free', 'enterprise']))],
  ['company name contains ac', properties('and', filter('profile.properties.company.name', 'contains', ['ac']))],
  [
    'device mobile and country SE',
    properties('and', filter('profile.properties.device', 'is', ['mobile']), filter('profile.properties.country', 'is', ['SE'])),
  ],
];

const PROFILE_COLUMNS: Labelled<PropertyBasedCohortDefinition> = [
  ['email endsWith se', properties('and', filter('profile.email', 'endsWith', ['.se']))],
  ['email doesNotContain example com', properties('and', filter('profile.email', 'doesNotContain', ['example.com']))],
  ['email isNotNull', properties('and', filter('profile.email', 'isNotNull', []))],
  ['first_name startsWith Ch', properties('and', filter('profile.first_name', 'startsWith', ['Ch']))],
  ['last_name endsWith son', properties('and', filter('profile.last_name', 'endsWith', ['son']))],
];

const COMPARISONS_AND_COMBINATIONS: Labelled<PropertyBasedCohortDefinition> = [
  ['age gt 35', properties('and', filter('profile.properties.age', 'gt', ['35']))],
  ['age lte 28', properties('and', filter('profile.properties.age', 'lte', ['28']))],
  ['age isNull', properties('and', filter('profile.properties.age', 'isNull', []))],
  [
    'enterprise or younger than 25',
    properties('or', filter('profile.properties.plan', 'is', ['enterprise']), filter('profile.properties.age', 'lt', ['25'])),
  ],
  [
    'pro at globex',
    properties('and', filter('profile.properties.plan', 'is', ['pro']), filter('profile.properties.company.name', 'is', ['globex'])),
  ],
  // A filter without values is skipped; with nothing left the cohort is empty.
  ['no values', properties('and', filter('profile.properties.plan', 'is', []))],
];

const byCreatedAt = (profile: IServiceProfile) => profile.createdAt;
const byId = (profile: IServiceProfile) => profile.id;
const ids = (profile: IServiceProfile) => profile.id;

type MemberListOptions = Parameters<typeof listCohortMemberProfiles>[0];

/** listCohortMemberProfiles orders by created_at only (see stablePage). */
async function memberList(options: MemberListOptions, view?: (profile: IServiceProfile) => unknown) {
  const result = await listCohortMemberProfiles(options);
  const offset = (options.cursor ?? 0) * options.take;
  const neighbour = async (at: number) =>
    at < 0
      ? undefined
      : (await listCohortMemberProfiles({ ...options, take: 1, cursor: at })).data[0]?.createdAt;
  return {
    count: result.count,
    data: stablePage(
      result.data,
      byCreatedAt,
      byId,
      { before: await neighbour(offset - 1), after: await neighbour(offset + options.take) },
      view,
    ),
  };
}

/** ORDER BY count DESC LIMIT n: ties sorted by `name`, masked at the limit. */
function countedRows<T extends { count: number }>(
  fetch: (limit: number) => Promise<T[]>,
  limit: number,
  name: (row: T) => string,
) {
  return stableLimit(fetch, limit, (row) => Number(row.count), name);
}

export const group = 'cohorts';

export const cases: GoldenCase[] = [
  // --- event-based definitions (cohort preview: count + compute, nothing stored) -------
  {
    name: 'event cohorts sthlm relative timeframes and frequency',
    run: (ctx) => eventCohorts(ctx, RELATIVE_AND_FREQUENCY),
    unordered: membersOf(RELATIVE_AND_FREQUENCY),
  },
  {
    name: 'event cohorts sthlm absolute timeframes',
    run: (ctx) => eventCohorts(ctx, ABSOLUTE),
    unordered: membersOf(ABSOLUTE),
  },
  {
    name: 'event cohorts sthlm event property filters',
    run: (ctx) => eventCohorts(ctx, EVENT_PROPERTIES),
    unordered: membersOf(EVENT_PROPERTIES),
  },
  {
    name: 'event cohorts sthlm never, and, or',
    run: (ctx) => eventCohorts(ctx, NEVER_AND_COMBINED),
    unordered: membersOf(NEVER_AND_COMBINED),
  },
  {
    name: 'event cohorts in the other projects',
    run: async (ctx) => ({
      nyRevenue30d: await computeEventBasedCohort(pid('ny'), RELATIVE_AND_FREQUENCY[0]![1](ctx)),
      utcCtaClicks: await computeEventBasedCohort(pid('utc'), EVENT_PROPERTIES[0]![1](ctx)),
      utcNeverRevenueCount: await countEventBasedCohort(pid('utc'), NEVER_AND_COMBINED[0]![1](ctx)),
    }),
    unordered: ['nyRevenue30d', 'utcCtaClicks'],
  },

  // --- property-based definitions --------------------------------------------------------
  {
    name: 'property cohorts sthlm profile properties',
    run: () => propertyCohorts(PROFILE_PROPERTIES),
    unordered: membersOf(PROFILE_PROPERTIES),
  },
  {
    name: 'property cohorts sthlm profile columns',
    run: () => propertyCohorts(PROFILE_COLUMNS),
    unordered: membersOf(PROFILE_COLUMNS),
  },
  {
    name: 'property cohorts sthlm comparisons and combinations',
    run: () => propertyCohorts(COMPARISONS_AND_COMBINATIONS),
    unordered: membersOf(COMPARISONS_AND_COMBINATIONS),
  },
  {
    name: 'property cohort with an unprefixed property name',
    // Profile columns are an allowlist; `properties.plan` is not on it.
    run: () => countPropertyBasedCohort(pid('sthlm'), properties('and', filter('properties.plan', 'is', ['pro']))),
  },

  // --- trpc cohort.preview: count + a sample of 10 ------------------------------------------
  {
    name: 'computeCohort/countCohort preview of small cohorts',
    run: async (ctx) => {
      const eventDefinition = events('and', did('signup', since2026));
      const propertyDefinition = properties('and', filter('profile.properties.plan', 'is', ['enterprise']));
      return {
        event: {
          count: await countCohort(pid('ny'), eventDefinition),
          sampleProfiles: await computeCohort(pid('ny'), eventDefinition, 10),
        },
        property: {
          count: await countCohort(pid('utc'), propertyDefinition),
          sampleProfiles: await computeCohort(pid('utc'), propertyDefinition, 10),
        },
        absoluteWithoutLimit: await computeCohort(pid('sthlm'), ABSOLUTE[1]![1](ctx)),
      };
    },
    unordered: ['event.sampleProfiles', 'property.sampleProfiles', 'absoluteWithoutLimit'],
  },
  {
    name: 'computeCohort preview of a large cohort (sample size only)',
    run: async (ctx) => {
      const definition = NEVER_AND_COMBINED[0]![1](ctx);
      const sample = await computeCohort(pid('sthlm'), definition, 10);
      return { count: await countCohort(pid('sthlm'), definition), sampleSize: sample.length };
    },
  },

  // --- stored membership ----------------------------------------------------------------------
  {
    name: 'getCohortMembers sthlm powerUsers',
    run: () => getCohortMembers(powerUsers.id, pid('sthlm')),
    // All members share matched_at.
    unordered: ['profileIds'],
  },
  {
    name: 'getCohortMembers sthlm freePlan pages (sizes only)',
    run: async () => {
      const first = await getCohortMembers(freePlan.id, pid('sthlm'), { limit: 2 });
      const rest = await getCohortMembers(freePlan.id, pid('sthlm'), { limit: 10, offset: 2 });
      const beyond = await getCohortMembers(freePlan.id, pid('sthlm'), { limit: 10, offset: 5 });
      return {
        first: { total: first.total, size: first.profileIds.length },
        rest: { total: rest.total, size: rest.profileIds.length },
        beyond,
      };
    },
  },
  {
    name: 'getCohortMembers ny members of the sthlm cohort definition',
    run: () => getCohortMembers(freePlan.id, pid('ny'), { limit: 100 }),
    unordered: ['profileIds'],
  },
  {
    name: 'getCohortMembers unknown cohort',
    run: () => getCohortMembers('0b4c6f1e-2f0a-4f4e-9d8a-6e2f7c1a9bff', pid('sthlm')),
  },
  {
    name: 'getCohortCount and getProfilesInCohort',
    run: async () => ({
      countSthlmPowerUsers: await getCohortCount(powerUsers.id, pid('sthlm')),
      countUtcFreePlan: await getCohortCount(freePlan.id, pid('utc')),
      countEmptyProject: await getCohortCount(freePlan.id, 'golden-none'),
      inSthlmPowerUsers: [...(await getProfilesInCohort(powerUsers.id, pid('sthlm')))].sort(),
      inNyFreePlan: [...(await getProfilesInCohort(freePlan.id, pid('ny')))].sort(),
    }),
  },

  // --- listCohortMemberProfiles (trpc cohort.listProfiles) -------------------------------------
  {
    name: 'listCohortMemberProfiles sthlm powerUsers (full rows)',
    run: () => memberList({ projectId: pid('sthlm'), cohortId: powerUsers.id, take: 50 }),
  },
  {
    name: 'listCohortMemberProfiles ny freePlan pages of one',
    // Past the last page the count comes back as 0 (count() OVER () of no rows).
    run: () =>
      each(
        [0, 1, 2, 3].map((cursor) => [`page ${cursor}`, cursor] as const),
        (cursor) => memberList({ projectId: pid('ny'), cohortId: freePlan.id, take: 1, cursor }, ids),
      ),
  },
  {
    name: 'listCohortMemberProfiles sthlm powerUsers searches',
    run: () =>
      each(
        ['hana', 'EXAMPLE.FR', 'Chloé Dupont', 'andersson alice', '%', 'bob'].map(
          (search) => [JSON.stringify(search), search] as const,
        ),
        (search) => memberList({ projectId: pid('sthlm'), cohortId: powerUsers.id, take: 50, search }, ids),
      ),
  },
  {
    name: 'listCohortMemberProfiles filters',
    run: async () => ({
      enterprise: await memberList(
        {
          projectId: pid('sthlm'),
          cohortId: powerUsers.id,
          take: 50,
          filters: [filter('profile.properties.plan', 'is', ['enterprise'])],
        },
        ids,
      ),
      globex: await memberList(
        {
          projectId: pid('utc'),
          cohortId: freePlan.id,
          take: 50,
          filters: [filter('group.name', 'is', ['Globex Corporation'])],
        },
        ids,
      ),
      notInTheOtherCohort: await memberList(
        {
          projectId: pid('ny'),
          cohortId: powerUsers.id,
          take: 50,
          filters: [cohortFilter('notInCohort', freePlan.id)],
        },
        ids,
      ),
      unknownCohort: await memberList({ projectId: pid('ny'), cohortId: 'nope', take: 50 }, ids),
    }),
  },

  // --- cohort insights (trpc cohort.mostEvents / eventsPerDay / popularRoutes) -------------------
  {
    name: 'getCohortMemberEvents',
    run: async () => ({
      sthlmPowerUsers: await countedRows(
        (limit) => getCohortMemberEvents(pid('sthlm'), powerUsers.id, limit),
        10,
        (row) => row.name,
      ),
      nyFreePlanTop2: await countedRows(
        (limit) => getCohortMemberEvents(pid('ny'), freePlan.id, limit),
        2,
        (row) => row.name,
      ),
    }),
  },
  {
    name: 'getCohortEventsPerDay sthlm powerUsers 30 days',
    run: () => getCohortEventsPerDay(pid('sthlm'), powerUsers.id),
  },
  {
    name: 'getCohortEventsPerDay ny freePlan 7 days',
    run: () => getCohortEventsPerDay(pid('ny'), freePlan.id, 7),
  },
  {
    name: 'getCohortMemberRoutes',
    run: async () => ({
      sthlmPowerUsers: await countedRows(
        (limit) => getCohortMemberRoutes(pid('sthlm'), powerUsers.id, limit),
        10,
        (row) => row.path,
      ),
      utcFreePlanTop3: await countedRows(
        (limit) => getCohortMemberRoutes(pid('utc'), freePlan.id, limit),
        3,
        (row) => row.path,
      ),
    }),
  },
];
