/**
 * The shared funnel query builder (buildFunnelBase) on Postgres.
 *
 * - The shapes the funnel chart and the funnel profile list
 *   (getFunnelProfiles) build go through EXPLAIN, which resolves every alias
 *   and column: a breakdown reading a join that was never added fails here —
 *   the bug class that made funnel "View Users" return "No users found" for
 *   profile-property and cohort breakdowns.
 * - Small datasets pin the semantics: the step pre-filter, entry-step
 *   breakdown attribution, group fan-out, strict vs non-strict ordering and
 *   the session's profile.
 * - Random events through buildFunnelBase are checked against the replay of
 *   ClickHouse's windowFunnel in test/fixtures/window-funnel-reference.ts.
 */
import { randomUUID } from 'node:crypto';
import { runWithScope } from '@openpanel/runtime';
import type { IChartBreakdown, IChartEventFilter, IReportInput } from '@openpanel/validation';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mockCohortFindMany = vi.hoisted(() => vi.fn());

vi.mock('../prisma-client', () => ({
  db: { cohort: { findMany: mockCohortFindMany } },
}));

import {
  seededRandom,
  windowFunnelReference,
} from '../../test/fixtures/window-funnel-reference';
import { anQuery } from '../analytics/client';
import type { Query } from '../analytics/query-builder';
import { compile, sql } from '../analytics/sql';
import { type EventWriteRow, insertEvents } from '../analytics/writers';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import { funnelService } from './funnel.service';

const PROJECT_ID = 'funnel-sql-test';
const COHORT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const START = '2026-04-14 00:00:00';
const END = '2026-05-15 00:00:00';

type ISeriesItem = IReportInput['series'][number];

const event = (overrides: Partial<ISeriesItem> = {}): ISeriesItem =>
  ({
    id: 'A',
    type: 'event',
    name: 'screen_view',
    segment: 'event',
    filters: [],
    ...overrides,
  }) as ISeriesItem;

const breakdown = (name: string): IChartBreakdown => ({ id: name, name });

const filter = (
  name: string,
  value: string[],
  operator: IChartEventFilter['operator'] = 'is',
): IChartEventFilter => ({ id: name, name, operator, value });

const SERIES = [event({ id: 'A' }), event({ id: 'B', name: 'sign_up' })];

let testDb: TestDatabase;

function inDb<T>(fn: () => Promise<T>): Promise<T> {
  return runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, fn);
}

async function explain(query: Query): Promise<void> {
  await inDb(() => anQuery(sql`EXPLAIN ${query.toSql()}`));
}

const text = (query: Query) => compile(query.toSql()).text;
const values = (query: Query) => compile(query.toSql()).values;

interface BaseOptions {
  projectId?: string;
  series?: ISeriesItem[];
  breakdowns?: IChartBreakdown[];
  funnelWindow?: number;
  funnelGroup?: string;
  startDate?: string;
  endDate?: string;
}

function funnelBase(options: BaseOptions = {}) {
  return funnelService.buildFunnelBase({
    projectId: options.projectId ?? PROJECT_ID,
    startDate: options.startDate ?? START,
    endDate: options.endDate ?? END,
    series: options.series ?? SERIES,
    breakdowns: options.breakdowns ?? [],
    funnelWindow: options.funnelWindow ?? 24,
    funnelGroup: options.funnelGroup,
    timezone: 'UTC',
  });
}

/** Mirrors what getFunnelProfiles builds on top of the shared base. */
async function buildProfilesQuery(breakdowns: IChartBreakdown[], series = SERIES) {
  const { query, breakdowns: resolved } = await funnelBase({ breakdowns, series });
  query.with('funnel', 'SELECT * FROM session_funnel WHERE level != 0');
  query.select(['DISTINCT profile_id']).from('funnel');
  query.rawWhere(sql`level >= ${2}`);
  return { query, breakdowns: resolved };
}

/** Mirrors what the funnel chart builds on top of the shared base. */
async function buildChartQuery(breakdowns: IChartBreakdown[], series = SERIES) {
  const { query, breakdowns: resolved } = await funnelBase({ breakdowns, series });
  const columns = resolved.map((_, index) => `b_${index}`);
  query.with('funnel', 'SELECT * FROM session_funnel WHERE level != 0');
  query
    .select(['level', ...columns, 'count(*) AS count'])
    .from('funnel')
    .groupBy(['level', ...columns]);
  return { query, breakdowns: resolved };
}

/** `session_funnel` rows keyed by the group key. */
async function sessionFunnel(
  options: BaseOptions,
): Promise<Map<string, Record<string, unknown> & { level: number }>> {
  const { query, group } = await funnelBase(options);
  query.select(['*']).from('session_funnel');
  const rows = await inDb(() => query.execute());
  return new Map(rows.map((row) => [row[group] as string, row]));
}

/** An events row of `projectId`; `at` is milliseconds after START (UTC). */
function eventRow(
  projectId: string,
  name: string,
  at: number,
  overrides: Partial<EventWriteRow> = {},
): EventWriteRow {
  const created = new Date(Date.parse(`${START.replace(' ', 'T')}Z`) + at);
  return {
    id: randomUUID(),
    name,
    device_id: 'device',
    profile_id: 'device',
    project_id: projectId,
    session_id: 'session',
    properties: {},
    created_at: created.toISOString(),
    ...overrides,
  };
}

beforeAll(async () => {
  mockCohortFindMany.mockResolvedValue([{ id: COHORT_ID, name: 'Power users' }]);
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('funnel.service / buildFunnelBase — profile breakdowns', () => {
  it('joins the profile for a profile.properties breakdown', async () => {
    const { query } = await buildProfilesQuery([breakdown('profile.properties.plan')]);
    const sqlText = text(query);
    // The breakdown reads a narrowed column of the joined profile.
    expect(sqlText).toContain('AS pp_0 FROM analytics.profiles');
    expect(sqlText).toContain('AS profile ON profile.id = e.profile_id');
    expect(sqlText).toContain("COALESCE(profile.pp_0, '')");
    expect(values(query)).toContain('plan');
    await explain(query);
  });

  it('joins the profile columns a top-level profile breakdown reads', async () => {
    const { query } = await buildProfilesQuery([breakdown('profile.email')]);
    expect(text(query)).toContain(', email FROM analytics.profiles');
    expect(text(query)).toContain("COALESCE(profile.email, '')");
    await explain(query);
  });

  it('joins the profile for a profile filter with no profile breakdown', async () => {
    const { query } = await buildProfilesQuery(
      [],
      [
        event({ filters: [filter('profile.properties.plan', ['pro'])] }),
        event({ id: 'B', name: 'sign_up' }),
      ],
    );
    expect(text(query)).toContain('AS profile ON profile.id = e.profile_id');
    await explain(query);
  });

  it('selects only the referenced property keys, not the whole map', async () => {
    const { query } = await buildProfilesQuery(
      [breakdown('profile.properties.experiment')],
      [
        event({ filters: [filter('profile.properties.plan', ['pro'])] }),
        event({ id: 'B', name: 'sign_up' }),
      ],
    );
    const sqlText = text(query);
    expect(sqlText).toContain('AS pp_0');
    expect(sqlText).toContain('AS pp_1');
    expect(sqlText).not.toMatch(/, properties FROM analytics\.profiles/);
    expect(sqlText).not.toContain('profile.properties');
    await explain(query);
  });

  it('leaves funnels without profile references unjoined', async () => {
    const { query } = await buildChartQuery([]);
    expect(text(query)).not.toContain('analytics.profiles');
  });
});

describe('funnel.service / buildFunnelBase — cohort breakdowns', () => {
  it('labels a cohort breakdown with the cohort name', async () => {
    const { query } = await buildProfilesQuery([breakdown(`cohort:${COHORT_ID}`)]);
    expect(text(query)).toContain('analytics.cohort_members');
    expect(values(query)).toEqual(expect.arrayContaining(['Power users', 'Not Power users']));
    await explain(query);
  });
});

describe('funnel.service / buildFunnelBase — unknown breakdowns', () => {
  it('drops the all-cohorts breakdown, which the funnel cannot render', async () => {
    const { query, breakdowns } = await buildProfilesQuery([breakdown('cohort')]);
    expect(breakdowns).toEqual([]);
    expect(text(query)).not.toContain('b_0');
    await explain(query);
  });

  it('drops names that are not a column, property or profile field', async () => {
    const { breakdowns } = await buildProfilesQuery([
      breakdown('not_a_real_column'),
      breakdown('profile.not_a_field'),
      breakdown('path'),
    ]);
    expect(breakdowns.map((b) => b.name)).toEqual(['path']);
  });

  it('drops unsupported breakdowns identically for chart and profiles', async () => {
    const breakdowns = [breakdown('cohort'), breakdown('profile.properties.plan')];
    const chart = await buildChartQuery(breakdowns);
    const profiles = await buildProfilesQuery(breakdowns);
    // Both sides must resolve the same breakdown to the same b_N index,
    // otherwise the breakdownValues filter targets the wrong column.
    expect(chart.breakdowns.map((b) => b.name)).toEqual(['profile.properties.plan']);
    expect(profiles.breakdowns).toEqual(chart.breakdowns);
    await explain(chart.query);
    await explain(profiles.query);
  });
});

describe('funnel.service / buildFunnelBase — group breakdowns and filters', () => {
  it('joins one row per group for a group breakdown', async () => {
    const { query } = await buildProfilesQuery([breakdown('group.properties.plan')]);
    expect(text(query)).toContain('CROSS JOIN LATERAL unnest(e.groups) AS _group_id');
    expect(text(query)).toContain('LEFT JOIN analytics.groups AS _g');
    await explain(query);
  });

  it('parses every breakdown kind together', async () => {
    const { query } = await buildChartQuery([
      breakdown('path'),
      breakdown('duration'),
      breakdown('properties.items.*.sku'),
      breakdown('has_profile'),
      breakdown('utm_source'),
      breakdown('profile.created_at'),
      breakdown('group.name'),
      breakdown(`cohort:${COHORT_ID}`),
    ]);
    await explain(query);
  });
});

describe('funnel.service / buildFunnelBase — semantics', () => {
  const MINUTE = 60_000;
  const project = 'funnel-semantics';

  beforeAll(async () => {
    await inDb(() =>
      insertEvents([
        // Pre-filter: s-pricing matches both steps, s-other only step 2.
        eventRow(project, 'screen_view', 0, { session_id: 's-pricing', path: '/pricing' }),
        eventRow(project, 'sign_up', MINUTE, { session_id: 's-pricing' }),
        eventRow(project, 'screen_view', 0, { session_id: 's-other', path: '/other' }),
        eventRow(project, 'sign_up', MINUTE, { session_id: 's-other' }),
        // Attribution: the experiment differs between the steps.
        eventRow(project, 'screen_view', 0, { session_id: 's-exp', properties: { experiment: 'a' } }),
        eventRow(project, 'sign_up', MINUTE, { session_id: 's-exp', properties: { experiment: 'b' } }),
        // Same-millisecond steps: strict mode never connects them.
        eventRow(project, 'screen_view', 5 * MINUTE, { session_id: 's-tie' }),
        eventRow(project, 'sign_up', 5 * MINUTE, { session_id: 's-tie' }),
        // Mid-session identify: the session belongs to the identified user.
        eventRow(project, 'screen_view', 0, { session_id: 's-identify', device_id: 'dev-1', profile_id: 'dev-1' }),
        eventRow(project, 'sign_up', MINUTE, { session_id: 's-identify', device_id: 'dev-1', profile_id: 'user-1' }),
        // Groups: fanned out per group; the ungrouped row drops out.
        eventRow(project, 'screen_view', 0, { session_id: 's-groups', groups: ['g1', 'g2'] }),
        eventRow(project, 'sign_up', MINUTE, { session_id: 's-groups', groups: ['g1'] }),
        eventRow(project, 'sign_up', 2 * MINUTE, { session_id: 's-groups' }),
      ]),
    );
  });

  it('only feeds rows matching a step, and levels by the first step', async () => {
    const series = [
      event({ filters: [filter('path', ['/pricing'])] }),
      event({ id: 'B', name: 'sign_up' }),
    ];
    const { query } = await funnelBase({ projectId: project, series });
    query.select(['session_id', 'count(*) AS rows']).from('funnel_rows').groupBy(['session_id']);
    const rows = await inDb(() => query.execute());
    const bySession = Object.fromEntries(rows.map((row) => [row.session_id, row.rows]));
    expect(bySession['s-pricing']).toBe(2);
    // The /other screen_view fails the step filter; its sign_up still counts.
    expect(bySession['s-other']).toBe(1);

    const funnel = await sessionFunnel({ projectId: project, series });
    expect(funnel.get('s-pricing')?.level).toBe(2);
    expect(funnel.get('s-other')?.level).toBe(0);
  });

  it('attributes breakdowns at the entry step', async () => {
    const funnel = await sessionFunnel({
      projectId: project,
      breakdowns: [breakdown('properties.experiment')],
    });
    // One row: the sequence isn't split by the per-row value.
    expect(funnel.get('s-exp')).toMatchObject({ level: 2, b_0: 'a' });
  });

  it('keeps group breakdowns per row (a user in two groups is in both)', async () => {
    const { query } = await funnelBase({
      projectId: project,
      breakdowns: [breakdown('group.id')],
    });
    query
      .select(['session_id', 'b_0', 'level'])
      .from('session_funnel')
      .rawWhere(sql`session_id = ${'s-groups'}::text`)
      .orderBy('b_0');
    const rows = await inDb(() => query.execute());
    expect(rows).toEqual([
      { session_id: 's-groups', b_0: 'g1', level: 2 },
      { session_id: 's-groups', b_0: 'g2', level: 1 },
    ]);
  });

  it('needs strictly increasing timestamps unless FUNNEL_NON_STRICT_ORDERING is set', async () => {
    vi.stubEnv('FUNNEL_NON_STRICT_ORDERING', '');
    expect((await sessionFunnel({ projectId: project })).get('s-tie')?.level).toBe(1);
    vi.stubEnv('FUNNEL_NON_STRICT_ORDERING', '1');
    expect((await sessionFunnel({ projectId: project })).get('s-tie')?.level).toBe(2);
    vi.stubEnv('FUNNEL_NON_STRICT_ORDERING', 'true');
    expect((await sessionFunnel({ projectId: project })).get('s-tie')?.level).toBe(2);
  });

  it("gives a session the profile of its latest step row", async () => {
    const funnel = await sessionFunnel({ projectId: project });
    expect(funnel.get('s-identify')).toMatchObject({ level: 2, profile_id: 'user-1' });
  });

  it('groups by profile across sessions with funnelGroup profile_id', async () => {
    const funnel = await sessionFunnel({ projectId: project, funnelGroup: 'profile_id' });
    // dev-1 only has the screen_view; user-1 only the sign_up.
    expect(funnel.get('dev-1')?.level).toBe(1);
    expect(funnel.get('user-1')?.level).toBe(0);
  });
});

describe('funnel.service / buildFunnelBase — windowFunnel against the ClickHouse replay', () => {
  const project = 'funnel-property';
  const NAMES = ['A', 'B', 'C'] as const;
  const rows: EventWriteRow[] = [];
  const random = seededRandom(97);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

  beforeAll(async () => {
    // Profiles with a few sessions an hour apart; events within a session
    // land on whole seconds (ties) or on milliseconds.
    for (let profile = 0; profile < 25; profile++) {
      const sessions = int(1, 3);
      for (let session = 0; session < sessions; session++) {
        const base = profile * 86_400_000 + session * 3_600_000;
        const jitter = random() < 0.3;
        for (let index = int(1, 8); index > 0; index--) {
          rows.push(
            eventRow(project, pick(NAMES), base + int(0, 30) * 1000 + (jitter ? int(0, 999) : 0), {
              session_id: `p${profile}-s${session}`,
              profile_id: `p${profile}`,
              device_id: `p${profile}`,
              properties: { k: pick(['x', 'y']) },
            }),
          );
        }
      }
    }
    await inDb(() => insertEvents(rows));
  });

  it('matches the replay for random funnels, groupings, windows and modes', async () => {
    let compared = 0;
    for (let round = 0; round < 24; round++) {
      const steps = Array.from({ length: int(1, 4) }, () => ({
        name: pick(NAMES),
        k: random() < 0.3 ? pick(['x', 'y']) : undefined,
      }));
      const series = steps.map((step, index) =>
        event({
          id: String(index),
          name: step.name,
          filters: step.k ? [filter('properties.k', [step.k])] : [],
        }),
      );
      const funnelWindow = pick([0, 0.0025, 0.005, 1, 24, 720]);
      const windowMs = funnelWindow * 3600 * 1000;
      const matches = (row: EventWriteRow) =>
        steps.map((step) => row.name === step.name && (!step.k || row.properties.k === step.k));

      for (const funnelGroup of ['session_id', 'profile_id'] as const) {
        for (const strictIncrease of [true, false]) {
          vi.stubEnv('FUNNEL_NON_STRICT_ORDERING', strictIncrease ? '' : '1');
          const byKey = new Map<string, EventWriteRow[]>();
          for (const row of rows) {
            if (matches(row).some(Boolean)) {
              const key = row[funnelGroup];
              byKey.set(key, [...(byKey.get(key) ?? []), row]);
            }
          }
          const expected = Object.fromEntries(
            [...byKey].map(([key, keyRows]) => [
              key,
              windowFunnelReference(
                keyRows.map((row) => ({ t: Date.parse(row.created_at), matches: matches(row) })),
                steps.length,
                windowMs,
                strictIncrease,
              ),
            ]),
          );
          const funnel = await sessionFunnel({
            projectId: project,
            series,
            funnelWindow,
            funnelGroup,
            endDate: '2026-06-30 00:00:00',
          });
          const actual = Object.fromEntries([...funnel].map(([key, row]) => [key, row.level]));
          expect(actual, JSON.stringify({ steps, funnelWindow, funnelGroup, strictIncrease })).toEqual(
            expected,
          );
          compared += byKey.size;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  }, 60_000);
});
