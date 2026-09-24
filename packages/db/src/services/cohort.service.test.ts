/**
 * Event-based cohort criteria and the stored membership on Postgres: the
 * SQL shape (bound dates, where the timeframe sits, how "never" inverts),
 * the ClickHouse semantics they keep, run on a throwaway database, and the
 * membership writes the cohort refresh does. Results on the golden dataset
 * are compared with ClickHouse in test/golden/cohorts.golden.test.ts.
 */
import { runWithScope } from '@openpanel/runtime';
import type {
  CohortDefinition,
  EventBasedCohortDefinition,
  EventCriteria,
  IChartEventFilter,
} from '@openpanel/validation';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { anQuery } from '../analytics/client';
import { rebuildRollups } from '../analytics/rollups';
import { compile, sql } from '../analytics/sql';
import { insertCohortMembers, insertEvents, upsertProfiles } from '../analytics/writers';
import { db } from '../prisma-client';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import {
  buildEventBasedCohortQuery,
  buildEventCriteriaQuery,
  computeCohort,
  countCohort,
  deleteCohortMembership,
  getCohortCount,
  getCohortMembers,
  updateCohortMembership,
} from './cohort.service';

const PROJECT_ID = 'test-cohort-timeframe';
const NOW = new Date('2026-03-20T10:00:00Z');
const NOBODY = 'SELECT NULL::text AS profile_id WHERE FALSE';

let seq = 0;
const filter = (
  name: string,
  operator: IChartEventFilter['operator'],
  value: IChartEventFilter['value'],
): IChartEventFilter => ({ id: `c${++seq}`, name, operator, value });

function criteria(
  timeframe: EventCriteria['timeframe'],
  extra: Partial<EventCriteria> = {},
): EventCriteria {
  return { name: 'screen_view', filters: [], timeframe, ...extra };
}

const LAST_30_DAYS = { type: 'relative', value: '30d' } satisfies EventCriteria['timeframe'];

const text = (criterion: EventCriteria) => compile(buildEventCriteriaQuery(PROJECT_ID, criterion)).text;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

afterAll(() => {
  vi.useRealTimers();
});

// Values that broke out of a naive `toDate('${value}')` interpolation.
const HOSTILE = [
  "2024-01-01') OR 1=1 --",
  "2024-01-01'",
  "2024-01-01') UNION ALL SELECT id FROM profiles --",
];

describe('buildEventCriteriaQuery timeframes', () => {
  it('binds calendar dates as parameters', () => {
    const { text: open, values } = compile(
      buildEventCriteriaQuery(PROJECT_ID, criteria({ type: 'absolute', start: '2024-01-01' })),
    );
    expect(open).toContain('d.day >= $3::date');
    expect(open).not.toContain('2024-01-01');
    expect(values).toContain('2024-01-01');

    const range = compile(
      buildEventCriteriaQuery(
        PROJECT_ID,
        criteria({ type: 'absolute', start: '2024-01-01', end: '2024-02-01' }),
      ),
    );
    expect(range.text).toContain('d.day >= $3::date AND d.day <= $4::date');
    expect(range.values).toEqual([PROJECT_ID, 'screen_view', '2024-01-01', '2024-02-01']);
  });

  it('bounds event scans by the UTC days, end day included', () => {
    const { text: counted, values } = compile(
      buildEventCriteriaQuery(
        PROJECT_ID,
        criteria(
          { type: 'absolute', start: '2024-01-01', end: '2024-02-01' },
          { frequency: { operator: 'gte', count: 2 } },
        ),
      ),
    );
    expect(counted).toContain(
      "e.created_at >= ($3::date::timestamp AT TIME ZONE 'UTC') AND e.created_at < (($4::date + 1)::timestamp AT TIME ZONE 'UTC')",
    );
    expect(values.slice(2, 4)).toEqual(['2024-01-01', '2024-02-01']);
  });

  it.each([...HOSTILE, '2024-02-30', '2024-1-1', ''])(
    'matches nobody for a date toDate could not read (%j)',
    (start) => {
      expect(text(criteria({ type: 'absolute', start }))).toBe(NOBODY);
      expect(text(criteria({ type: 'absolute', start: '2024-01-01', end: start || 'x' }))).toBe(NOBODY);
    },
  );

  it('counts relative timeframes back from the JS clock in UTC days', () => {
    const { values } = compile(buildEventCriteriaQuery(PROJECT_ID, criteria(LAST_30_DAYS)));
    // toDate(now() - INTERVAL 30 DAY) at 2026-03-20 10:00 UTC.
    expect(values).toContain('2026-02-18');
  });

  it('still refuses an unknown relative timeframe', () => {
    expect(() =>
      buildEventCriteriaQuery(PROJECT_ID, criteria({ type: 'relative', value: '2w' } as never)),
    ).toThrow('Invalid relative timeframe: 2w');
  });
});

const frequencyCriteria = (
  frequency: EventCriteria['frequency'],
  filters: EventCriteria['filters'] = [],
): EventCriteria => ({ name: 'subscription_started', filters, timeframe: LAST_30_DAYS, frequency });

// The query with the NOT EXISTS subquery cut out: what the profile scan sees.
function outsideExclusion(query: string): string {
  const open = query.indexOf('NOT EXISTS (');
  return open === -1 ? query : query.slice(0, open);
}

describe('buildEventCriteriaQuery zero frequency', () => {
  it.each(['eq', 'lte'] as const)(
    'excludes anyone who did the event when the count is 0 (%s)',
    (operator) => {
      const query = text(frequencyCriteria({ operator, count: 0 }));

      // A profile only has events to count when it did the event, so a
      // HAVING can never match zero — the query is inverted.
      expect(query).not.toContain('HAVING');
      expect(query).toContain('SELECT p.id AS profile_id');
      expect(query).toContain('FROM analytics.profiles AS p');
      expect(query).toContain('NOT EXISTS (');
      expect(query).toContain('FROM analytics.profile_event_days AS d');
      expect(query).toContain('d.profile_id = p.id');
    },
  );

  it('gives eq 0 and lte 0 the same query', () => {
    expect(compile(buildEventCriteriaQuery(PROJECT_ID, frequencyCriteria({ operator: 'eq', count: 0 })))).toEqual(
      compile(buildEventCriteriaQuery(PROJECT_ID, frequencyCriteria({ operator: 'lte', count: 0 }))),
    );
  });

  it('keeps the timeframe inside the exclusion, not on the profile scan', () => {
    const query = text(frequencyCriteria({ operator: 'eq', count: 0 }));
    // "Never did X in the last 30 days" still includes someone who did X 60
    // days ago — which only holds while the date bound sits in the subquery.
    expect(query).toContain('d.day >= $4::date');
    expect(outsideExclusion(query)).not.toMatch(/day|created_at/);
    expect(outsideExclusion(query)).toContain('p.project_id = $1');
  });

  it('excludes on the matching property pair when the criterion has property filters', () => {
    const query = text(
      frequencyCriteria({ operator: 'eq', count: 0 }, [filter('properties.plan', 'is', ['pro'])]),
    );
    expect(query).not.toContain('HAVING');
    expect(query).toContain('FROM analytics.events AS e');
    expect(query).toContain("COALESCE(e.properties ->> $");
    expect(outsideExclusion(query)).not.toContain('properties');
  });

  it('leaves gte 0 on the ordinary path (zFrequency rejects it upstream)', () => {
    const { text: query, values } = compile(
      buildEventCriteriaQuery(PROJECT_ID, frequencyCriteria({ operator: 'gte', count: 0 })),
    );
    expect(query).toMatch(/HAVING count\(\*\) >= \$\d+::numeric/);
    expect(values.at(-1)).toBe(0);
    expect(query).not.toContain('NOT EXISTS');
  });

  it.each([
    ['gte', 1, '>='],
    ['eq', 2, '='],
    ['lte', 3, '<='],
  ] as const)('still groups and filters for positive counts (%s %i)', (operator, count, sign) => {
    const { text: query, values } = compile(
      buildEventCriteriaQuery(PROJECT_ID, frequencyCriteria({ operator, count })),
    );
    expect(query).toContain('GROUP BY e.profile_id');
    expect(query).toMatch(new RegExp(`HAVING count\\(\\*\\) ${sign} \\$\\d+::numeric`));
    expect(values.at(-1)).toBe(count);
    expect(query).not.toContain('analytics.profiles');
  });
});

describe('buildEventBasedCohortQuery', () => {
  const definition = {
    type: 'event',
    criteria: {
      operator: 'and',
      events: [
        { name: 'signup', filters: [], timeframe: LAST_30_DAYS, frequency: { operator: 'gte', count: 1 } },
        frequencyCriteria({ operator: 'eq', count: 0 }),
      ],
    },
  } satisfies EventBasedCohortDefinition;

  it('intersects the criteria as sets of profile_id', () => {
    const query = compile(buildEventBasedCohortQuery(PROJECT_ID, definition)).text;
    const [signedUp, neverSubscribed] = query.split(' INTERSECT ');

    expect(neverSubscribed).toBeDefined();
    // Every operand is a bare set of profile_id: same column, one row per
    // profile, no LIMIT or ORDER BY of its own.
    expect(signedUp).toContain('SELECT e.profile_id');
    expect(neverSubscribed).toContain('SELECT p.id AS profile_id');
    expect(query).not.toContain('ORDER BY');
    expect(query).not.toContain('LIMIT');
  });

  it('unions them under "or"', () => {
    const query = compile(
      buildEventBasedCohortQuery(PROJECT_ID, {
        ...definition,
        criteria: { ...definition.criteria, operator: 'or' },
      }),
    ).text;
    expect(query).toContain(' UNION ');
    expect(query).not.toContain(' INTERSECT ');
  });

  it('matches nobody when ClickHouse would have failed any criterion', () => {
    // An empty `contains` list was `AND ()` in ClickHouse: the whole query
    // failed. Emptying only that criterion would make a "never" one match
    // everybody, so the whole definition matches nobody.
    const rejected = frequencyCriteria({ operator: 'eq', count: 0 }, [
      filter('properties.plan', 'contains', []),
    ]);
    for (const operator of ['and', 'or'] as const) {
      const query = buildEventBasedCohortQuery(PROJECT_ID, {
        type: 'event',
        criteria: { operator, events: [definition.criteria.events[0]!, rejected] },
      });
      expect(compile(query).text).toBe(NOBODY);
    }
  });
});

// --- on Postgres -----------------------------------------------------------------------

const DB_PROJECT = 'test-cohort-db';
const ORG = 'test-cohort-org';
let testDb: TestDatabase;
const inDb = <T>(fn: () => Promise<T>) =>
  runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, fn);

let eventSeq = 0;
function event(profileId: string, name: string, createdAt: string, properties: Record<string, string> = {}, deviceId?: string) {
  eventSeq++;
  return {
    id: `00000000-0000-4000-a000-${String(eventSeq).padStart(12, '0')}`,
    project_id: DB_PROJECT,
    name,
    profile_id: profileId,
    device_id: deviceId ?? `dev-${profileId}`,
    session_id: `s-${profileId}`,
    properties,
    created_at: createdAt,
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await inDb(async () => {
    await insertEvents([
      // u1: two clicks matching both button and variant, one on another button.
      event('u1', 'button_click', '2026-03-18 09:00:00', { button: 'cta', variant: 'a' }),
      event('u1', 'button_click', '2026-03-18 09:05:00', { button: 'cta', variant: 'a' }),
      event('u1', 'button_click', '2026-03-19 09:00:00', { button: 'nav', variant: 'b' }),
      // u2: one click matching the button only.
      event('u2', 'button_click', '2026-03-19 12:00:00', { button: 'cta', variant: 'b' }),
      // An anonymous device (profile_id = device_id) clicking cta.
      event('d1', 'button_click', '2026-03-19 13:00:00', { button: 'cta' }, 'd1'),
      // u3 signed up long ago and never clicked.
      event('u3', 'signup', '2025-12-01 08:00:00'),
      // u4 clicked cta, but 40 days ago.
      event('u4', 'button_click', '2026-02-08 08:00:00', { button: 'cta' }),
    ]);
    await rebuildRollups(DB_PROJECT);
    await upsertProfiles(
      ['u1', 'u2', 'u3', 'u4', 'd1'].map((id) => ({
        id,
        project_id: DB_PROJECT,
        is_external: id !== 'd1',
        first_name: '',
        last_name: '',
        email: '',
        avatar: '',
        properties: {},
        created_at: '2025-12-01 00:00:00',
      })),
    );
    await db.organization.create({ data: { id: ORG, name: 'Cohorts', timezone: 'UTC' } });
    await db.project.create({ data: { id: DB_PROJECT, name: 'Cohorts', organizationId: ORG } });
  });
});

afterAll(async () => {
  await testDb?.drop();
});

const cta = filter('properties.button', 'is', ['cta']);
const clicked = (extra: Partial<EventCriteria> = {}): CohortDefinition => ({
  type: 'event',
  criteria: {
    operator: 'and',
    events: [{ name: 'button_click', filters: [], timeframe: LAST_30_DAYS, ...extra }],
  },
});

/** The members, checked against the count the preview shows next to them. */
async function members(definition: CohortDefinition) {
  const ids = await inDb(() => computeCohort(DB_PROJECT, definition));
  const count = await inDb(() => countCohort(DB_PROJECT, definition));
  if (count !== ids.length) {
    throw new Error(`count ${count} disagrees with ${ids.length} members`);
  }
  return ids.sort();
}

describe('event criteria on Postgres', () => {
  it('only counts identified profiles', async () => {
    expect(await members(clicked())).toEqual(['u1', 'u2']);
  });

  it('counts an event once per matching property pair, as the summary MV did', async () => {
    const buttonAndVariant = [cta, filter('properties.variant', 'is', ['a'])];
    // u1: 2 events × 2 matching pairs = 4; u2: 1 event × 1 pair.
    expect(await members(clicked({ filters: buttonAndVariant, frequency: { operator: 'gte', count: 4 } }))).toEqual(['u1']);
    expect(await members(clicked({ filters: buttonAndVariant, frequency: { operator: 'gte', count: 5 } }))).toEqual([]);
    expect(await members(clicked({ filters: buttonAndVariant, frequency: { operator: 'eq', count: 1 } }))).toEqual(['u2']);
    // Filters on one key test the same pair once.
    const sameKey = [cta, filter('properties.button', 'isNot', ['nav'])];
    expect(await members(clicked({ filters: sameKey, frequency: { operator: 'eq', count: 2 } }))).toEqual(['u1']);
  });

  it('needs the key to be present for a negative property filter', async () => {
    // u1's third click has variant b; a click without the key never matches.
    expect(await members(clicked({ filters: [filter('properties.variant', 'isNot', ['a'])] }))).toEqual(['u1', 'u2']);
    expect(await members(clicked({ filters: [filter('properties.missing', 'isNot', ['x'])] }))).toEqual([]);
  });

  it('reads "never did X where …" as having no matching event', async () => {
    const never: Partial<EventCriteria> = { filters: [cta], frequency: { operator: 'eq', count: 0 } };
    // u4's click is outside the window; d1's is anonymous.
    expect(await members(clicked(never))).toEqual(['d1', 'u3', 'u4']);
    expect(await members(clicked({ frequency: { operator: 'lte', count: 0 } }))).toEqual(['d1', 'u3', 'u4']);
  });

  it('takes a capped sample in id order', async () => {
    expect(await inDb(() => computeCohort(DB_PROJECT, clicked({ frequency: { operator: 'lte', count: 0 } }), 2))).toEqual([
      'd1',
      'u3',
    ]);
  });
});

describe('stored membership', () => {
  const cohortId = '0b4c6f1e-2f0a-4f4e-9d8a-6e2f7c1a9d01';

  const storedMembers = () =>
    inDb(() =>
      anQuery<{ profile_id: string; matched_at: string; version: number }>(sql`
        SELECT profile_id, matched_at, version FROM analytics.cohort_members
        WHERE project_id = ${DB_PROJECT} AND cohort_id = ${cohortId}
        ORDER BY profile_id
      `),
    );
  const storedMetadata = () =>
    inDb(() =>
      anQuery<{ member_count: number; sample_profiles: string[]; last_computed_at: string }>(sql`
        SELECT member_count, sample_profiles, last_computed_at FROM analytics.cohort_metadata
        WHERE project_id = ${DB_PROJECT} AND cohort_id = ${cohortId}
      `),
    );
  const leftovers = (ids: string[]) =>
    inDb(() =>
      insertCohortMembers(
        ids.map((profileId) => ({ project_id: DB_PROJECT, cohort_id: cohortId, profile_id: profileId, version: 1 })),
      ),
    );

  beforeAll(async () => {
    await inDb(() =>
      db.cohort.create({
        data: {
          id: cohortId,
          name: 'Clicked',
          projectId: DB_PROJECT,
          definition: clicked() as PrismaJson.IPrismaCohortDefinition,
        },
      }),
    );
  });

  it('replaces the membership, and a rerun changes nothing', async () => {
    // A member from an earlier compute that no longer qualifies.
    await leftovers(['u3']);

    await inDb(() => updateCohortMembership(cohortId));
    const first = await storedMembers();
    expect(first.map((row) => row.profile_id)).toEqual(['u1', 'u2']);
    expect(first.every((row) => row.matched_at === '2026-03-20 10:00:00.000')).toBe(true);
    expect(await storedMetadata()).toEqual([
      { member_count: 2, sample_profiles: expect.arrayContaining(['u1', 'u2']), last_computed_at: '2026-03-20 10:00:00.000' },
    ]);
    const cohort = await inDb(() => db.cohort.findUniqueOrThrow({ where: { id: cohortId } }));
    expect(cohort.profileCount).toBe(2);
    expect(cohort.lastComputedAt).toEqual(NOW);

    vi.setSystemTime(new Date(NOW.getTime() + 30 * 60_000));
    await inDb(() => updateCohortMembership(cohortId));
    const second = await storedMembers();
    expect(second.map((row) => row.profile_id)).toEqual(['u1', 'u2']);
    expect(second[0]!.version).toBeGreaterThan(first[0]!.version);
    expect(await inDb(() => getCohortCount(cohortId, DB_PROJECT))).toBe(2);
    expect(await inDb(() => getCohortMembers(cohortId, DB_PROJECT, { limit: 1, offset: 1 }))).toEqual({
      profileIds: ['u2'],
      total: 2,
    });
  });

  it('writes nothing for a cohort deleted while it was computed', async () => {
    const doomed = '0b4c6f1e-2f0a-4f4e-9d8a-6e2f7c1a9d02';
    await inDb(() =>
      db.cohort.create({
        data: { id: doomed, name: 'Doomed', projectId: DB_PROJECT, definition: clicked() as PrismaJson.IPrismaCohortDefinition },
      }),
    );
    await inDb(() =>
      insertCohortMembers([{ project_id: DB_PROJECT, cohort_id: doomed, profile_id: 'u3', version: 1 }]),
    );

    // Hold the cohort's row, as the dashboard's delete does while it runs,
    // until the refresh waits on it; then delete the cohort.
    const deleter = new pg.Client({ connectionString: testDb.url });
    await deleter.connect();
    try {
      await deleter.query('BEGIN');
      await deleter.query('SELECT id FROM public.cohorts WHERE id = $1 FOR UPDATE', [doomed]);
      const refresh = inDb(() => updateCohortMembership(doomed));
      for (let attempt = 0; attempt < 200; attempt++) {
        // Activity stats are cached per transaction otherwise.
        await deleter.query('SELECT pg_stat_clear_snapshot()');
        const waiting = await deleter.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%FROM public.cohorts%FOR UPDATE%'`,
        );
        if (waiting.rowCount) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await deleter.query('DELETE FROM public.cohorts WHERE id = $1', [doomed]);
      await deleter.query('COMMIT');
      await refresh;
    } finally {
      await deleter.end();
    }

    const rows = await inDb(() =>
      anQuery(sql`SELECT 1 FROM analytics.cohort_members WHERE cohort_id = ${doomed}
        UNION ALL SELECT 1 FROM analytics.cohort_metadata WHERE cohort_id = ${doomed}`),
    );
    expect(rows).toEqual([]);
  }, 20_000);

  it('deleteCohortMembership removes members and metadata', async () => {
    await inDb(() => deleteCohortMembership(cohortId, DB_PROJECT));
    expect(await storedMembers()).toEqual([]);
    expect(await storedMetadata()).toEqual([]);
  });
});
