import { round } from '@openpanel/common';
import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  RETENTION_BLUEPRINT,
  RETENTION_FIXTURE,
  profileEventDays,
  setupRetentionFixtures,
} from '../../../../test/retention-fixtures';
import { rebuildRollups } from '../analytics/rollups';
import { compile } from '../analytics/sql';
import { insertEvents } from '../analytics/writers';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import {
  buildRetentionMatrixSql,
  getRetentionCohort,
  getRetentionLastSeenSeries,
  getRetentionSeries,
  getRollingActiveUsers,
  type IRetentionCohortRow,
  processCohortData,
} from './retention.service';

const PROJECT_ID = 'test-retention-cohort';
const { day, week } = RETENTION_FIXTURE;

let testDb: TestDatabase;

const inDb = <T>(fn: () => Promise<T>) =>
  runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, fn);

beforeAll(async () => {
  testDb = await createTestDatabase();
  await inDb(() => setupRetentionFixtures(PROJECT_ID));
});

afterAll(async () => {
  vi.useRealTimers();
  await testDb?.drop();
});

// Keep only the per-cohort rows (drop the leading "Weighted Average" row) and
// the fields the blueprint pins down.
function cohortsOnly(rows: IRetentionCohortRow[]) {
  return rows
    .filter((row) => row.cohort_interval !== 'Weighted Average')
    .map(({ cohort_interval, sum, values }) => ({
      cohort_interval,
      sum,
      values,
    }));
}

const appOpenDays = (overrides: Partial<Parameters<typeof getRetentionCohort>[0]> = {}) =>
  inDb(() =>
    getRetentionCohort({
      projectId: PROJECT_ID,
      firstEvent: ['app_open'],
      secondEvent: ['app_open'],
      criteria: 'on',
      interval: 'day',
      startDate: day.start,
      endDate: day.end,
      ...overrides,
    })
  );

describe('getRetentionCohort', () => {
  it('matches the blueprint for day interval, criteria "on"', async () => {
    expect(cohortsOnly(await appOpenDays())).toEqual(RETENTION_BLUEPRINT.dayOn);
  });

  it('matches the blueprint for day interval, criteria "on_or_after"', async () => {
    expect(cohortsOnly(await appOpenDays({ criteria: 'on_or_after' }))).toEqual(
      RETENTION_BLUEPRINT.dayOnOrAfter
    );
  });

  it('counts retention across the year boundary (week interval)', async () => {
    // The old toWeek() implementation returned week-of-year (resets each Jan),
    // so a 2024-W52 -> 2025-W01 return produced a negative diff and was dropped.
    // This locks the year-aware behavior.
    const rows = await appOpenDays({
      interval: 'week',
      startDate: week.start,
      endDate: week.end,
    });

    expect(cohortsOnly(rows)).toEqual(RETENTION_BLUEPRINT.weekOn);
  });

  it('prepends a weighted-average row that is 100% retained at interval 0', async () => {
    const rows = await appOpenDays();

    expect(rows[0]?.cohort_interval).toBe('Weighted Average');
    expect(rows[0]?.percentages[0]).toBe(1);
  });

  it('assigns each user to a single first-touch cohort (no double-counting)', async () => {
    const rows = cohortsOnly(await appOpenDays());

    // Only D0 and D1 are real cohorts. There is NO D2 cohort: every user who
    // fired app_open on D2 (RU1, RU2, RU4) already belongs to an earlier cohort.
    expect(rows.map((row) => row.cohort_interval)).toEqual([day.d0, day.d1]);

    // Characterize the bug we fixed: the legacy "every-occurrence" cohorting
    // (no dedup per profile) places recurring users in every day they were
    // active, producing a spurious D2 cohort and inflated sizes.
    const activity = await inDb(() => profileEventDays(PROJECT_ID, 'app_open'));
    const perDay = new Map<string, number>();
    for (const row of activity) {
      if (row.day >= day.d0 && row.day <= day.d2) {
        perDay.set(row.day, (perDay.get(row.day) ?? 0) + 1);
      }
    }

    // 3 day-buckets, each with 3 distinct users => sizes sum to 9 for only 5
    // real users. First-touch collapses this to 3 + 2 = 5.
    expect([...perDay.values()]).toEqual([3, 3, 3]);
    const firstTouchTotal = rows.reduce((acc, row) => acc + row.sum, 0);
    expect(firstTouchTotal).toBe(5);
  });

  it('supports any-event (active-user) retention when no event names given', async () => {
    const named = await appOpenDays();
    const anyEvent = await appOpenDays({ firstEvent: undefined, secondEvent: [] });

    // In the day window the only non-app_open events are RU1's purchase (D1)
    // and RU2's purchase (D2). Those users are already active via app_open on
    // those days, so "any event" yields the same cohort sizes as app_open.
    expect(cohortsOnly(anyEvent).map((r) => r.sum)).toEqual(
      cohortsOnly(named).map((r) => r.sum)
    );
  });

  it('applies a property filter via the raw-events fallback path', async () => {
    // country = US drops RU3 (SE) from the D0 cohort. This filter references an
    // event column the profile_event_days rollup doesn't carry, so the engine
    // must fall back to the raw events table.
    const rows = await appOpenDays({
      filters: [{ name: 'country', operator: 'is', value: ['US'] }],
    });

    expect(cohortsOnly(rows)).toEqual(RETENTION_BLUEPRINT.countryUsOn);
  });

  it('scopes to a saved cohort via the rollup path (inCohort)', async () => {
    // inCohort only needs profile_id, so this stays on profile_event_days.
    // The cohort contains RU1 and RU4, leaving one user in each of D0 and D1.
    const rows = await appOpenDays({
      filters: [
        {
          name: 'cohort',
          operator: 'inCohort',
          value: [],
          cohortIds: [RETENTION_FIXTURE.cohort.id],
        },
      ],
    });

    expect(cohortsOnly(rows)).toEqual(RETENTION_BLUEPRINT.cohortOn);
  });

  it('reads the rollup for cohort filters and the events for anything else', () => {
    const input = {
      projectId: PROJECT_ID,
      criteria: 'on' as const,
      interval: 'day' as const,
      startDate: day.start,
      endDate: day.end,
    };
    const cohortOnly = compile(
      buildRetentionMatrixSql(
        {
          ...input,
          filters: [{ name: 'cohort', operator: 'notInCohort', value: [], cohortId: 'c1' }],
        },
        2
      )
    ).text;
    expect(cohortOnly).toContain('FROM analytics.profile_event_days AS src');
    expect(cohortOnly).not.toContain('analytics.events');
    expect(cohortOnly).toContain('src.profile_id NOT IN (SELECT profile_id FROM analytics.cohort_members');

    const withColumn = compile(
      buildRetentionMatrixSql(
        { ...input, filters: [{ name: 'country', operator: 'is', value: ['US'] }] },
        2
      )
    ).text;
    expect(withColumn).toContain('FROM analytics.events AS src');
    expect(withColumn).toContain('src.profile_id <> src.device_id');
    expect(withColumn).not.toContain('profile_event_days');
  });

  it('compares a rollup day with the bounds as midnight, like a ClickHouse Date', async () => {
    // The D0 events are at 12:00. A start bound after midnight skips the
    // whole day on the rollup path (RU2 moves to its next day, D2)...
    const lateStart = { startDate: `${day.d0} 11:00:00` };
    expect(cohortsOnly(await appOpenDays(lateStart))).toEqual([
      { cohort_interval: day.d1, sum: 3, values: [3, 2, 0] },
      { cohort_interval: day.d2, sum: 1, values: [1, 0, 0] },
    ]);
    // ...while the events path compares instants.
    const onEvents = await appOpenDays({
      ...lateStart,
      filters: [{ name: 'country', operator: 'isNot', value: ['XX'] }],
    });
    expect(cohortsOnly(onEvents)).toEqual(RETENTION_BLUEPRINT.dayOn);
  });

  it('keeps bounds and filter values out of the SQL text', () => {
    const { text, values } = compile(
      buildRetentionMatrixSql(
        {
          projectId: "p'--",
          firstEvent: ["a'); DROP TABLE x; --"],
          criteria: 'on_or_after',
          interval: 'month',
          startDate: '2024-01-01 00:00:00',
          endDate: '2024-03-01 00:00:00',
          filters: [{ name: 'path', operator: 'is', value: ["/'"] }],
        },
        2
      )
    );
    expect(text).not.toContain("p'--");
    expect(text).not.toContain('DROP TABLE');
    expect(text).not.toContain('2024-01-01');
    expect(values).toEqual(
      expect.arrayContaining(["p'--", ["a'); DROP TABLE x; --"], '2024-01-01 00:00:00'])
    );
  });

  it('returns nothing for a bound that is not a date', async () => {
    expect(await appOpenDays({ startDate: 'yesterday' })).toEqual([]);
  });
});

describe('getRetentionSeries', () => {
  it('computes week-over-week active-user retention', async () => {
    const rows = await inDb(() => getRetentionSeries({ projectId: PROJECT_ID }));
    expect(rows).toEqual(RETENTION_BLUEPRINT.weeklySeries);
  });
});

describe('getRollingActiveUsers', () => {
  const ROLLING_PROJECT = 'test-retention-rolling';

  beforeAll(async () => {
    const event = (profileId: string, createdAt: string, n: number) => ({
      id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
      project_id: ROLLING_PROJECT,
      name: 'screen_view',
      profile_id: profileId,
      device_id: profileId,
      session_id: `s-${profileId}`,
      properties: {},
      created_at: createdAt,
    });
    await inDb(async () => {
      await insertEvents([
        // A: active on the 1st and the 3rd; B: the 2nd only; anonymous
        // devices count too.
        event('a', '2024-05-01 10:00:00', 1),
        event('a', '2024-05-01 11:00:00', 2),
        event('a', '2024-05-03 09:00:00', 3),
        event('b', '2024-05-02 23:30:00', 4),
      ]);
      await rebuildRollups(ROLLING_PROJECT);
    });
  });

  it('counts each profile once per date its window reaches', async () => {
    const rows = await inDb(() => getRollingActiveUsers({ projectId: ROLLING_PROJECT, days: 3 }));
    expect(rows).toEqual([
      { date: '2024-05-01', users: 1 },
      { date: '2024-05-02', users: 2 },
      { date: '2024-05-03', users: 2 },
      // The window runs on past the last active day, as before.
      { date: '2024-05-04', users: 2 },
      { date: '2024-05-05', users: 1 },
    ]);
  });

  it('is the daily active count for a one-day window', async () => {
    const rows = await inDb(() => getRollingActiveUsers({ projectId: ROLLING_PROJECT, days: 1 }));
    expect(rows).toEqual([
      { date: '2024-05-01', users: 1 },
      { date: '2024-05-02', users: 1 },
      { date: '2024-05-03', users: 1 },
    ]);
  });

  it('returns nothing for a window that is not a positive whole number of days', async () => {
    for (const days of [0, -1, 1.5]) {
      expect(await inDb(() => getRollingActiveUsers({ projectId: ROLLING_PROJECT, days }))).toEqual([]);
    }
  });

  it('leaves anonymous devices out of the identified-user series', async () => {
    expect(await inDb(() => getRetentionLastSeenSeries({ projectId: ROLLING_PROJECT }))).toEqual([]);
    expect(await inDb(() => getRetentionSeries({ projectId: ROLLING_PROJECT }))).toEqual([]);
  });
});

describe('getRetentionLastSeenSeries', () => {
  it('buckets identified profiles by UTC days since their last event, on the JS clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2025-01-10T23:30:00Z') });
    try {
      const rows = await inDb(() => getRetentionLastSeenSeries({ projectId: PROJECT_ID }));
      expect(rows).toEqual([
        // WU1: 2025-01-06
        { days: 4, users: 1 },
        // WU2: 2024-12-30
        { days: 11, users: 1 },
        // RU1, RU2, RU4: 2024-03-06; RU5: 03-05; RU3: 03-04
        { days: 310, users: 3 },
        { days: 311, users: 1 },
        { days: 312, users: 1 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('processCohortData weighted average (pure)', () => {
  // Three weekly cohorts; reference date is 3 weeks after the oldest, so the
  // newer cohorts have not yet reached the later periods.
  const data = [
    {
      cohort_interval: '2024-01-07',
      total_first_event_count: 100,
      interval_0_user_count: 100,
      interval_1_user_count: 50,
      interval_2_user_count: 25,
      interval_3_user_count: 10,
    },
    {
      cohort_interval: '2024-01-14',
      total_first_event_count: 80,
      interval_0_user_count: 80,
      interval_1_user_count: 40,
      interval_2_user_count: 0, // genuine zero (mature) — must count
      interval_3_user_count: 0,
    },
    {
      cohort_interval: '2024-01-21',
      total_first_event_count: 60,
      interval_0_user_count: 60,
      interval_1_user_count: 30,
      interval_2_user_count: 0, // not yet mature — must be excluded
      interval_3_user_count: 0,
    },
  ];

  it('pools only mature cohorts and is internally consistent', () => {
    const rows = processCohortData(data, 3, 'week', '2024-01-28 00:00:00');
    const avg = rows[0]!;

    expect(avg.cohort_interval).toBe('Weighted Average');
    // Period 0 equals Total profiles and the curve starts at 100%.
    expect(avg.sum).toBe(80);
    expect(avg.values[0]).toBe(80);
    expect(avg.percentages[0]).toBe(1);
    // Period 2 pools C0+C1 only (C2 is immature). C1's genuine zero is included,
    // so it's 25/180 = 0.14 — NOT 25/100 = 0.25 (the old "exclude zeros" bug).
    expect(avg.percentages[2]).toBe(0.14);
    // Period 3 pools only C0 (C1, C2 immature): 10/100 = 0.10.
    expect(avg.percentages[3]).toBe(0.1);

    expect(avg.values).toEqual([80, 40, 11, 8]);
    expect(avg.percentages).toEqual([1, 0.5, 0.14, 0.1]);
  });

  it('treats all periods as mature when no reference date is given', () => {
    const rows = processCohortData(data, 3, 'week');
    const avg = rows[0]!;
    // Every cohort counts in every column: period 2 = 25/240, period 3 = 10/240.
    expect(avg.percentages[2]).toBe(round(25 / 240, 2));
    expect(avg.percentages[3]).toBe(round(10 / 240, 2));
  });
});
