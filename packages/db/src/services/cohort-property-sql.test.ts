/**
 * Property-based cohort queries on Postgres: the SQL shape (allowlisted
 * columns, bound keys and values, one row per profile) and, on a throwaway
 * database, what the ClickHouse builder's operators matched. Results on the
 * golden dataset are compared with ClickHouse in
 * test/golden/cohorts.golden.test.ts.
 */
import { runWithScope } from '@openpanel/runtime';
import type {
  IChartEventFilter,
  PropertyBasedCohortDefinition,
} from '@openpanel/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compile } from '../analytics/sql';
import { upsertProfiles } from '../analytics/writers';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import {
  buildPropertyBasedCohortQuery,
  computePropertyBasedCohort,
  countPropertyBasedCohort,
  profileColumnAccess,
} from './cohort.service';

const PROJECT_ID = 'test-cohort-properties';

let seq = 0;
const filter = (
  name: string,
  operator: IChartEventFilter['operator'],
  value: IChartEventFilter['value'],
): IChartEventFilter => ({ id: `p${++seq}`, name, operator, value });

function definition(
  properties: IChartEventFilter[],
  operator: 'and' | 'or' = 'and',
): PropertyBasedCohortDefinition {
  return { type: 'property', criteria: { operator, properties } };
}

function buildSql(properties: IChartEventFilter[], operator: 'and' | 'or' = 'and', limit?: number) {
  return compile(buildPropertyBasedCohortQuery(PROJECT_ID, definition(properties, operator), limit));
}

const experiment = filter('profile.properties.experiment', 'is', ['control']);
const NOBODY = 'SELECT NULL::text AS profile_id WHERE FALSE';

describe('buildPropertyBasedCohortQuery', () => {
  it('reads each profile once, without resolving versions', () => {
    const { text } = buildSql([experiment, filter('profile.email', 'is', ['x@y.z'])]);

    // analytics.profiles has one row per (project, id): the argMax/GROUP BY
    // the ClickHouse ReplacingMergeTree needed is gone.
    expect(text).toContain('FROM analytics.profiles AS profiles');
    expect(text).not.toMatch(/GROUP BY|HAVING|argMax|FINAL|DISTINCT/);
    expect(text).toContain("COALESCE(profiles.properties ->> $2::text, '') = $3::text");
    expect(text).toContain('profiles.email = $4::text');
  });

  it('binds property keys and values', () => {
    const { text, values } = buildSql([filter("profile.properties.pl'an", 'is', ["x' OR 1=1 --"])]);

    expect(text).not.toContain("pl'an");
    expect(text).not.toContain('OR 1=1');
    expect(values).toEqual([PROJECT_ID, "pl'an", "x' OR 1=1 --"]);
  });

  it('only splices allowlisted columns', () => {
    expect(compile(profileColumnAccess('profile.last_seen_at')).text).toBe('profiles.last_seen_at');
    expect(compile(profileColumnAccess('profiles.email')).text).toBe('profiles.email');
    expect(() => profileColumnAccess('profile.email; DROP TABLE x')).toThrow(
      'Unknown profile filter column: profile.email; DROP TABLE x',
    );
    // Unprefixed names are not profile columns — even without values.
    expect(() => buildSql([filter('properties.plan', 'is', [])])).toThrow(
      'Unknown profile filter column: properties.plan',
    );
  });

  it('combines the filters with the definition operator', () => {
    const numeric = filter('profile.properties.age', 'gte', ['30']);
    expect(buildSql([experiment, numeric], 'and').text).toMatch(/\) AND \(/);
    expect(buildSql([experiment, numeric], 'or').text).toMatch(/\) OR \(/);
  });

  it('compares numbers through to_float_or_null', () => {
    const { text, values } = buildSql([filter('profile.properties.age', 'gt', ['30', '99'])]);

    // Only the first value counts, as before.
    expect(text).toContain("analytics.to_float_or_null(COALESCE(profiles.properties ->> $2::text, '')) > $3::double precision");
    expect(values).toEqual([PROJECT_ID, 'age', 30]);
  });

  it('applies the limit in id order, so a capped cohort keeps its members', () => {
    const { text, values } = buildSql([experiment], 'and', 10);
    expect(text).toMatch(/ORDER BY profiles\.id LIMIT \$4/);
    expect(values[3]).toBe(10);
    expect(buildSql([experiment]).text).not.toContain('LIMIT');
  });

  it('matches nobody when every filter was dropped as empty', () => {
    expect(buildSql([filter('profile.properties.x', 'is', [])]).text).toBe(NOBODY);
    expect(buildSql([filter('profile.properties.x', 'regex', ['^a'])]).text).toBe(NOBODY);
  });

  it('matches nobody where ClickHouse failed the whole query', () => {
    // LIKE and toFloat64OrNull on a DateTime64 column, and a pattern ending in
    // a lone backslash, were query errors: the definition is empty now, OR or
    // not.
    for (const rejected of [
      filter('profile.created_at', 'contains', ['2026']),
      filter('profile.last_seen_at', 'gt', ['5']),
      filter('profile.email', 'endsWith', ['\\']),
    ]) {
      expect(buildSql([experiment, rejected], 'or').text).toBe(NOBODY);
    }
  });
});

describe('property cohorts on Postgres', () => {
  let testDb: TestDatabase;
  const inDb = <T>(fn: () => Promise<T>) =>
    runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, fn);

  const profile = (
    id: string,
    properties: Record<string, string>,
    extra: { email?: string; created_at?: string } = {},
  ) => ({
    id,
    project_id: PROJECT_ID,
    is_external: true,
    first_name: '',
    last_name: '',
    email: extra.email ?? '',
    avatar: '',
    properties,
    created_at: extra.created_at ?? '2026-01-01 10:00:00',
  });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    await inDb(() =>
      upsertProfiles([
        profile('p-pro', { plan: 'pro', age: '41' }, { email: 'pro@example.com' }),
        profile('p-free', { plan: 'free', age: 'n/a' }, { email: 'free@example.se' }),
        profile('p-team', { plan: 'team', age: '19' }, { created_at: '2026-02-03 04:05:06' }),
        profile('p-none', {}),
      ]),
    );
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  /** The members, checked against the count the preview shows next to them. */
  const members = async (properties: IChartEventFilter[], operator: 'and' | 'or' = 'and') => {
    const ids = await inDb(() => computePropertyBasedCohort(PROJECT_ID, definition(properties, operator)));
    const count = await inDb(() => countPropertyBasedCohort(PROJECT_ID, definition(properties, operator)));
    if (count !== ids.length) {
      throw new Error(`count ${count} disagrees with ${ids.length} members`);
    }
    return ids.sort();
  };

  it('reads a missing property as the empty string', async () => {
    expect(await members([filter('profile.properties.plan', 'isNot', ['pro'])])).toEqual([
      'p-free',
      'p-none',
      'p-team',
    ]);
    expect(await members([filter('profile.properties.plan', 'isNull', [])])).toEqual(['p-none']);
    expect(await members([filter('profile.properties.plan', 'isNotNull', [])])).toEqual([
      'p-free',
      'p-pro',
      'p-team',
    ]);
  });

  it('ORs the values of doesNotContain, as before', async () => {
    // "not pro OR not free" holds for everybody.
    expect(await members([filter('profile.properties.plan', 'doesNotContain', ['pro', 'free'])])).toHaveLength(4);
    expect(await members([filter('profile.properties.plan', 'doesNotContain', ['r'])])).toEqual([
      'p-none',
      'p-team',
    ]);
  });

  it('matches LIKE case-sensitively, with ClickHouse wildcards', async () => {
    expect(await members([filter('profile.email', 'contains', ['EXAMPLE'])])).toEqual([]);
    expect(await members([filter('profile.email', 'endsWith', ['.se'])])).toEqual(['p-free']);
    expect(await members([filter('profile.properties.plan', 'startsWith', ['_r'])])).toEqual(['p-free', 'p-pro']);
  });

  it('compares numbers, reading non-numbers as NULL', async () => {
    expect(await members([filter('profile.properties.age', 'gt', ['20'])])).toEqual(['p-pro']);
    expect(await members([filter('profile.properties.age', 'lte', ['41'])])).toEqual(['p-pro', 'p-team']);
    expect(await members([filter('profile.properties.age', 'lt', ['abc'])])).toEqual([]);
  });

  it('compares date columns with UTC date-times', async () => {
    expect(await members([filter('profile.created_at', 'is', ['2026-02-03 04:05:06'])])).toEqual(['p-team']);
    expect(await members([filter('profile.created_at', 'isNot', ['2026-02-03 04:05:06'])])).toHaveLength(3);
    // An empty value is the epoch; nobody has that date.
    expect(await members([filter('profile.created_at', 'isNull', [])])).toEqual([]);
    expect(await members([filter('profile.created_at', 'isNotNull', [])])).toHaveLength(4);
  });

  it('combines with and / or', async () => {
    const pro = filter('profile.properties.plan', 'is', ['pro']);
    const young = filter('profile.properties.age', 'lt', ['30']);
    expect(await members([pro, young], 'and')).toEqual([]);
    expect(await members([pro, young], 'or')).toEqual(['p-pro', 'p-team']);
  });

  it('returns a limited sample in id order', async () => {
    const sample = await inDb(() =>
      computePropertyBasedCohort(PROJECT_ID, definition([filter('profile.properties.plan', 'isNot', ['x'])]), 2),
    );
    expect(sample).toEqual(['p-free', 'p-none']);
  });
});
