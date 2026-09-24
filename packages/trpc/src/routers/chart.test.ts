/**
 * The chart router's own analytics queries on Postgres, beyond the goldens:
 * which bucket a clicked data point stands for (getProfiles), and the
 * profile list over the funnel builder's query (getFunnelProfiles).
 */
import { funnelService } from '@openpanel/db';
import { clix } from '@openpanel/db/src/analytics/query-builder';
import type { IChartEventFilter } from '@openpanel/validation';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  type AnalyticsTestDb,
  createAnalyticsTestDb,
  grantRead,
  insertEvents,
  insertGroups,
  insertProfiles,
  seedProject,
  signedInContext,
} from '../testing/analytics';
import { chartRouter } from './chart';

const PROJECT = 'chart-profiles';
const PROFILE_IDS = ['pA', 'pB', 'pC', 'pD', 'pE'];

let testDb: AnalyticsTestDb;

beforeAll(async () => {
  testDb = await createAnalyticsTestDb();
  await testDb.inDb(async () => {
    await seedProject(PROJECT, 'Europe/Stockholm');
    await insertProfiles(PROJECT, [
      { id: 'pA', properties: { plan: 'pro' } },
      { id: 'pB', properties: { plan: 'free' } },
      { id: 'pC', properties: { plan: 'pro' } },
      { id: 'pD' },
      { id: 'pE' },
      { id: 'p1' },
      { id: 'p2' },
      { id: 'p3' },
      { id: 'p5' },
    ]);
    await insertGroups(PROJECT, [
      { id: 'acme', name: 'Acme' },
      { id: 'globex', name: 'Globex' },
    ]);
    await insertEvents(PROJECT, [
      // 2026-03-08 is a Sunday.
      { createdAt: '2026-03-08T10:15:00Z', profileId: 'pA', groups: ['acme'] },
      { createdAt: '2026-03-10T10:59:59Z', profileId: 'pB', groups: ['acme'] },
      { createdAt: '2026-03-10T11:00:00Z', profileId: 'pC', groups: ['globex'] },
      { createdAt: '2026-03-14T23:59:59Z', profileId: 'pD' },
      { createdAt: '2026-03-15T00:00:00Z', profileId: 'pE' },
      { createdAt: '2026-03-10T11:00:00Z', profileId: 'pE', name: 'button_click' },
    ]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  vi.useRealTimers();
  await testDb?.drop();
});

async function getProfiles(
  interval: 'minute' | 'hour' | 'day' | 'week' | 'month',
  date: string,
  options: {
    filters?: IChartEventFilter[];
    breakdowns?: Record<string, string>;
  } = {},
) {
  await grantRead(PROJECT);
  const profiles = await testDb.inDb(() =>
    chartRouter.createCaller(signedInContext()).getProfiles({
      projectId: PROJECT,
      date,
      interval,
      series: [
        {
          type: 'event',
          name: 'screen_view',
          segment: 'event',
          filters: options.filters ?? [],
        },
      ],
      breakdowns: options.breakdowns,
    }),
  );
  return profiles.map((profile) => profile.id).sort();
}

describe('chart.getProfiles', () => {
  it('reads the bucket the chart sent, in UTC', async () => {
    // Weeks start on Sunday (toStartOfWeek's mode 0).
    expect(await getProfiles('week', '2026-03-08T00:00:00.000Z')).toEqual([
      'pA',
      'pB',
      'pC',
      'pD',
    ]);
    // A day bucket ignores the time of day.
    expect(await getProfiles('day', '2026-03-10T15:00:00.000Z')).toEqual([
      'pB',
      'pC',
    ]);
    expect(await getProfiles('hour', '2026-03-10T11:00:00.000Z')).toEqual([
      'pC',
    ]);
    expect(await getProfiles('minute', '2026-03-10T10:59:00.000Z')).toEqual([
      'pB',
    ]);
    expect(await getProfiles('month', '2026-03-01T00:00:00.000Z')).toEqual(
      PROFILE_IDS,
    );
  });

  it('finds nobody for a date that starts no bucket', async () => {
    expect(await getProfiles('week', '2026-03-09T00:00:00.000Z')).toEqual([]);
    expect(await getProfiles('hour', '2026-03-10T11:30:00.000Z')).toEqual([]);
    expect(await getProfiles('month', '2026-03-02T00:00:00.000Z')).toEqual([]);
  });

  it('applies profile filters and group breakdowns', async () => {
    const proFilter: IChartEventFilter = {
      id: 'f1',
      name: 'profile.properties.plan',
      operator: 'is',
      value: ['pro'],
    };
    expect(
      await getProfiles('month', '2026-03-01T00:00:00.000Z', {
        filters: [proFilter],
      }),
    ).toEqual(['pA', 'pC']);
    expect(
      await getProfiles('month', '2026-03-01T00:00:00.000Z', {
        breakdowns: { 'group.name': 'Acme' },
      }),
    ).toEqual(['pA', 'pB']);
    expect(
      await getProfiles('month', '2026-03-01T00:00:00.000Z', {
        filters: [proFilter],
        breakdowns: { 'group.name': 'Acme' },
      }),
    ).toEqual(['pA']);
  });
});

describe('chart.getFunnelProfiles', () => {
  /**
   * The funnel builder's query: a `session_funnel` CTE with the level each
   * profile reached and its breakdown value (b_0).
   */
  function stubFunnel() {
    const query = clix('UTC').with(
      'session_funnel',
      `SELECT * FROM (VALUES
        ('p1', 2, ' a '),
        ('p2', 1, NULL),
        ('p3', 2, ''),
        ('p4', 0, 'a'),
        ('p5', 2, 'b')
      ) AS t(profile_id, level, b_0)`,
    );
    vi.spyOn(funnelService, 'buildFunnelBase').mockResolvedValue({
      query,
      eventSeries: [],
      breakdowns: [{ name: 'properties.variant' }],
      group: 'session_id',
    } as never);
  }

  async function funnelProfiles(
    stepIndex: number,
    showDropoffs: boolean,
    breakdownValues?: string[],
  ) {
    stubFunnel();
    await grantRead(PROJECT);
    const profiles = await testDb.inDb(() =>
      chartRouter.createCaller(signedInContext()).getFunnelProfiles({
        projectId: PROJECT,
        range: '30d',
        series: [
          { type: 'event', name: 'screen_view', segment: 'event', filters: [] },
          { type: 'event', name: 'button_click', segment: 'event', filters: [] },
        ],
        stepIndex,
        showDropoffs,
        breakdowns: [{ name: 'properties.variant' }],
        breakdownValues,
      }),
    );
    return profiles.map((profile) => profile.id).sort();
  }

  it('lists the profiles that reached a step, or dropped off at it', async () => {
    expect(await funnelProfiles(1, false)).toEqual(['p1', 'p3', 'p5']);
    expect(await funnelProfiles(0, true)).toEqual(['p2']);
  });

  it('matches breakdown values as the chart displays them', async () => {
    // Trimmed…
    expect(await funnelProfiles(1, false, ['a'])).toEqual(['p1']);
    // …and empty or missing values as "Not set".
    expect(await funnelProfiles(1, false, ['Not set'])).toEqual(['p3']);
    expect(await funnelProfiles(0, true, ['Not set'])).toEqual(['p2']);
  });
});
