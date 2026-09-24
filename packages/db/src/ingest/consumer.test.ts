import { runWithScope } from '@openpanel/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@openpanel/common/server';
import { anQuery } from '../analytics/client';
import { sql } from '../analytics/sql';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import { applyEnvelopes } from './consumer';
import {
  type EventsEnvelope,
  type IngestRecord,
  buildEnvelope,
} from './envelope';
import { reapIdleSessions } from './reaper';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

function inScope<T>(fn: () => Promise<T>) {
  return runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, fn);
}

const T0 = Date.UTC(2026, 5, 8, 12, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

function event(
  projectId: string,
  deviceId: string,
  minutes: number,
  overrides: Partial<Extract<IngestRecord, { type: 'event' }>['event']> = {},
  detached?: 'server' | 'past',
): IngestRecord {
  return {
    type: 'event',
    id: uuidv7(T0 + minutes * 60_000),
    ...(detached ? { detached } : {}),
    event: {
      name: 'screen_view',
      deviceId,
      profileId: '',
      projectId,
      sessionId: `hint-${deviceId}`,
      properties: { __query: { utm_source: 'google' }, __title: 'Home' },
      createdAt: at(minutes).toISOString(),
      path: '/home',
      origin: 'https://example.com',
      referrer: 'https://www.google.com/',
      referrerName: 'Google',
      referrerType: 'search',
      country: 'SE',
      browser: 'Chrome',
      groups: [],
      ...overrides,
    },
  };
}

function envelope(projectId: string, records: IngestRecord[]): EventsEnvelope {
  return buildEnvelope(projectId, records);
}

async function rows<T extends Record<string, unknown>>(query: ReturnType<typeof sql>) {
  return inScope(() => anQuery<T>(query));
}

describe('applyEnvelopes', () => {
  it('opens a session, emits session_start and fills the rollups', async () => {
    const projectId = 'p-basic';
    const result = await inScope(() =>
      applyEnvelopes(
        [
          envelope(projectId, [
            event(projectId, 'd1', 0),
            event(projectId, 'd1', 2, { path: '/pricing' }),
            event(projectId, 'd1', 3, { name: 'button_click', path: '/pricing', properties: { button: 'cta' } }),
          ]),
        ],
        { now: at(3) },
      ),
    );
    expect(result.appliedRecords).toBe(3);

    const events = await rows<{ name: string; session_id: string; referrer_name: string }>(
      sql`SELECT name, session_id, referrer_name FROM analytics.events WHERE project_id = ${projectId} ORDER BY created_at`,
    );
    expect(events.map((e) => e.name)).toEqual(['session_start', 'screen_view', 'screen_view', 'button_click']);
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set(['hint-d1']));

    const [session] = await rows<Record<string, unknown>>(
      sql`SELECT * FROM analytics.sessions WHERE project_id = ${projectId}`,
    );
    expect(session).toMatchObject({
      id: 'hint-d1',
      screen_view_count: 2,
      event_count: 1,
      is_bounce: false,
      entry_path: '/home',
      exit_path: '/pricing',
      utm_source: 'google',
      duration: 180_000,
      version: 3,
    });

    const [live] = await rows<{ session_id: string }>(
      sql`SELECT session_id FROM analytics.live_sessions WHERE project_id = ${projectId}`,
    );
    expect(live?.session_id).toBe('hint-d1');

    const names = await rows<{ name: string; event_count: number }>(
      sql`SELECT name, event_count FROM analytics.event_names WHERE project_id = ${projectId} ORDER BY name`,
    );
    expect(names).toEqual([
      { name: 'button_click', event_count: 1 },
      { name: 'screen_view', event_count: 2 },
      { name: 'session_start', event_count: 1 },
    ]);
    const keys = await rows<{ property_key: string }>(
      sql`SELECT property_key FROM analytics.event_property_keys WHERE project_id = ${projectId} AND name = 'screen_view' ORDER BY property_key`,
    );
    expect(keys.map((k) => k.property_key)).toEqual(['__query.utm_source', '__title']);
  });

  it('applies a redelivered batch exactly once', async () => {
    const projectId = 'p-redeliver';
    const batch = [envelope(projectId, [event(projectId, 'd1', 0), event(projectId, 'd1', 1)])];
    await inScope(() => applyEnvelopes(batch, { now: at(1) }));
    const snapshot = async () =>
      rows(sql`
        SELECT
          (SELECT count(*) FROM analytics.events WHERE project_id = ${projectId}) AS events,
          (SELECT json_agg(s ORDER BY s.id) FROM analytics.sessions s WHERE project_id = ${projectId}) AS sessions,
          (SELECT json_agg(n ORDER BY n.name) FROM analytics.event_names n WHERE project_id = ${projectId}) AS names
      `);
    const before = await snapshot();
    const again = await inScope(() => applyEnvelopes(batch, { now: at(1) }));
    expect(again.appliedRecords).toBe(0);
    expect(again.skippedRecords).toBe(2);
    expect(await snapshot()).toEqual(before);
  });

  it('splits on an idle gap, closes the first session and never reuses its id', async () => {
    const projectId = 'p-boundary';
    await inScope(() => applyEnvelopes([envelope(projectId, [event(projectId, 'd1', 0)])], { now: at(0) }));
    // The API still saw the first session live and sent its id as the hint.
    const result = await inScope(() =>
      applyEnvelopes([envelope(projectId, [event(projectId, 'd1', 45)])], { now: at(45) }),
    );
    expect(result.closedSessions.map((s) => s.id)).toEqual(['hint-d1']);

    const sessions = await rows<{ id: string }>(
      sql`SELECT id FROM analytics.sessions WHERE project_id = ${projectId} ORDER BY created_at`,
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.id).not.toBe('hint-d1');

    const signals = await rows<{ name: string; session_id: string; properties: Record<string, string> }>(
      sql`SELECT name, session_id, properties FROM analytics.events WHERE project_id = ${projectId} AND name IN ('session_start', 'session_end') ORDER BY created_at`,
    );
    expect(signals.map((s) => [s.name, s.session_id])).toEqual([
      ['session_start', 'hint-d1'],
      ['session_end', 'hint-d1'],
      ['session_start', sessions[1]!.id],
    ]);
    expect(signals[1]!.properties.__bounce).toBe('true');
  });

  it('serializes concurrent consumers on one device (no split sessions)', async () => {
    const projectId = 'p-concurrent';
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        inScope(() =>
          applyEnvelopes([envelope(projectId, [event(projectId, 'd1', index)])], { now: at(index) }),
        ),
      ),
    );
    const sessions = await rows<{ id: string; screen_view_count: number }>(
      sql`SELECT id, screen_view_count FROM analytics.sessions WHERE project_id = ${projectId}`,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.screen_view_count).toBe(6);
    const [{ starts }] = (await rows<{ starts: number }>(
      sql`SELECT count(*) AS starts FROM analytics.events WHERE project_id = ${projectId} AND name = 'session_start'`,
    )) as [{ starts: number }];
    expect(starts).toBe(1);
  });

  it('attaches server-side events to the profile’s live session', async () => {
    const projectId = 'p-detached';
    await inScope(() =>
      applyEnvelopes(
        [envelope(projectId, [event(projectId, 'd1', 0, { profileId: 'user-1' })])],
        { now: at(0) },
      ),
    );
    await inScope(() =>
      applyEnvelopes(
        [
          envelope(projectId, [
            event(projectId, '', 1, { name: 'invoice_paid', profileId: 'user-1', path: '', browser: '' }, 'server'),
            event(projectId, 'd9', 2, { name: 'imported', profileId: 'user-2' }, 'past'),
          ]),
        ],
        { now: at(2) },
      ),
    );
    const detached = await rows<{ name: string; session_id: string; device_id: string; path: string; browser: string }>(
      sql`SELECT name, session_id, device_id, path, browser FROM analytics.events WHERE project_id = ${projectId} AND name IN ('invoice_paid', 'imported') ORDER BY created_at`,
    );
    expect(detached).toEqual([
      { name: 'invoice_paid', session_id: 'hint-d1', device_id: 'd1', path: '/home', browser: 'Chrome' },
      { name: 'imported', session_id: '', device_id: '', path: '/home', browser: 'Chrome' },
    ]);
  });

  it('merges profiles and applies increments exactly once', async () => {
    const projectId = 'p-profiles';
    const identify: IngestRecord = {
      type: 'profile',
      id: uuidv7(T0),
      profile: {
        id: 'user-1',
        projectId,
        firstName: 'Ada',
        email: 'ada@example.com',
        isExternal: true,
        properties: { plan: 'pro', visits: '2', nested: { a: 1 } },
        groups: ['acme'],
      },
    };
    const increment: IngestRecord = {
      type: 'profile_op',
      id: uuidv7(T0 + 1),
      projectId,
      profileId: 'user-1',
      property: 'visits',
      delta: 3,
    };
    const batch = [envelope(projectId, [identify, increment])];
    await inScope(() => applyEnvelopes(batch, { now: at(0) }));
    await inScope(() => applyEnvelopes(batch, { now: at(0) }));
    await inScope(() =>
      applyEnvelopes(
        [
          envelope(projectId, [
            {
              type: 'profile',
              id: uuidv7(T0 + 2),
              profile: { id: 'user-1', projectId, isExternal: true, lastName: 'Lovelace', properties: { plan: '' }, groups: ['globex'] },
            },
          ]),
        ],
        { now: at(1) },
      ),
    );
    const [profile] = await rows<Record<string, unknown>>(
      sql`SELECT first_name, last_name, email, properties, groups FROM analytics.profiles WHERE project_id = ${projectId}`,
    );
    expect(profile).toEqual({
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      properties: { plan: 'pro', visits: '5', nested: '{"a":1}' },
      groups: ['acme', 'globex'],
    });
  });

  it('merges group properties', async () => {
    const projectId = 'p-groups';
    const group = (properties: Record<string, unknown>): IngestRecord => ({
      type: 'group',
      id: uuidv7(),
      group: { id: 'acme', projectId, type: 'company', name: 'Acme', properties },
    });
    await inScope(() => applyEnvelopes([envelope(projectId, [group({ plan: 'pro', seats: 5 })])]));
    await inScope(() => applyEnvelopes([envelope(projectId, [group({ billing: { country: 'SE' } })])]));
    const [row] = await rows<{ properties: Record<string, string> }>(
      sql`SELECT properties FROM analytics.groups WHERE project_id = ${projectId}`,
    );
    expect(row!.properties).toEqual({ plan: 'pro', seats: '5', 'billing.country': 'SE' });
  });
});

describe('applyEnvelopes (ported worker scenarios)', () => {
  it('emits session_start once across separate batches (new → extend → extend)', async () => {
    const projectId = 'p-rapid';
    for (const minute of [0, 1, 2]) {
      await inScope(() =>
        applyEnvelopes([envelope(projectId, [event(projectId, 'd1', minute)])], {
          now: at(minute),
        }),
      );
    }
    const names = await rows<{ name: string }>(
      sql`SELECT name FROM analytics.events WHERE project_id = ${projectId} ORDER BY created_at`,
    );
    expect(names.map((row) => row.name)).toEqual([
      'session_start',
      'screen_view',
      'screen_view',
      'screen_view',
    ]);
  });

  it('gives events the referrer of their session', async () => {
    const projectId = 'p-referrer';
    await inScope(() =>
      applyEnvelopes(
        [
          envelope(projectId, [
            event(projectId, 'd1', 0),
            event(projectId, 'd1', 1, {
              path: '/next',
              referrer: '',
              referrerName: '',
              referrerType: '',
            }),
          ]),
        ],
        { now: at(1) },
      ),
    );
    const events = await rows<{ path: string; referrer: string; referrer_name: string; referrer_type: string }>(
      sql`SELECT path, referrer, referrer_name, referrer_type FROM analytics.events WHERE project_id = ${projectId} AND name = 'screen_view' ORDER BY created_at`,
    );
    expect(events[1]).toEqual({
      path: '/next',
      referrer: 'https://www.google.com/',
      referrer_name: 'Google',
      referrer_type: 'search',
    });
  });

  it('stores a server event without any live session as sessionless', async () => {
    const projectId = 'p-server-alone';
    await inScope(() =>
      applyEnvelopes(
        [
          envelope(projectId, [
            event(projectId, '', 0, { name: 'webhook', profileId: 'nobody', sessionId: '' }, 'server'),
          ]),
        ],
        { now: at(0) },
      ),
    );
    const events = await rows<{ name: string; session_id: string; device_id: string }>(
      sql`SELECT name, session_id, device_id FROM analytics.events WHERE project_id = ${projectId}`,
    );
    expect(events).toEqual([{ name: 'webhook', session_id: '', device_id: '' }]);
    const sessions = await rows<{ id: string }>(
      sql`SELECT id FROM analytics.sessions WHERE project_id = ${projectId}`,
    );
    expect(sessions).toEqual([]);
  });

  it('strips NUL characters instead of failing the batch', async () => {
    const projectId = 'p-nul';
    // Built by hand: an older API didn't strip them before queuing.
    const raw: EventsEnvelope = {
      v: 1,
      projectId,
      records: [
        event(projectId, 'd1', 0, {
          name: 'nul\u0000event',
          path: '/a\u0000b',
          properties: { 'k\u0000ey': 'va\u0000lue' },
        }),
      ],
    };
    await inScope(() => applyEnvelopes([raw], { now: at(0) }));
    const events = await rows<{ name: string; path: string; properties: Record<string, string> }>(
      sql`SELECT name, path, properties FROM analytics.events WHERE project_id = ${projectId} AND name <> 'session_start'`,
    );
    expect(events).toEqual([{ name: 'nulevent', path: '/ab', properties: { key: 'value' } }]);
  });

  it('clamps revenue that doesn’t fit a bigint', async () => {
    const projectId = 'p-revenue';
    await inScope(() =>
      applyEnvelopes(
        [envelope(projectId, [event(projectId, 'd1', 0, { name: 'revenue', revenue: 1e30 })])],
        { now: at(0) },
      ),
    );
    const [row] = await rows<{ revenue: number }>(
      sql`SELECT revenue FROM analytics.events WHERE project_id = ${projectId} AND name = 'revenue'`,
    );
    expect(row?.revenue).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('reapIdleSessions', () => {
  it('closes idle sessions and skips rows a consumer holds', async () => {
    const projectId = 'p-reaper';
    await inScope(() =>
      applyEnvelopes(
        [envelope(projectId, [event(projectId, 'd1', 0), event(projectId, 'd2', 0)])],
        { now: at(0) },
      ),
    );

    // Hold d2's row as a consumer would while extending it.
    const holder = new pg.Client({ connectionString: testDb.url });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(
      "SELECT 1 FROM analytics.live_sessions WHERE project_id = $1 AND device_id = 'd2' FOR UPDATE",
      [projectId],
    );
    // Other tests' sessions in this database are idle too; look at ours.
    const ours = <T extends { project_id?: string; payload?: { projectId: string } }>(items: T[]) =>
      items.filter((item) => (item.project_id ?? item.payload?.projectId) === projectId);
    try {
      const reaped = await inScope(() => reapIdleSessions({ now: at(40) }));
      expect(ours(reaped.closed).map((s) => s.device_id)).toEqual(['d1']);
      expect(ours(reaped.insertedEvents).map((e) => e.payload.name)).toEqual(['session_end']);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }

    const live = await rows<{ device_id: string }>(
      sql`SELECT device_id FROM analytics.live_sessions WHERE project_id = ${projectId} ORDER BY device_id`,
    );
    expect(live.map((l) => l.device_id)).toEqual(['d2']);

    const again = await inScope(() => reapIdleSessions({ now: at(40) }));
    expect(ours(again.closed).map((s) => s.device_id)).toEqual(['d2']);
    expect(await inScope(() => reapIdleSessions({ now: at(40) }))).toEqual({ closed: [], insertedEvents: [] });
  });
});
