/**
 * The filter layer executed on Postgres against the cases in
 * test/fixtures/filter-cases.ts, whose expected matches were recorded from
 * the ClickHouse builders it replaces.
 */
import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  COHORT_1,
  EVENT_FILTER_CASES,
  FILTER_COHORT_MEMBERS,
  FILTER_DATE_SCOPE,
  FILTER_EVENTS,
  FILTER_GROUPS,
  FILTER_PROFILES,
  FILTER_PROJECT,
  FILTER_SESSIONS,
  FILTER_TIMEZONE,
  PREFIXED_FILTER_CASES,
  eventUuid,
  shortEventId,
} from '../../test/fixtures/filter-cases';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import { anQuery } from './client';
import { collectProfilePropertyKeys } from './fields';
import {
  type EventFilterScope,
  GROUP_JOIN,
  allCohortsLabelExpr,
  allCohortsMembershipQuery,
  cohortJoin,
  cohortAlias,
  eventFilterClauses,
  eventPropertyExpr,
  groupColumnExpr,
  groupJoin,
  narrowProfileScope,
  narrowedProfileSelect,
  prefixedFilterClauses,
  profileColumnExpr,
  profileJoin,
} from './filters';
import { type Sql, and, raw, sql } from './sql';
import {
  type CohortMemberWriteRow,
  type EventWriteRow,
  type GroupWriteRow,
  type ProfileWriteRow,
  type SessionWriteRow,
  insertCohortMembers,
  insertEvents,
  upsertGroups,
  upsertProfiles,
  upsertSessions,
} from './writers';

let testDb: TestDatabase;

function query<T extends Record<string, unknown>>(fragment: Sql) {
  return runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, () =>
    anQuery<T>(fragment),
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, async () => {
    await insertEvents(FILTER_EVENTS as EventWriteRow[]);
    await upsertProfiles(FILTER_PROFILES as ProfileWriteRow[]);
    await upsertGroups(FILTER_GROUPS as GroupWriteRow[]);
    await upsertSessions(FILTER_SESSIONS as SessionWriteRow[]);
    await insertCohortMembers(FILTER_COHORT_MEMBERS as CohortMemberWriteRow[]);
  });
});

afterAll(async () => {
  await testDb?.drop();
});

const baseScope: EventFilterScope = {
  projectId: FILTER_PROJECT,
  timezone: FILTER_TIMEZONE,
  alias: 'e',
};

function label(filter: { name: string; operator: string; value: unknown; type?: string }) {
  return `${filter.name} ${filter.operator}${filter.type ? `:${filter.type}` : ''} ${JSON.stringify(filter.value)}`;
}

async function eventIds(where: Sql, joins: Sql = raw('')): Promise<string[]> {
  const rows = await query<{ id: string }>(
    sql`SELECT DISTINCT e.id FROM analytics.events e ${joins} WHERE e.project_id = ${FILTER_PROJECT} AND ${where}`,
  );
  return rows.map((row) => shortEventId(row.id)).sort();
}

describe('eventFilterClauses (ClickHouse getEventFiltersWhereClause cases)', () => {
  it.each(EVENT_FILTER_CASES.map((testCase) => [label(testCase.filter), testCase] as const))(
    '%s',
    async (_, { filter, expected }) => {
      const joinsProfile = filter.name.startsWith('profile.');
      const scope: EventFilterScope = joinsProfile
        ? { ...baseScope, profileAlias: 'profile' }
        : baseScope;
      const joins = joinsProfile ? profileJoin(scope) : raw('');
      expect(await eventIds(and(eventFilterClauses([filter], scope)), joins)).toEqual(expected);
      if (joinsProfile) {
        // Without the join, profile.* reads the profile through a lookup.
        expect(await eventIds(and(eventFilterClauses([filter], baseScope)))).toEqual(expected);
      }
    },
  );

  it('reads group.* from a group join the same way (rows per group id)', async () => {
    const scope: EventFilterScope = { ...baseScope, groupJoin: GROUP_JOIN };
    for (const { filter, expected } of EVENT_FILTER_CASES) {
      if (!filter.name.startsWith('group.')) {
        continue;
      }
      expect(
        await eventIds(and(eventFilterClauses([filter], scope)), groupJoin(scope)),
        label(filter),
      ).toEqual(expected);
    }
  });
});

describe('prefixedFilterClauses (ClickHouse buildFilterWhere cases)', () => {
  const tables = {
    events: raw('analytics.events'),
    sessions: raw('analytics.sessions'),
    profiles: raw('analytics.profiles'),
  };
  it.each(
    PREFIXED_FILTER_CASES.map((testCase) => [`${testCase.table}: ${label(testCase.filter)}`, testCase] as const),
  )('%s', async (_, { table, filter, expected }) => {
    const clauses = prefixedFilterClauses([filter], {
      projectId: FILTER_PROJECT,
      timezone: FILTER_TIMEZONE,
      table,
      alias: 't',
      ...FILTER_DATE_SCOPE,
    });
    const rows = await query<{ id: string }>(
      sql`SELECT t.id FROM ${tables[table]} t WHERE t.project_id = ${FILTER_PROJECT} AND ${and(clauses)}`,
    );
    const ids = rows.map((row) => (table === 'events' ? shortEventId(row.id) : row.id)).sort();
    expect(ids).toEqual(expected);
  });
});

describe('expressions', () => {
  async function values(expression: Sql, joins: Sql = raw('')) {
    const rows = await query<{ id: string; value: unknown }>(
      sql`SELECT e.id, ${expression} AS value FROM analytics.events e ${joins} WHERE e.project_id = ${FILTER_PROJECT} ORDER BY e.id`,
    );
    return Object.fromEntries(rows.map((row) => [shortEventId(row.id), row.value]));
  }

  it('reads columns, properties and wildcard values', async () => {
    expect(await values(eventPropertyExpr('referrerName', baseScope))).toMatchObject({
      e2: 'Google',
      e3: '',
    });
    expect(await values(eventPropertyExpr('utm_source', baseScope))).toMatchObject({
      e2: 'reddit',
      e6: 'newsletter',
      e1: '',
    });
    const skus = await values(eventPropertyExpr('properties.item[*].sku', baseScope));
    expect((skus.e1 as string[]).sort()).toEqual(['sku-1', 'sku-2']);
    expect(skus.e3).toEqual(['SKU-3']);
    expect(skus.e2).toEqual([]);
  });

  it('labels has_profile and cohorts', async () => {
    expect(await values(eventPropertyExpr('has_profile', baseScope))).toMatchObject({
      e1: 'false',
      e2: 'true',
    });
    expect(await values(eventPropertyExpr(`cohort:${COHORT_1}`, baseScope))).toMatchObject({
      e2: 'In Cohort',
      e3: 'Not In Cohort',
    });
    expect(
      await values(eventPropertyExpr('cohort', baseScope, { id: COHORT_1, name: 'Power' })),
    ).toMatchObject({ e5: 'Power', e1: 'Not Power' });
  });

  it('reads the profile joined, looked up, or narrowed to the used keys', async () => {
    const joined: EventFilterScope = { ...baseScope, profileAlias: 'profile' };
    const expected = { e1: '', e2: 'pro', e3: 'free', e4: '', e5: 'Pro' };
    expect(await values(eventPropertyExpr('profile.properties.plan', joined), profileJoin(joined))).toMatchObject(expected);
    expect(await values(eventPropertyExpr('profile.properties.plan', baseScope))).toMatchObject(expected);
    expect(await values(eventPropertyExpr('profile.email', baseScope))).toMatchObject({
      e2: 'ann@x.se',
      e4: '',
    });

    const { keys, needsFullMap } = collectProfilePropertyKeys([
      { name: 'profile.properties.plan' },
      { name: "profile.properties.it's" },
    ]);
    const { select, columns } = narrowedProfileSelect(keys, needsFullMap);
    const narrowed = narrowProfileScope(joined, columns);
    const join = sql`LEFT JOIN (SELECT ${select} FROM analytics.profiles WHERE project_id = ${FILTER_PROJECT}) AS profile ON profile.id = e.profile_id`;
    expect(await values(eventPropertyExpr('profile.properties.plan', narrowed), join)).toMatchObject(expected);
    expect(
      await eventIds(and(eventFilterClauses([{ id: 'n', name: 'profile.properties.plan', operator: 'is', value: ['pro'] }], narrowed)), join),
    ).toEqual(['e2']);
  });

  it('reads group names per joined group', async () => {
    const scope: EventFilterScope = { ...baseScope, groupJoin: GROUP_JOIN };
    const rows = await query<{ id: string; value: string }>(
      sql`SELECT e.id, ${eventPropertyExpr('group.name', scope)} AS value FROM analytics.events e ${groupJoin(scope)} WHERE e.project_id = ${FILTER_PROJECT}`,
    );
    const pairs = rows.map((row) => `${shortEventId(row.id)}:${row.value}`).sort();
    expect(pairs).toEqual(['e2:Acme Inc', 'e3:Globex', 'e3:Growth', 'e4:', 'e5:Acme Inc', 'e5:Globex']);
  });

  it('reads group and profile columns from their own tables', async () => {
    const groups = await query<{ id: string; value: string }>(
      sql`SELECT id, ${groupColumnExpr('group.properties.seats')} AS value FROM analytics.groups WHERE project_id = ${FILTER_PROJECT} ORDER BY id`,
    );
    expect(groups.map((row) => row.value)).toEqual(['50', '12', '']);
    const profiles = await query<{ id: string; value: string }>(
      sql`SELECT id, ${profileColumnExpr('profile.properties.plan')} AS value FROM analytics.profiles WHERE project_id = ${FILTER_PROJECT} ORDER BY id`,
    );
    expect(Object.fromEntries(profiles.map((row) => [row.id, row.value]))).toEqual({
      d1: '',
      d2: '',
      u1: 'pro',
      u2: 'free',
      u3: 'Pro',
    });
  });

  it('joins cohorts and labels every cohort of a profile', async () => {
    const alias = raw(cohortAlias(COHORT_1));
    const rows = await query<{ id: string; member: boolean }>(
      sql`SELECT e.id, ${alias}.profile_id IS NOT NULL AS member FROM analytics.events e ${cohortJoin(COHORT_1, FILTER_PROJECT, 'e')} WHERE e.project_id = ${FILTER_PROJECT}`,
    );
    expect(rows.filter((row) => row.member).map((row) => shortEventId(row.id)).sort()).toEqual(['e2', 'e5']);

    const labels = await query<{ label: string }>(
      sql`SELECT ${allCohortsLabelExpr([{ id: COHORT_1, name: "Power's" }])} AS label
          FROM analytics.events e
          JOIN (${allCohortsMembershipQuery(FILTER_PROJECT)}) AS _all_cohorts ON _all_cohorts.profile_id = e.profile_id
          WHERE e.project_id = ${FILTER_PROJECT}
          ORDER BY label`,
    );
    expect(labels.map((row) => row.label)).toEqual(["Power's", "Power's", 'Unknown']);
  });
});

it('never lets a key, value or name out of its parameter', async () => {
  const hostile = "x'] = '' OR 1 = 1 OR properties['y";
  const filters = [
    { id: 'a', name: `properties.${hostile}`, operator: 'is' as const, value: [hostile] },
    { id: 'b', name: `profile.properties.${hostile}`, operator: 'contains' as const, value: [hostile] },
    { id: 'c', name: `group.properties.${hostile}`, operator: 'regex' as const, value: ['.*'] },
  ];
  const scope = { ...baseScope, profileAlias: 'profile' };
  expect(await eventIds(and(eventFilterClauses(filters, scope)), profileJoin(scope))).toEqual([]);
  expect(eventUuid('e1')).toBe('00000000-0000-4000-8000-000000000001');
});
