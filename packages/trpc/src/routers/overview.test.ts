/**
 * overview.liveData on Postgres (no golden covers it): the last 30 minutes of
 * events, bucketed by the project's minutes, with empty minutes filled.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  type AnalyticsTestDb,
  createAnalyticsTestDb,
  grantRead,
  insertEvents,
  seedProject,
  signedInContext,
} from '../testing/analytics';
import { overviewRouter } from './overview';

const PROJECT = 'live-overview';
// 13:00:30 on the project's clock (Stockholm, CET): the window starts at
// 12:30:30 local.
const NOW = new Date('2026-03-10T12:00:30Z');

let testDb: AnalyticsTestDb;

beforeAll(async () => {
  testDb = await createAnalyticsTestDb();
  await testDb.inDb(async () => {
    await seedProject(PROJECT, 'Europe/Stockholm');
    await insertEvents(PROJECT, [
      // One second before the window.
      { createdAt: '2026-03-10T11:30:29Z', sessionId: 's0', profileId: 'p0', referrerName: 'Google' },
      // The window's first second: minute 12:30 local.
      { createdAt: '2026-03-10T11:30:30Z', sessionId: 's1', profileId: 'p1', referrerName: 'Google' },
      // Minute 12:45 local: three sessions, two visitors.
      { createdAt: '2026-03-10T11:45:10Z', sessionId: 's1', profileId: 'p1', referrerName: 'Google' },
      { createdAt: '2026-03-10T11:45:50Z', sessionId: 's2', profileId: 'p2', referrerName: 'GitHub' },
      { createdAt: '2026-03-10T11:45:55Z', sessionId: 's3', profileId: 'p2' },
      // The current minute, 13:00 local.
      { createdAt: '2026-03-10T12:00:10Z', sessionId: 's4', profileId: 'p3', referrerName: 'Google' },
    ]);
    await insertEvents('another-project', [
      { createdAt: '2026-03-10T11:50:00Z', sessionId: 'x1', profileId: 'x1', referrerName: 'Google' },
    ]);
  });
});

afterAll(async () => {
  vi.useRealTimers();
  await testDb?.drop();
});

describe('overview.liveData', () => {
  it('counts the last 30 minutes per project minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await grantRead(PROJECT);

    const result = await testDb.inDb(() =>
      overviewRouter
        .createCaller(signedInContext())
        .liveData({ projectId: PROJECT }),
    );

    expect(result.totalSessions).toBe(4);

    // 12:30 … 12:59 filled, plus the current minute because it has events.
    expect(result.minuteCounts).toHaveLength(31);
    expect(result.minuteCounts[0]?.minute).toBe('2026-03-10 12:30:00');
    expect(result.minuteCounts[30]?.minute).toBe('2026-03-10 13:00:00');
    const counts = Object.fromEntries(
      result.minuteCounts
        .filter((item) => item.sessionCount > 0)
        .map((item) => [item.minute, [item.sessionCount, item.visitorCount]]),
    );
    expect(counts).toEqual({
      '2026-03-10 12:30:00': [1, 1],
      '2026-03-10 12:45:00': [3, 2],
      '2026-03-10 13:00:00': [1, 1],
    });
    const quarter = result.minuteCounts.find(
      (item) => item.minute === '2026-03-10 12:45:00',
    );
    expect(
      quarter?.referrers.map((item) => item.referrer).sort(),
    ).toEqual(['GitHub', 'Google']);
    expect(
      result.minuteCounts.find((item) => item.minute === '2026-03-10 12:31:00'),
    ).toMatchObject({ sessionCount: 0, visitorCount: 0, referrers: [] });

    expect(result.referrers).toEqual([
      { referrer: 'Google', count: 2 },
      { referrer: 'GitHub', count: 1 },
    ]);
  });
});
