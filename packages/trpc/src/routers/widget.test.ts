/**
 * The public widgets on Postgres (no golden covers them): the 30-day
 * visitor badge and the realtime widget's live data.
 */
import { db } from '@openpanel/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  type AnalyticsTestDb,
  anonymousContext,
  createAnalyticsTestDb,
  insertEvents,
  seedProject,
} from '../testing/analytics';
import { widgetRouter } from './widget';

const BADGE_PROJECT = 'widget-badge';
const LIVE_PROJECT = 'widget-live';

let testDb: AnalyticsTestDb;

async function createWidget(
  id: string,
  projectId: string,
  options: PrismaJson.IPrismaWidgetOptions,
  isPublic = true,
) {
  await db.shareWidget.create({
    data: {
      id,
      projectId,
      organizationId: `org-${projectId}`,
      public: isPublic,
      options,
    },
  });
}

const caller = () => widgetRouter.createCaller(anonymousContext());

beforeAll(async () => {
  testDb = await createAnalyticsTestDb();
  await testDb.inDb(async () => {
    await seedProject(BADGE_PROJECT, 'Europe/Stockholm');
    await createWidget('badge', BADGE_PROJECT, { type: 'counter' });
    await createWidget('hidden', BADGE_PROJECT, { type: 'counter' }, false);
    await insertEvents(BADGE_PROJECT, [
      // 30 days before 2026-11-15 13:00 CET is 2026-10-16 13:00 CEST
      // (11:00Z), not 720 hours earlier (12:00Z).
      { createdAt: '2026-10-16T11:30:00Z', profileId: 'p1' },
      { createdAt: '2026-10-16T10:30:00Z', profileId: 'p2' },
      { createdAt: '2026-11-10T09:00:00Z', profileId: 'p3' },
      { createdAt: '2026-11-15T11:00:00Z', profileId: 'p3' },
    ]);

    await seedProject(LIVE_PROJECT, 'UTC');
    await createWidget('live-all', LIVE_PROJECT, {
      type: 'realtime',
      countries: true,
      referrers: true,
      paths: true,
    });
    await createWidget('live-none', LIVE_PROJECT, {
      type: 'realtime',
      countries: false,
      referrers: false,
      paths: false,
    });
    await insertEvents(LIVE_PROJECT, [
      { createdAt: '2026-03-10T11:40:00Z', sessionId: 's1', profileId: 'p1', country: 'SE', path: '/pricing', referrerName: 'Google' },
      { createdAt: '2026-03-10T11:41:00Z', sessionId: 's1', profileId: 'p1', country: 'SE', path: '/docs', referrerName: 'Google' },
      { createdAt: '2026-03-10T11:50:00Z', sessionId: 's2', profileId: 'p2', country: 'DE', path: '/pricing' },
      { createdAt: '2026-03-10T11:55:00Z', sessionId: 's3', profileId: 'p3', path: '/pricing', referrerName: 'GitHub' },
      // Older than 30 minutes.
      { createdAt: '2026-03-10T11:00:00Z', sessionId: 's4', profileId: 'p4', country: 'SE', path: '/old', referrerName: 'Google' },
    ]);
  });
});

afterAll(async () => {
  vi.useRealTimers();
  await testDb?.drop();
});

const byName = <T extends Record<string, unknown>>(key: keyof T) => (a: T, b: T) =>
  String(a[key]).localeCompare(String(b[key]));

describe('widget.badge', () => {
  it('counts the visitors of the last 30 days on the project calendar', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-15T12:00:00Z') });

    const result = await testDb.inDb(() => caller().badge({ shareId: 'badge' }));

    expect(result).toEqual({ projectId: BADGE_PROJECT, visitors: 2 });
  });

  it('only serves public counter widgets', async () => {
    await expect(
      testDb.inDb(() => caller().badge({ shareId: 'hidden' })),
    ).rejects.toThrow('Widget not found');
    await expect(
      testDb.inDb(() => caller().badge({ shareId: 'live-all' })),
    ).rejects.toThrow('Invalid widget type');
  });
});

describe('widget.realtimeData', () => {
  it('returns the live count, the minute histogram and the enabled tops', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-10T12:00:00Z') });

    const result = await testDb.inDb(() =>
      caller().realtimeData({ shareId: 'live-all' }),
    );

    expect(result.projectId).toBe(LIVE_PROJECT);
    expect(result.project).toEqual({
      name: LIVE_PROJECT,
      domain: `https://${LIVE_PROJECT}.example.com`,
    });
    expect(result.liveCount).toBe(3);
    // 11:30 … 11:59, nothing in the current minute.
    expect(result.histogram).toHaveLength(30);
    expect(result.histogram[0]?.minute).toBe('2026-03-10 11:30:00');
    expect(
      result.histogram
        .filter((item) => item.sessionCount > 0)
        .map((item) => [item.minute, item.sessionCount, item.visitorCount]),
    ).toEqual([
      ['2026-03-10 11:40:00', 1, 1],
      ['2026-03-10 11:41:00', 1, 1],
      ['2026-03-10 11:50:00', 1, 1],
      ['2026-03-10 11:55:00', 1, 1],
    ]);
    expect(result.countries.sort(byName('country'))).toEqual([
      { country: 'DE', count: 1 },
      { country: 'SE', count: 1 },
    ]);
    expect(result.referrers.sort(byName('referrer'))).toEqual([
      { referrer: 'GitHub', count: 1 },
      { referrer: 'Google', count: 1 },
    ]);
    expect(result.paths).toEqual([
      { path: '/pricing', count: 3 },
      { path: '/docs', count: 1 },
    ]);
  });

  it('skips the tops the widget does not show', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-10T12:00:00Z') });

    const result = await testDb.inDb(() =>
      caller().realtimeData({ shareId: 'live-none' }),
    );

    expect(result.liveCount).toBe(3);
    expect(result.countries).toEqual([]);
    expect(result.referrers).toEqual([]);
    expect(result.paths).toEqual([]);
  });
});
