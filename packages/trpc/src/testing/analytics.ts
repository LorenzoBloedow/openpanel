/**
 * Helpers for router tests that read the analytics schema: a fresh migrated
 * database, a project in a time zone, analytics rows, and a signed-in
 * caller with read access to the project.
 */
import { randomUUID } from 'node:crypto';
import { db, getProjectAccess } from '@openpanel/db';
import { anQuery } from '@openpanel/db/src/analytics/client';
import { sql } from '@openpanel/db/src/analytics/sql';
import { createTestDatabase } from '@openpanel/db/src/testing/database';
import { runWithScope } from '@openpanel/runtime';

export const TEST_USER_ID = 'analytics-test-user';

export interface AnalyticsTestDb {
  /** Runs `fn` against the test database. */
  inDb<T>(fn: () => Promise<T>): Promise<T>;
  drop(): Promise<void>;
}

export async function createAnalyticsTestDb(): Promise<AnalyticsTestDb> {
  const database = await createTestDatabase();
  return {
    inDb: (fn) =>
      runWithScope({ env: { DATABASE_URL: database.url }, route: 'direct' }, fn),
    drop: () => database.drop(),
  };
}

/** An organization in `timezone` with one project. */
export async function seedProject(
  projectId: string,
  timezone: string,
): Promise<void> {
  const organizationId = `org-${projectId}`;
  await db.organization.create({
    data: { id: organizationId, name: projectId, timezone },
  });
  await db.project.create({
    data: {
      id: projectId,
      name: projectId,
      organizationId,
      domain: `https://${projectId}.example.com`,
    },
  });
}

export interface TestEvent {
  createdAt: string;
  name?: string;
  sessionId?: string;
  profileId?: string;
  path?: string;
  origin?: string;
  referrerName?: string;
  country?: string;
  city?: string;
  longitude?: number | null;
  latitude?: number | null;
  duration?: number;
  properties?: Record<string, string>;
  groups?: string[];
}

export async function insertEvents(
  projectId: string,
  events: TestEvent[],
): Promise<void> {
  for (const event of events) {
    const profileId = event.profileId ?? 'anonymous';
    await anQuery(sql`
      INSERT INTO analytics.events (
        id, project_id, name, device_id, profile_id, session_id, groups, path,
        origin, referrer_name, country, city, longitude, latitude, duration,
        properties, created_at
      ) VALUES (
        ${randomUUID()}, ${projectId}, ${event.name ?? 'screen_view'},
        ${profileId}, ${profileId}, ${event.sessionId ?? 'session'},
        ${event.groups ?? []}::text[], ${event.path ?? '/'},
        ${event.origin ?? 'https://example.com'}, ${event.referrerName ?? ''},
        ${event.country ?? ''}, ${event.city ?? ''}, ${event.longitude ?? null},
        ${event.latitude ?? null}, ${event.duration ?? 0},
        ${JSON.stringify(event.properties ?? {})}::jsonb,
        ${event.createdAt}::timestamptz
      )
    `);
  }
}

export interface TestProfile {
  id: string;
  email?: string;
  properties?: Record<string, string>;
  groups?: string[];
}

export async function insertProfiles(
  projectId: string,
  profiles: TestProfile[],
): Promise<void> {
  for (const profile of profiles) {
    await anQuery(sql`
      INSERT INTO analytics.profiles (project_id, id, is_external, email, properties, groups)
      VALUES (
        ${projectId}, ${profile.id}, true, ${profile.email ?? ''},
        ${JSON.stringify(profile.properties ?? {})}::jsonb,
        ${profile.groups ?? []}::text[]
      )
    `);
  }
}

export async function insertGroups(
  projectId: string,
  groups: { id: string; name: string; type?: string }[],
): Promise<void> {
  for (const group of groups) {
    await anQuery(sql`
      INSERT INTO analytics.groups (project_id, id, type, name, version)
      VALUES (${projectId}, ${group.id}, ${group.type ?? 'company'}, ${group.name}, 1)
    `);
  }
}

/** Read access for TEST_USER_ID, through the access check's memo. */
export async function grantRead(projectId: string): Promise<void> {
  await getProjectAccess.set({ userId: TEST_USER_ID, projectId })({
    level: 'read',
  });
}

/** The tRPC context of a signed-in dashboard request (pass to createCaller). */
export function signedInContext(): never {
  return {
    session: { userId: TEST_USER_ID, session: { id: 'analytics-test-session' } },
    req: { log: { info: () => undefined, error: () => undefined } },
    res: {},
    cookies: {},
    setCookie: () => undefined,
  } as never;
}

/** The tRPC context of an anonymous request (public widgets). */
export function anonymousContext(): never {
  return {
    session: { userId: null },
    req: { log: { info: () => undefined, error: () => undefined } },
    res: {},
    cookies: {},
    setCookie: () => undefined,
  } as never;
}
