import {
  findGroupsCore,
  getGroupById,
  getGroupCore,
  getGroupList,
  getGroupListCount,
  getGroupMemberProfiles,
  getGroupPropertyKeys,
  getGroupStats,
  getGroupsByIds,
  getGroupTypes,
  listGroupTypesCore,
} from '../../../src/services/group.service';
import type { IServiceProfile } from '../../../src/services/profile.service';
import type { GoldenCase } from '../harness';
import { each, pid, stablePage } from './events.cases';

type GroupListOptions = Parameters<typeof getGroupList>[0];
type MemberOptions = Parameters<typeof getGroupMemberProfiles>[0];

/** What trpc group.list reads: the page, the matching count and the stats. */
async function groupList(options: GroupListOptions) {
  const [data, count] = await Promise.all([getGroupList(options), getGroupListCount(options)]);
  const stats = await getGroupStats(
    options.projectId,
    data.map((group) => group.id),
  );
  return {
    count,
    data: data.map((group) => ({
      ...group,
      memberCount: stats.get(group.id)?.memberCount ?? 0,
      lastActiveAt: stats.get(group.id)?.lastActiveAt ?? null,
    })),
  };
}

/** Group ids of a page (created_at DESC; the groups never tie on it). */
async function groupIds(options: GroupListOptions) {
  return {
    count: await getGroupListCount(options),
    ids: (await getGroupList(options)).map((group) => group.id),
  };
}

const byCreatedAt = (profile: IServiceProfile) => profile.createdAt;
const byId = (profile: IServiceProfile) => profile.id;
const ids = (profile: IServiceProfile) => profile.id;

/**
 * getGroupMemberProfiles orders members by created_at only: ties are sorted
 * by id and ties crossing the page edges are masked (see stablePage).
 */
async function members(options: MemberOptions, view?: (profile: IServiceProfile) => unknown) {
  const result = await getGroupMemberProfiles(options);
  const offset = (options.cursor ?? 0) * options.take;
  const neighbour = async (at: number) =>
    at < 0
      ? undefined
      : (await getGroupMemberProfiles({ ...options, take: 1, cursor: at })).data[0]?.createdAt;
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

export const group = 'groups';

export const cases: GoldenCase[] = [
  // --- getGroupById / getGroupsByIds (trpc group.byId / listByIds) ------------------------
  {
    name: 'getGroupById sthlm acme',
    run: () => getGroupById('acme', pid('sthlm')),
  },
  {
    name: 'getGroupById ny team-growth',
    run: () => getGroupById('team-growth', pid('ny')),
  },
  {
    name: 'getGroupById misses',
    run: async () => ({
      unknown: await getGroupById('umbrella', pid('sthlm')),
      quoted: await getGroupById("acme' OR '1'='1", pid('sthlm')),
      wrongProject: await getGroupById('acme', 'golden-none'),
    }),
  },
  {
    name: 'getGroupsByIds utc',
    run: async () => ({
      some: await getGroupsByIds(pid('utc'), ['acme', 'team-growth', 'umbrella', 'acme']),
      none: await getGroupsByIds(pid('utc'), []),
    }),
    unordered: ['some'],
  },

  // --- getGroupList / getGroupListCount / getGroupStats (trpc group.list) ---------------------
  {
    name: 'getGroupList sthlm all with stats',
    run: () => groupList({ projectId: pid('sthlm'), take: 50 }),
  },
  {
    name: 'getGroupList ny companies with stats',
    run: () => groupList({ projectId: pid('ny'), take: 50, type: 'company' }),
  },
  {
    name: 'getGroupList utc types',
    run: async () => ({
      team: await groupIds({ projectId: pid('utc'), take: 50, type: 'team' }),
      unknown: await groupIds({ projectId: pid('utc'), take: 50, type: 'nope' }),
    }),
  },
  {
    name: 'getGroupList sthlm searches',
    run: async () => ({
      ...(await each(
        ['ac', 'CORP', 'growth', 'in', 'Acme Inc', '%', '_', "'", 'ö'].map(
          (search) => [JSON.stringify(search), search] as const,
        ),
        (search) => groupIds({ projectId: pid('sthlm'), take: 50, search }),
      )),
      growthWithinCompanies: await groupIds({ projectId: pid('sthlm'), take: 50, search: 'growth', type: 'company' }),
    }),
  },
  {
    name: 'getGroupList pagination',
    run: async () => ({
      nyPagesOfOne: await each(
        [0, 1, 2, 3, 4].map((cursor) => [`page ${cursor}`, cursor] as const),
        (cursor) => groupIds({ projectId: pid('ny'), take: 1, cursor }),
      ),
      utcSecondPageOfThree: await groupIds({ projectId: pid('utc'), take: 3, cursor: 1 }),
    }),
  },
  {
    name: 'findGroupsCore',
    run: async () => ({
      defaults: await findGroupsCore({ projectId: pid('sthlm') }),
      companies: await findGroupsCore({ projectId: pid('ny'), type: 'company', limit: 2 }),
      search: await findGroupsCore({ projectId: pid('utc'), search: 'i', limit: 20 }),
    }),
  },

  // --- types, keys, stats ---------------------------------------------------------------
  {
    name: 'getGroupTypes / listGroupTypesCore',
    run: async () => ({
      sthlm: await getGroupTypes(pid('sthlm')),
      ny: await listGroupTypesCore(pid('ny')),
      unknown: await listGroupTypesCore('golden-none'),
    }),
    unordered: ['sthlm', 'ny.types'],
  },
  {
    name: 'getGroupPropertyKeys',
    run: async () => ({
      sthlm: await getGroupPropertyKeys(pid('sthlm')),
      unknown: await getGroupPropertyKeys('golden-none'),
    }),
  },
  {
    name: 'getGroupStats sthlm',
    run: async () =>
      Object.fromEntries(
        await getGroupStats(pid('sthlm'), ['acme', 'globex', 'initech', 'team-growth', 'umbrella']),
      ),
  },
  {
    name: 'getGroupStats ny subset and empty',
    run: async () => ({
      subset: Object.fromEntries(await getGroupStats(pid('ny'), ['globex'])),
      empty: Object.fromEntries(await getGroupStats(pid('ny'), [])),
    }),
  },

  // --- members (trpc group.listProfiles) --------------------------------------------------------
  {
    name: 'getGroupMemberProfiles sthlm acme (full rows)',
    run: () => members({ projectId: pid('sthlm'), groupId: 'acme', take: 50 }),
  },
  {
    name: 'getGroupMemberProfiles ny acme pages of one',
    // Past the last page the count comes back as 0 (count() OVER () of no rows).
    run: () =>
      each(
        [0, 1, 2, 3].map((cursor) => [`page ${cursor}`, cursor] as const),
        (cursor) => members({ projectId: pid('ny'), groupId: 'acme', take: 1, cursor }, ids),
      ),
  },
  {
    name: 'getGroupMemberProfiles sthlm acme searches',
    run: () =>
      each(
        ['alice', 'EXAMPLE.JP', 'dupont', 'Chloé', 'user-alice', '  hana  ', '%'].map(
          (search) => [JSON.stringify(search), search] as const,
        ),
        (search) => members({ projectId: pid('sthlm'), groupId: 'acme', take: 50, search }, ids),
      ),
  },
  {
    name: 'getGroupMemberProfiles utc other groups',
    run: async () => ({
      globex: await members({ projectId: pid('utc'), groupId: 'globex', take: 50 }, ids),
      initech: await members({ projectId: pid('utc'), groupId: 'initech', take: 50 }, ids),
      team: await members({ projectId: pid('utc'), groupId: 'team-growth', take: 50 }, ids),
      unknown: await members({ projectId: pid('utc'), groupId: 'umbrella', take: 50 }, ids),
    }),
  },

  // --- getGroupCore (insights getGroup) -------------------------------------------------------------
  {
    name: 'getGroupCore sthlm acme two members',
    run: async () => {
      const core = await getGroupCore({ projectId: pid('sthlm'), groupId: 'acme', memberLimit: 2 });
      const next = await getGroupMemberProfiles({ projectId: pid('sthlm'), groupId: 'acme', take: 1, cursor: 2 });
      return {
        ...core,
        members: stablePage(core.members, byCreatedAt, byId, { after: next.data[0]?.createdAt }),
      };
    },
  },
  {
    name: 'getGroupCore ny team-growth default limit',
    run: () => getGroupCore({ projectId: pid('ny'), groupId: 'team-growth' }),
  },
  {
    name: 'getGroupCore unknown group',
    run: () => getGroupCore({ projectId: pid('ny'), groupId: 'umbrella' }),
  },
];
