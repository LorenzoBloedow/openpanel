/**
 * The ingest routes end to end in Node: Hono app → one Postgres round trip
 * (test database) → the envelope handed to the events queue. The consumer
 * that applies envelopes is tested in packages/db.
 */
import { anQuery } from '@openpanel/db/src/analytics/client';
import { sql } from '@openpanel/db/src/analytics/sql';
import type {
  EventsEnvelope,
  IngestRecord,
} from '@openpanel/db/src/ingest/envelope';
import { getBucketSessionId } from '@openpanel/db/src/ingest/session-id';
import { db } from '@openpanel/db/src/prisma-client';
import {
  type TestDatabase,
  createTestDatabase,
} from '@openpanel/db/src/testing/database';
import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { app } from '@/app';

let testDb: TestDatabase;
let sent: EventsEnvelope[] = [];

const ORG_ID = 'org-ingest';
const PROJECT_ID = 'project-ingest';
const FILTERED_PROJECT_ID = 'project-filtered';
const CLIENT_ID = '5b0e9a47-1c0e-4d8a-9a51-6f2a3c1d0001';
const FILTERED_CLIENT_ID = '5b0e9a47-1c0e-4d8a-9a51-6f2a3c1d0002';
const IMPORT_CLIENT_ID = '5b0e9a47-1c0e-4d8a-9a51-6f2a3c1d0003';
const ORIGIN = 'https://shop.example.com';
const IP = '203.0.113.7';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function env() {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: testDb.url,
    HYPERDRIVE: { connectionString: testDb.url },
    EVENTS_QUEUE: {
      send: async (body: EventsEnvelope) => {
        sent.push(JSON.parse(JSON.stringify(body)));
      },
    },
  } as unknown as Env;
}

async function request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const environment = env();
  return runWithScope({ env: environment, route: 'hyperdrive' }, () =>
    app.request(path, init, environment),
  );
}

function trackRequest(
  body: unknown,
  headers: Record<string, string> = {},
  clientId = CLIENT_ID,
) {
  return request('/track', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'openpanel-client-id': clientId,
      'user-agent': UA,
      'x-client-ip': IP,
      origin: ORIGIN,
      'sec-ch-ua': '"Chromium";v="140"',
      'sec-fetch-mode': 'cors',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function records(): IngestRecord[] {
  return sent.flatMap((envelope) => envelope.records);
}

function inDb<T>(fn: () => Promise<T>) {
  return runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, fn);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await inDb(async () => {
    await db.organization.create({ data: { id: ORG_ID, name: 'Ingest' } });
    await db.project.create({
      data: {
        id: PROJECT_ID,
        name: 'Ingest',
        organizationId: ORG_ID,
        cors: [ORIGIN],
      },
    });
    await db.project.create({
      data: {
        id: FILTERED_PROJECT_ID,
        name: 'Filtered',
        organizationId: ORG_ID,
        cors: [ORIGIN],
        filters: [
          { type: 'event', id: 'f1', name: 'internal_ping', segment: 'event', filters: [] },
        ],
      },
    });
    await db.client.createMany({
      data: [
        { id: CLIENT_ID, name: 'web', organizationId: ORG_ID, projectId: PROJECT_ID },
        {
          id: FILTERED_CLIENT_ID,
          name: 'web',
          organizationId: ORG_ID,
          projectId: FILTERED_PROJECT_ID,
        },
      ],
    });
  });
});

afterAll(async () => {
  await testDb?.drop();
});

beforeEach(() => {
  sent = [];
});

describe('POST /track', () => {
  it('rejects requests without a client id', async () => {
    const res = await trackRequest({ type: 'track', payload: { name: 'x' } }, {}, '');
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Missing client id');
  });

  it('rejects an origin outside the project’s CORS list', async () => {
    const res = await trackRequest(
      { type: 'track', payload: { name: 'x' } },
      { origin: 'https://evil.example.com' },
    );
    expect(res.status).toBe(401);
  });

  it('validates the payload', async () => {
    const res = await trackRequest({ type: 'track', payload: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 400, error: 'Bad Request' });
  });

  it('rejects prototype-poisoning bodies', async () => {
    const res = await request('/track', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'openpanel-client-id': CLIENT_ID,
        origin: ORIGIN,
      },
      body: '{"type":"track","payload":{"name":"x","properties":{"__proto__":{"admin":true}}}}',
    });
    expect(res.status).toBe(400);
  });

  it('queues a normalized event and answers with the bucket session id', async () => {
    const res = await trackRequest({
      type: 'track',
      payload: {
        name: 'screen_view',
        properties: {
          __path: 'https://shop.example.com/pricing?utm_source=newsletter#plans',
          __referrer: 'https://www.google.com/',
          plan: 'pro',
        },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceId: string; sessionId: string };
    expect(body.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.sessionId).toBeTruthy();

    const [record] = records();
    expect(record?.type).toBe('event');
    if (record?.type !== 'event') {
      return;
    }
    expect(record.detached).toBeUndefined();
    expect(record.event).toMatchObject({
      name: 'screen_view',
      projectId: PROJECT_ID,
      deviceId: body.deviceId,
      sessionId: body.sessionId,
      path: '/pricing',
      origin: 'https://shop.example.com',
      // utm_source wins over the referrer's name (the old worker's rule).
      referrer: 'https://www.google.com',
      referrerName: 'newsletter',
      referrerType: 'search',
      browser: 'Chrome',
    });
    expect(record.event.properties).toMatchObject({
      plan: 'pro',
      __hash: '#plans',
      __query: { utm_source: 'newsletter' },
    });
    expect(record.event.properties.__path).toBeUndefined();
    expect(body.sessionId).toBe(
      getBucketSessionId({
        projectId: PROJECT_ID,
        deviceId: body.deviceId,
        eventMs: Date.parse(record.event.createdAt),
      }),
    );
  });

  it('keeps the id of a live session', async () => {
    const first = (await (
      await trackRequest({ type: 'track', payload: { name: 'warmup' } })
    ).json()) as { deviceId: string };
    await inDb(() =>
      anQuery(sql`
        INSERT INTO analytics.live_sessions (project_id, device_id, session_id, profile_id, ended_at, last_received_at, session)
        VALUES (${PROJECT_ID}, ${first.deviceId}, 'live-session-1', '', now(), now(), '{}'::jsonb)
        ON CONFLICT (project_id, device_id) DO UPDATE SET session_id = EXCLUDED.session_id, ended_at = now()
      `),
    );
    const res = await trackRequest({ type: 'track', payload: { name: 'click' } });
    expect(await res.json()).toMatchObject({
      deviceId: first.deviceId,
      sessionId: 'live-session-1',
    });
  });

  it('drops an identical request inside the dedupe window', async () => {
    const body = { type: 'track', payload: { name: 'dup', properties: { n: Math.random() } } };
    const [a, b] = await Promise.all([trackRequest(body), trackRequest(body)]);
    const texts = [await a.text(), await b.text()];
    expect(texts.filter((text) => text === 'Duplicate event')).toHaveLength(1);
    expect(records().filter((record) => record.type === 'event')).toHaveLength(1);
  });

  it('answers known bots with 202 and records the page view as a bot hit', async () => {
    const res = await trackRequest(
      { type: 'track', payload: { name: 'screen_view', properties: { __path: '/robots' } } },
      { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ bot: { name: expect.any(String) } });
    expect(records()).toEqual([
      expect.objectContaining({
        type: 'bot',
        bot: expect.objectContaining({ projectId: PROJECT_ID, path: '/robots' }),
      }),
    ]);
  });

  it('marks server-side and backdated events as detached', async () => {
    await trackRequest(
      { type: 'track', payload: { name: 'invoice_paid', profileId: 'u1' } },
      { 'user-agent': 'node-fetch/1.0' },
    );
    await trackRequest({
      type: 'track',
      payload: {
        name: 'old_event',
        properties: { __timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      },
    });
    const events = records().filter((record) => record.type === 'event');
    expect(events.map((record) => record.type === 'event' && record.detached)).toEqual([
      'server',
      'past',
    ]);
  });

  it('skips events the project filters exclude', async () => {
    await trackRequest(
      { type: 'track', payload: { name: 'internal_ping' } },
      {},
      FILTERED_CLIENT_ID,
    );
    await trackRequest({ type: 'track', payload: { name: 'kept' } }, {}, FILTERED_CLIENT_ID);
    const names = records().flatMap((record) =>
      record.type === 'event' ? [record.event.name] : [],
    );
    expect(names).toEqual(['kept']);
  });

  it('identifies with a multi-key __identify and queues the profile', async () => {
    await trackRequest({
      type: 'track',
      payload: {
        name: 'signed_in',
        properties: {
          __identify: { profileId: 'user-42', email: 'ada@example.com', firstName: 'Ada' },
        },
      },
    });
    const profile = records().find((record) => record.type === 'profile');
    expect(profile).toMatchObject({
      type: 'profile',
      profile: {
        id: 'user-42',
        projectId: PROJECT_ID,
        email: 'ada@example.com',
        firstName: 'Ada',
        isExternal: true,
        properties: expect.objectContaining({ browser: 'Chrome' }),
      },
    });
    const event = records().find((record) => record.type === 'event');
    expect(event?.type === 'event' && event.event.profileId).toBe('user-42');
  });

  it('answers 404 for an increment of an unknown profile', async () => {
    const res = await trackRequest({
      type: 'increment',
      payload: { profileId: 'nobody', property: 'visits' },
    });
    expect(res.status).toBe(404);
    expect(records()).toEqual([]);
  });

  it('queues increments of an existing profile', async () => {
    await inDb(() =>
      anQuery(sql`
        INSERT INTO analytics.profiles (project_id, id, properties, created_at, last_seen_at)
        VALUES (${PROJECT_ID}, 'counter-user', '{"visits": "4", "name": "x"}'::jsonb, now(), now())
      `),
    );
    const ok = await trackRequest({
      type: 'decrement',
      payload: { profileId: 'counter-user', property: 'visits', value: 2 },
    });
    expect(ok.status).toBe(200);
    expect(records()).toEqual([
      expect.objectContaining({
        type: 'profile_op',
        profileId: 'counter-user',
        property: 'visits',
        delta: -2,
      }),
    ]);
    const notNumber = await trackRequest({
      type: 'increment',
      payload: { profileId: 'counter-user', property: 'name' },
    });
    expect(notNumber.status).toBe(400);
  });

  it('writes replay chunks straight to Postgres under the echoed session id', async () => {
    const res = await trackRequest({
      type: 'replay',
      payload: {
        sessionId: 'replay-session',
        chunk_index: 0,
        events_count: 2,
        is_full_snapshot: true,
        started_at: '2026-09-01T10:00:00.000Z',
        ended_at: '2026-09-01T10:00:05.000Z',
        payload: '[{"type":2}]',
      },
    });
    expect(res.status).toBe(200);
    expect(records()).toEqual([]);
    const rows = await inDb(() =>
      anQuery<{ payload: string; events_count: number }>(sql`
        SELECT payload, events_count FROM analytics.session_replay_chunks
        WHERE project_id = ${PROJECT_ID} AND session_id = 'replay-session'
      `),
    );
    expect(rows).toEqual([{ payload: '[{"type":2}]', events_count: 2 }]);
  });

  it('rejects alias', async () => {
    const res = await trackRequest({
      type: 'alias',
      payload: { profileId: 'a', alias: 'b' },
    });
    expect(res.status).toBe(400);
  });

  it('answers 413 when the envelope would not fit a queue message', async () => {
    const res = await trackRequest({
      type: 'track',
      payload: { name: 'huge', properties: { blob: 'x'.repeat(130 * 1024) } },
    });
    expect(res.status).toBe(413);
  });
});

describe('GET /track/device-id', () => {
  it('returns the device id and no session for a new visitor', async () => {
    const res = await request('/track/device-id', {
      headers: {
        'openpanel-client-id': CLIENT_ID,
        origin: ORIGIN,
        'user-agent': 'device-id-test',
        'x-client-ip': '203.0.113.99',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      deviceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      sessionId: '',
    });
  });
});

describe('legacy endpoints', () => {
  it('POST /event queues the event', async () => {
    const res = await request('/event', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'openpanel-client-id': CLIENT_ID,
        origin: ORIGIN,
        'user-agent': UA,
        'x-client-ip': '203.0.113.50',
      },
      body: JSON.stringify({ name: 'legacy_event', properties: { a: 1 } }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('ok');
    expect(records()).toEqual([
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({ name: 'legacy_event', projectId: PROJECT_ID }),
      }),
    ]);
  });

  it('POST /profile queues the profile', async () => {
    const res = await request('/profile', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'openpanel-client-id': CLIENT_ID,
        origin: ORIGIN,
        'user-agent': UA,
      },
      body: JSON.stringify({ profileId: 'legacy-user', firstName: 'Grace' }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('legacy-user');
    expect(records()).toEqual([
      expect.objectContaining({
        type: 'profile',
        profile: expect.objectContaining({ id: 'legacy-user', firstName: 'Grace' }),
      }),
    ]);
  });
});

describe('POST /import/events', () => {
  it('requires a read-write client secret', async () => {
    const res = await request('/import/events', {
      method: 'POST',
      headers: { 'openpanel-client-id': CLIENT_ID, 'openpanel-client-secret': 'nope' },
      body: '[]',
    });
    expect(res.status).toBe(401);
  });

  it('bulk inserts events and their rollups', async () => {
    const { hashPassword } = await import('@openpanel/common/server');
    await inDb(async () =>
      db.client.create({
        data: {
          id: IMPORT_CLIENT_ID,
          name: 'import',
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          type: 'root',
          secret: await hashPassword('import-secret'),
        },
      }),
    );
    const res = await request('/import/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'openpanel-client-id': IMPORT_CLIENT_ID,
        'openpanel-client-secret': 'import-secret',
      },
      body: JSON.stringify([
        {
          name: 'imported_view',
          device_id: 'dev-1',
          profile_id: 'dev-1',
          session_id: 's-1',
          created_at: '2025-01-02 03:04:05',
          properties: { nested: { key: 'v' } },
        },
      ]),
    });
    expect(res.status).toBe(200);
    const rows = await inDb(() =>
      anQuery<{ name: string; properties: Record<string, string>; imported: boolean }>(sql`
        SELECT name, properties, imported_at IS NOT NULL AS imported
        FROM analytics.events WHERE project_id = ${PROJECT_ID} AND name = 'imported_view'
      `),
    );
    expect(rows).toEqual([
      { name: 'imported_view', properties: { 'nested.key': 'v' }, imported: true },
    ]);
    const names = await inDb(() =>
      anQuery<{ event_count: number }>(sql`
        SELECT event_count FROM analytics.event_names
        WHERE project_id = ${PROJECT_ID} AND name = 'imported_view'
      `),
    );
    expect(names).toEqual([{ event_count: 1 }]);
  });
});
