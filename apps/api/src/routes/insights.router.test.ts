/**
 * The /insights/* REST routes over HTTP, authenticated with real read and
 * write clients, against the shared fixture (see test/fixtures.ts):
 *
 *   Alice   — 3 events: session_start, page_view(/home), session_end  — 2 days ago — Chrome / US
 *   Charlie — 5 events: session_start, screen_view, page_view(/shop), purchase, session_end — 5 days ago — Firefox
 *             2 sessions (sess-charlie-1 5d ago, sess-charlie-2 10d ago)
 */
import { hashPassword } from '@openpanel/common/server';
import { ClientType, db } from '@openpanel/db';
import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type App, createApp } from '@/app';
import {
  FIXTURE,
  type FixtureDatabase,
  TEST_ORG_ID,
  TEST_PROJECT_ID,
  createFixtureDatabase,
} from '../../../../test/fixtures';

// ─── Test clients ─────────────────────────────────────────────────────────────

const CLIENT_ID = '00000000-0000-0000-0000-000000000099';
const CLIENT_SECRET = 'test-secret';
const WRITE_CLIENT_ID = '00000000-0000-0000-0000-000000000098';

const AUTH = {
  'openpanel-client-id': CLIENT_ID,
  'openpanel-client-secret': CLIENT_SECRET,
};

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let database: FixtureDatabase;
let app: App;

beforeAll(async () => {
  app = await createApp();
  database = await createFixtureDatabase();
  const secret = await hashPassword(CLIENT_SECRET);
  await database.run(() =>
    db.client.createMany({
      data: [
        {
          id: CLIENT_ID,
          name: 'Read client',
          type: ClientType.read,
          projectId: TEST_PROJECT_ID,
          organizationId: TEST_ORG_ID,
          secret,
        },
        {
          id: WRITE_CLIENT_ID,
          name: 'Write client',
          type: ClientType.write,
          projectId: TEST_PROJECT_ID,
          organizationId: TEST_ORG_ID,
          secret,
        },
      ],
    }),
  );
}, 30_000);

afterAll(async () => {
  await database?.drop();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function env() {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: database.url,
    HYPERDRIVE: { connectionString: database.url },
  } as unknown as Env;
}

async function get(path: string, headers: Record<string, string> = AUTH) {
  const environment = env();
  const res = await runWithScope(
    { env: environment, route: 'hyperdrive' },
    () => app.request(path, { headers }, environment),
  );
  return { status: res.status, body: (await res.json()) as any };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('returns 401 when no client-id header is present', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/events/names`, {});
    expect(res.status).toBe(401);
  });

  it('returns 401 when client-id is not a valid UUID', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/events/names`, {
      'openpanel-client-id': 'not-a-uuid',
      'openpanel-client-secret': CLIENT_SECRET,
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a wrong secret', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/events/names`, {
      'openpanel-client-id': CLIENT_ID,
      'openpanel-client-secret': 'not-the-secret',
    });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Export: Invalid client secret');
  });

  it('returns 401 for a write-only client', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/events/names`, {
      'openpanel-client-id': WRITE_CLIENT_ID,
      'openpanel-client-secret': CLIENT_SECRET,
    });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Export: Client is not allowed to export');
  });

  it('returns 200 with valid credentials', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/events/names`);
    expect(res.status).toBe(200);
  });
});

// ─── Events ───────────────────────────────────────────────────────────────────

describe('GET /insights/:projectId/events/names', () => {
  it('returns the fixture event names', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/events/names`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toContain('session_start');
    expect(res.body).toContain('page_view');
    expect(res.body).toContain('session_end');
  });
});

describe('GET /insights/:projectId/events', () => {
  it('returns events array', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/events`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('respects limit parameter', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/events?limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(2);
  });

  it('filters by eventNames', async () => {
    const res = await get(
      `/insights/${TEST_PROJECT_ID}/events?eventNames=purchase`,
    );
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body.every((e: any) => e.name === 'purchase')).toBe(true);
  });

  it('returns 400 when limit is out of range', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/events?limit=9999`);
    expect(res.status).toBe(400);
  });
});

describe('GET /insights/:projectId/events/properties', () => {
  it('returns columns + properties arrays', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/events/properties`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.columns)).toBe(true);
    expect(res.body.columns).toContain('path');
    expect(Array.isArray(res.body.properties)).toBe(true);
  });
});

describe('GET /insights/:projectId/events/property_values', () => {
  it('returns values for a known property', async () => {
    const res = await get(
      `/insights/${TEST_PROJECT_ID}/events/property_values?eventName=page_view&propertyKey=path`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.values)).toBe(true);
  });

  it('returns 400 when required params are missing', async () => {
    const res = await get(
      `/insights/${TEST_PROJECT_ID}/events/property_values?eventName=page_view`,
    );
    expect(res.status).toBe(400);
  });
});

// ─── Profiles ─────────────────────────────────────────────────────────────────

describe('GET /insights/:projectId/profiles', () => {
  it('returns the fixture profiles', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/profiles`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const emails = res.body.map((p: any) => p.email);
    expect(emails).toContain('alice@example.com');
    expect(emails).toContain('charlie@example.com');
  });

  it('filters by browser via query params', async () => {
    const res = await get(
      `/insights/${TEST_PROJECT_ID}/profiles?browser=Firefox`,
    );
    expect(res.status).toBe(200);
    // Charlie uses Firefox; Alice uses Chrome — only Charlie should appear
    const emails = res.body.map((p: any) => p.email);
    expect(emails).toContain('charlie@example.com');
    expect(emails).not.toContain('alice@example.com');
  });
});

describe('GET /insights/:projectId/profiles/:profileId', () => {
  it('returns 404 for unknown profile', async () => {
    const res = await get(
      `/insights/${TEST_PROJECT_ID}/profiles/does-not-exist`,
    );
    expect(res.status).toBe(404);
  });

  it('returns profile data for known profile', async () => {
    const res = await get(
      `/insights/${TEST_PROJECT_ID}/profiles/${FIXTURE.profiles.alice}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('profile');
    expect(res.body.profile.email).toBe('alice@example.com');
  });
});

describe('GET /insights/:projectId/profiles/:profileId/sessions', () => {
  it('returns sessions for charlie', async () => {
    const res = await get(
      `/insights/${TEST_PROJECT_ID}/profiles/${FIXTURE.profiles.charlie}/sessions`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Sessions ─────────────────────────────────────────────────────────────────

describe('GET /insights/:projectId/sessions', () => {
  it('returns sessions array', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/sessions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('fixture has at least 3 sessions (alice-1, charlie-1, charlie-2)', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/sessions?limit=100`);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Analytics overview ───────────────────────────────────────────────────────

describe('GET /insights/:projectId/overview', () => {
  it('returns analytics overview', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/overview`);
    expect(res.status).toBe(200);
    // Overview returns an object with at least some metrics
    expect(typeof res.body).toBe('object');
  });

  it('accepts interval param', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/overview?interval=day`);
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid interval', async () => {
    const res = await get(
      `/insights/${TEST_PROJECT_ID}/overview?interval=invalid`,
    );
    expect(res.status).toBe(400);
  });
});

// ─── Funnel ───────────────────────────────────────────────────────────────────

describe('GET /insights/:projectId/funnel', () => {
  it('returns funnel data for valid steps', async () => {
    const res = await get(
      `/insights/${TEST_PROJECT_ID}/funnel?steps=session_start&steps=session_end`,
    );
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  it('returns 400 when fewer than 2 steps are provided', async () => {
    const res = await get(
      `/insights/${TEST_PROJECT_ID}/funnel?steps[]=session_start`,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when steps param is missing entirely', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/funnel`);
    expect(res.status).toBe(400);
  });
});

// ─── Pages ────────────────────────────────────────────────────────────────────

describe('GET /insights/:projectId/pages/top', () => {
  it('returns top pages', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/pages/top`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /insights/:projectId/pages/entry_exit', () => {
  it('defaults to entry mode', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/pages/entry_exit`);
    expect(res.status).toBe(200);
  });

  it('accepts mode=exit', async () => {
    const res = await get(
      `/insights/${TEST_PROJECT_ID}/pages/entry_exit?mode=exit`,
    );
    expect(res.status).toBe(200);
  });
});

// ─── Traffic ──────────────────────────────────────────────────────────────────

describe('GET /insights/:projectId/traffic/referrers', () => {
  it('returns referrer breakdown', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/traffic/referrers`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /insights/:projectId/traffic/geo', () => {
  it('returns geo breakdown', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/traffic/geo`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /insights/:projectId/traffic/devices', () => {
  it('returns device breakdown', async () => {
    const res = await get(`/insights/${TEST_PROJECT_ID}/traffic/devices`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
