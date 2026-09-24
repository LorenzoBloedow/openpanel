/**
 * The shared integration fixture: three profiles, eight events and three
 * sessions in the `analytics` schema, plus the organization and project rows
 * around them, seeded into a throwaway test database.
 *
 *   let database: FixtureDatabase;
 *   beforeAll(async () => {
 *     database = await createFixtureDatabase();
 *   });
 *   afterAll(() => database?.drop());
 *
 *   const rows = await database.run(() => findProfilesCore({ projectId: TEST_PROJECT_ID }));
 *
 * Fixture dataset (3 users, 8 events, 3 sessions), relative to seeding time:
 *
 *   Alice   — created 60 days ago, browser: Chrome, country: US
 *             3 events 2 days ago: session_start → page_view(/home) → session_end
 *             1 session  (sess-alice-1, 2d ago, Chrome)
 *
 *   Bob     — created 90 days ago, browser: Chrome, country: SE — NO events (inactive)
 *
 *   Charlie — created 30 days ago, browser: Firefox, country: US
 *             5 events 5 days ago: session_start → screen_view → page_view(/shop) → purchase → session_end
 *             2 sessions (sess-charlie-1 5d ago Firefox, sess-charlie-2 10d ago Firefox bounce)
 */

import { rebuildRollups } from '../packages/db/src/analytics/rollups';
import {
  type EventWriteRow,
  type SessionWriteRow,
  insertEvents,
  upsertProfiles,
  upsertSessions,
} from '../packages/db/src/analytics/writers';
import { db } from '../packages/db/src/prisma-client';
import {
  type TestDatabase,
  createTestDatabase,
} from '../packages/db/src/testing/database';
import { runWithScope } from '../packages/runtime/index';

export const TEST_PROJECT_ID = 'integration-test';
export const TEST_ORG_ID = 'integration-org';

// ---------------------------------------------------------------------------
// Well-known fixture IDs — import these in tests instead of hard-coding strings
// ---------------------------------------------------------------------------

export const FIXTURE = {
  profiles: {
    alice: 'profile-alice',
    bob: 'profile-bob',
    charlie: 'profile-charlie',
  },
  sessions: {
    alice1: 'sess-alice-1',
    charlie1: 'sess-charlie-1',
    charlie2: 'sess-charlie-2',
  },
  events: {
    alice: {
      sessionStart: '00000000-0000-0000-0000-000000000001',
      pageView: '00000000-0000-0000-0000-000000000002',
      sessionEnd: '00000000-0000-0000-0000-000000000003',
    },
    charlie: {
      sessionStart: '00000000-0000-0000-0000-000000000004',
      screenView: '00000000-0000-0000-0000-000000000005',
      pageView: '00000000-0000-0000-0000-000000000006',
      purchase: '00000000-0000-0000-0000-000000000007',
      sessionEnd: '00000000-0000-0000-0000-000000000008',
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1000;

/** UTC ISO timestamp, whole seconds (the ClickHouse fixture's precision). */
function timeAgo(now: Date, days: number, minutesOffset = 0): string {
  const at = now.getTime() - days * DAY_MS - minutesOffset * MINUTE_MS;
  return new Date(Math.floor(at / SECOND_MS) * SECOND_MS).toISOString();
}

function buildEvent(
  now: Date,
  projectId: string,
  id: string,
  name: string,
  profileId: string,
  sessionId: string,
  daysBack: number,
  minutesOffset = 0,
  overrides: Partial<EventWriteRow> = {},
): EventWriteRow {
  return {
    id,
    project_id: projectId,
    profile_id: profileId,
    name,
    session_id: sessionId,
    device_id: `dev-${profileId.replace('profile-', '')}`,
    created_at: timeAgo(now, daysBack, minutesOffset),
    path: '/',
    origin: 'https://example.com',
    referrer: '',
    referrer_name: '',
    referrer_type: '',
    revenue: 0,
    duration: 0,
    properties: {},
    groups: [],
    country: 'US',
    city: '',
    region: '',
    sdk_name: 'web',
    sdk_version: '1.0.0',
    os: '',
    os_version: '',
    browser: 'Chrome',
    browser_version: '',
    device: 'desktop',
    brand: '',
    model: '',
    ...overrides,
  };
}

function buildSession(
  now: Date,
  projectId: string,
  id: string,
  profileId: string,
  daysBack: number,
  overrides: Partial<SessionWriteRow> = {},
): SessionWriteRow {
  return {
    id,
    project_id: projectId,
    profile_id: profileId,
    device_id: `dev-${profileId.replace('profile-', '')}`,
    created_at: timeAgo(now, daysBack),
    ended_at: timeAgo(now, daysBack),
    is_bounce: false,
    entry_origin: 'https://example.com',
    entry_path: '/home',
    exit_origin: 'https://example.com',
    exit_path: '/home',
    screen_view_count: 1,
    revenue: 0,
    event_count: 1,
    duration: 120,
    country: 'US',
    region: '',
    city: '',
    longitude: null,
    latitude: null,
    device: 'desktop',
    brand: '',
    model: '',
    browser: 'Chrome',
    browser_version: '',
    os: '',
    os_version: '',
    utm_medium: '',
    utm_source: '',
    utm_campaign: '',
    utm_content: '',
    utm_term: '',
    referrer: '',
    referrer_name: '',
    referrer_type: '',
    version: 1,
    ...overrides,
  };
}

async function insertAnalyticsFixtures(projectId: string, now: Date) {
  await upsertProfiles([
    {
      id: FIXTURE.profiles.alice,
      project_id: projectId,
      first_name: 'Alice',
      last_name: 'Smith',
      email: 'alice@example.com',
      avatar: '',
      is_external: false,
      // browser/country in properties so tests can filter profiles by these fields
      properties: { browser: 'Chrome', country: 'US', device: 'desktop' },
      groups: [],
      created_at: timeAgo(now, 60),
      last_seen_at: timeAgo(now, 1),
    },
    {
      id: FIXTURE.profiles.bob,
      project_id: projectId,
      first_name: 'Bob',
      last_name: "O'Brien",
      email: 'bob@example.com',
      avatar: '',
      is_external: false,
      // Bob is intentionally inactive (no events) — useful for inactiveDays tests
      properties: { browser: 'Chrome', country: 'SE', device: 'desktop' },
      groups: [],
      created_at: timeAgo(now, 90),
      last_seen_at: timeAgo(now, 90),
    },
    {
      id: FIXTURE.profiles.charlie,
      project_id: projectId,
      first_name: 'Charlie',
      last_name: 'Brown',
      email: 'charlie@example.com',
      avatar: '',
      is_external: false,
      properties: { browser: 'Firefox', country: 'US', device: 'desktop' },
      groups: [],
      created_at: timeAgo(now, 30),
      last_seen_at: timeAgo(now, 5),
    },
  ]);

  // Alice: session_start → page_view → session_end (2 days ago, spaced 2 min apart)
  // Charlie: session_start → screen_view → page_view → purchase → session_end (5 days ago, spaced 5 min apart)
  // Events are spaced so funnels that need strictly increasing times work.
  await insertEvents([
    buildEvent(
      now,
      projectId,
      FIXTURE.events.alice.sessionStart,
      'session_start',
      FIXTURE.profiles.alice,
      FIXTURE.sessions.alice1,
      2,
      4,
    ),
    buildEvent(
      now,
      projectId,
      FIXTURE.events.alice.pageView,
      'page_view',
      FIXTURE.profiles.alice,
      FIXTURE.sessions.alice1,
      2,
      2,
      { path: '/home', browser: 'Chrome' },
    ),
    buildEvent(
      now,
      projectId,
      FIXTURE.events.alice.sessionEnd,
      'session_end',
      FIXTURE.profiles.alice,
      FIXTURE.sessions.alice1,
      2,
      0,
      { duration: 120_000 },
    ),

    buildEvent(
      now,
      projectId,
      FIXTURE.events.charlie.sessionStart,
      'session_start',
      FIXTURE.profiles.charlie,
      FIXTURE.sessions.charlie1,
      5,
      20,
      { browser: 'Firefox' },
    ),
    buildEvent(
      now,
      projectId,
      FIXTURE.events.charlie.screenView,
      'screen_view',
      FIXTURE.profiles.charlie,
      FIXTURE.sessions.charlie1,
      5,
      15,
      { path: '/shop', browser: 'Firefox' },
    ),
    buildEvent(
      now,
      projectId,
      FIXTURE.events.charlie.pageView,
      'page_view',
      FIXTURE.profiles.charlie,
      FIXTURE.sessions.charlie1,
      5,
      10,
      { path: '/shop', browser: 'Firefox' },
    ),
    buildEvent(
      now,
      projectId,
      FIXTURE.events.charlie.purchase,
      'purchase',
      FIXTURE.profiles.charlie,
      FIXTURE.sessions.charlie1,
      5,
      5,
      { path: '/checkout', revenue: 9900, browser: 'Firefox' },
    ),
    buildEvent(
      now,
      projectId,
      FIXTURE.events.charlie.sessionEnd,
      'session_end',
      FIXTURE.profiles.charlie,
      FIXTURE.sessions.charlie1,
      5,
      0,
      { duration: 300_000, browser: 'Firefox' },
    ),
  ]);

  await upsertSessions([
    buildSession(now, projectId, FIXTURE.sessions.alice1, FIXTURE.profiles.alice, 2),
    buildSession(
      now,
      projectId,
      FIXTURE.sessions.charlie1,
      FIXTURE.profiles.charlie,
      5,
      {
        browser: 'Firefox',
        entry_path: '/shop',
        exit_path: '/checkout',
        revenue: 9900,
        duration: 300,
        screen_view_count: 2,
        event_count: 5,
      },
    ),
    buildSession(
      now,
      projectId,
      FIXTURE.sessions.charlie2,
      FIXTURE.profiles.charlie,
      10,
      {
        browser: 'Firefox',
        is_bounce: true,
        entry_path: '/shop',
        exit_path: '/shop',
        duration: 15,
      },
    ),
  ]);

  // The ingest consumer maintains these incrementally; direct writes don't.
  await rebuildRollups(projectId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Seed the fixture into the database of the current scope: the organization
 * (UTC) and project rows, then the analytics rows and their rollups.
 */
export async function seedFixtures({
  projectId = TEST_PROJECT_ID,
  orgId = TEST_ORG_ID,
  now = new Date(),
}: { projectId?: string; orgId?: string; now?: Date } = {}): Promise<void> {
  await db.organization.upsert({
    where: { id: orgId },
    create: { id: orgId, name: 'Test Org', timezone: 'UTC' },
    update: { timezone: 'UTC' },
  });
  await db.project.upsert({
    where: { id: projectId },
    create: { id: projectId, name: 'Test Project', organizationId: orgId },
    update: {},
  });
  await insertAnalyticsFixtures(projectId, now);
}

export interface FixtureDatabase extends TestDatabase {
  /** Run `fn` in a scope whose DATABASE_URL is this database. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/** A fresh migrated test database with the fixture seeded into it. */
export async function createFixtureDatabase(
  options: { projectId?: string; orgId?: string; now?: Date } = {},
): Promise<FixtureDatabase> {
  const database = await createTestDatabase();
  // The interactive route, as for the requests under test (in Node both
  // routes share one pool on DATABASE_URL).
  const run = <T>(fn: () => Promise<T>) =>
    runWithScope({ env: { DATABASE_URL: database.url }, route: 'hyperdrive' }, fn);
  try {
    await run(() => seedFixtures(options));
  } catch (error) {
    await database.drop();
    throw error;
  }
  return { ...database, run };
}
