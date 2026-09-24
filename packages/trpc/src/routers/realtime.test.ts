/**
 * realtime.coordinates on Postgres (no golden covers it): sessions per place
 * over the last 30 minutes, for the realtime map.
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
import { realtimeRouter } from './realtime';

const PROJECT = 'realtime-map';
const NOW = new Date('2026-03-10T12:00:00Z');

const BERLIN = { country: 'DE', city: 'Berlin', latitude: 52.52, longitude: 13.405 };
const GOTEBORG = {
  country: 'SE',
  city: 'Göteborg',
  latitude: 57.7089,
  longitude: 11.9746,
};

let testDb: AnalyticsTestDb;

beforeAll(async () => {
  testDb = await createAnalyticsTestDb();
  await testDb.inDb(async () => {
    await seedProject(PROJECT, 'UTC');
    await insertEvents(PROJECT, [
      // Two Berlin sessions, one of them with two events.
      { createdAt: '2026-03-10T11:40:00Z', sessionId: 's1', ...BERLIN },
      { createdAt: '2026-03-10T11:41:00Z', sessionId: 's1', ...BERLIN },
      { createdAt: '2026-03-10T11:50:00Z', sessionId: 's2', ...BERLIN },
      { createdAt: '2026-03-10T11:55:00Z', sessionId: 's3', ...GOTEBORG },
      // No coordinates.
      { createdAt: '2026-03-10T11:50:00Z', sessionId: 's4', country: 'SE' },
      // Older than 30 minutes.
      { createdAt: '2026-03-10T11:29:59Z', sessionId: 's5', ...BERLIN },
    ]);
  });
});

afterAll(async () => {
  vi.useRealTimers();
  await testDb?.drop();
});

describe('realtime.coordinates', () => {
  it('counts the sessions of each place in the last 30 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    await grantRead(PROJECT);

    const points = await testDb.inDb(() =>
      realtimeRouter
        .createCaller(signedInContext())
        .coordinates({ projectId: PROJECT }),
    );

    expect(points).toEqual([
      { country: 'DE', city: 'Berlin', long: 13.405, lat: 52.52, count: 2 },
      { country: 'SE', city: 'Göteborg', long: 11.9746, lat: 57.7089, count: 1 },
    ]);
  });
});
