import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@openpanel/common/server';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import { applyEnvelopes } from './consumer';
import { buildEnvelope } from './envelope';
import { getBucketSessionId } from './session-id';
import { requestFingerprint, resolveSession, trackLookup } from './track-lookup';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

function inScope<T>(fn: () => Promise<T>) {
  return runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'hyperdrive' }, fn);
}

describe('trackLookup', () => {
  it('suppresses an identical request within 100 ms', async () => {
    const hash = requestFingerprint({ payload: { type: 'track', payload: { name: 'x' } }, ip: '1.2.3.4', origin: 'https://a.com', projectId: 'p' });
    expect(requestFingerprint({ payload: { payload: { name: 'x' }, type: 'track' }, ip: '1.2.3.4', origin: 'https://a.com', projectId: 'p' })).toBe(hash);

    const first = await inScope(() => trackLookup({ projectId: 'p', deviceIds: ['d'], dedupeHash: hash }));
    const second = await inScope(() => trackLookup({ projectId: 'p', deviceIds: ['d'], dedupeHash: hash }));
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const third = await inScope(() => trackLookup({ projectId: 'p', deviceIds: ['d'], dedupeHash: hash }));
    expect(third.duplicate).toBe(false);
    expect((await inScope(() => trackLookup({ projectId: 'p', deviceIds: ['d'] }))).duplicate).toBe(false);
  });

  it('reads live sessions of the candidate devices and resolves the session', async () => {
    const createdAt = new Date(Date.UTC(2026, 5, 8, 12, 0));
    await inScope(() =>
      applyEnvelopes([
        buildEnvelope('p-lookup', [
          {
            type: 'event',
            id: uuidv7(createdAt.getTime()),
            event: {
              name: 'screen_view', deviceId: 'previous-salt', profileId: '', projectId: 'p-lookup',
              sessionId: 'live-1', properties: {}, createdAt: createdAt.toISOString(),
              path: '/', origin: '', groups: [],
            },
          },
        ]),
      ]),
    );

    const lookup = await inScope(() =>
      trackLookup({ projectId: 'p-lookup', deviceIds: ['current-salt', 'previous-salt'] }),
    );
    expect(lookup.sessions.map((s) => [s.deviceId, s.sessionId])).toEqual([['previous-salt', 'live-1']]);

    // Within the idle window the live session (previous salt) wins.
    expect(
      resolveSession({
        projectId: 'p-lookup',
        deviceIds: ['current-salt', 'previous-salt'],
        sessions: lookup.sessions,
        eventTimeMs: createdAt.getTime() + 10 * 60_000,
      }),
    ).toEqual({ deviceId: 'previous-salt', sessionId: 'live-1' });

    // Past it, the primary device gets the deterministic bucket id.
    const later = createdAt.getTime() + 45 * 60_000;
    expect(
      resolveSession({
        projectId: 'p-lookup',
        deviceIds: ['current-salt', 'previous-salt'],
        sessions: lookup.sessions,
        eventTimeMs: later,
      }),
    ).toEqual({
      deviceId: 'current-salt',
      sessionId: getBucketSessionId({ projectId: 'p-lookup', deviceId: 'current-salt', eventMs: later }),
    });
  });
});
