/**
 * findProfilesCore, the query behind the find_profiles tool, against the
 * shared fixture (see test/fixtures.ts):
 *
 *   Alice   — Smith, US, Chrome, created 60 days ago, 1 session, events 2 days ago
 *   Bob     — O'Brien, SE, Chrome, created 90 days ago, no events
 *   Charlie — Brown, US, Firefox, created 30 days ago, 2 sessions, events 5 days ago (incl. purchase)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FIXTURE,
  type FixtureDatabase,
  TEST_PROJECT_ID,
  createFixtureDatabase,
} from '../../../../../test/fixtures';
import { upsertProfiles } from '../../../../db/src/analytics/writers';
import {
  type FindProfilesInput,
  findProfilesCore,
} from '../../../../db/src/services/profile.service';

/** A second project with more profiles than the tool's maximum page. */
const CROWDED_PROJECT_ID = 'crowded-project';
const CROWDED_PROFILE_COUNT = 120;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

let database: FixtureDatabase;

beforeAll(async () => {
  database = await createFixtureDatabase();
  await database.run(() =>
    upsertProfiles(
      Array.from({ length: CROWDED_PROFILE_COUNT }, (_, index) => ({
        id: `crowded-${index}`,
        project_id: CROWDED_PROJECT_ID,
        is_external: true,
        first_name: '',
        last_name: '',
        email: '',
        avatar: '',
        properties: {},
        created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      })),
    ),
  );
});

afterAll(async () => {
  await database?.drop();
});

async function find(input: Partial<FindProfilesInput>) {
  return database.run(() =>
    findProfilesCore({ projectId: TEST_PROJECT_ID, ...input }),
  );
}

async function findIds(input: Partial<FindProfilesInput>) {
  return (await find(input)).map((profile) => profile.id);
}

const { alice, bob, charlie } = FIXTURE.profiles;

describe('findProfilesCore', () => {
  it('returns the project profiles, newest first by default', async () => {
    expect(await findIds({})).toEqual([charlie, alice, bob]);
  });

  it('sorts oldest first with sortOrder asc', async () => {
    expect(await findIds({ sortOrder: 'asc' })).toEqual([bob, alice, charlie]);
  });

  it('never returns another project’s profiles', async () => {
    expect(await findIds({ projectId: 'some-other-project' })).toEqual([]);
  });

  it('matches part of the email, ignoring case', async () => {
    expect(await findIds({ email: 'alice@' })).toEqual([alice]);
    expect(await findIds({ email: 'ALICE@EXAMPLE' })).toEqual([alice]);
  });

  it('matches first and last names', async () => {
    expect(await findIds({ name: 'Charlie' })).toEqual([charlie]);
    expect(await findIds({ name: 'smith' })).toEqual([alice]);
  });

  it('requires every token of a multi-word name', async () => {
    expect(await findIds({ name: 'Charlie Brown' })).toEqual([charlie]);
    expect(await findIds({ name: 'Charlie Smith' })).toEqual([]);
  });

  it('matches names with quotes as plain text', async () => {
    expect(await findIds({ name: "O'Brien" })).toEqual([bob]);
  });

  it('filters on the profile properties', async () => {
    expect(await findIds({ country: 'SE' })).toEqual([bob]);
    expect(await findIds({ browser: 'Firefox' })).toEqual([charlie]);
    expect(await findIds({ device: 'desktop' })).toEqual([charlie, alice, bob]);
    expect(await findIds({ city: 'Stockholm' })).toEqual([]);
  });

  it('applies profile.* filters', async () => {
    expect(
      await findIds({
        filters: [
          {
            id: 'browser',
            name: 'profile.properties.browser',
            operator: 'is',
            value: ['Firefox'],
          },
        ],
      }),
    ).toEqual([charlie]);
  });

  it('keeps only profiles without events in the last N days', async () => {
    // Alice was active 2 days ago, Charlie 5 days ago, Bob never.
    expect(await findIds({ inactiveDays: 7 })).toEqual([bob]);
    expect(await findIds({ inactiveDays: 3 })).toEqual([charlie, bob]);
    // Fractional days are floored, as before.
    expect(await findIds({ inactiveDays: 3.9 })).toEqual([charlie, bob]);
  });

  it('keeps only profiles with at least N sessions', async () => {
    expect(await findIds({ minSessions: 2 })).toEqual([charlie]);
    expect(await findIds({ minSessions: 1 })).toEqual([charlie, alice]);
  });

  it('keeps only profiles that performed an event', async () => {
    expect(await findIds({ performedEvent: 'purchase' })).toEqual([charlie]);
    expect(await findIds({ performedEvent: 'page_view' })).toEqual([
      charlie,
      alice,
    ]);
  });

  it('returns whole profile rows', async () => {
    const [profile] = await find({ email: 'charlie@' });
    expect(profile).toMatchObject({
      id: charlie,
      project_id: TEST_PROJECT_ID,
      first_name: 'Charlie',
      last_name: 'Brown',
      email: 'charlie@example.com',
      properties: { browser: 'Firefox', country: 'US', device: 'desktop' },
    });
  });

  it('pages 20 profiles by default and at most 100', async () => {
    const crowded = { projectId: CROWDED_PROJECT_ID };
    expect(await find(crowded)).toHaveLength(DEFAULT_LIMIT);
    expect(await find({ ...crowded, limit: 5 })).toHaveLength(5);
    expect(await find({ ...crowded, limit: 9999 })).toHaveLength(MAX_LIMIT);
  });

  it('treats hostile input as data', async () => {
    expect(
      await findIds({ projectId: "proj'; DROP TABLE analytics.profiles;--" }),
    ).toEqual([]);
    expect(await findIds({ email: "x' OR '1'='1" })).toEqual([]);
    expect(await findIds({ email: 'test\\@x.com' })).toEqual([]);
    expect(await findIds({ performedEvent: "purchase' OR 1=1 --" })).toEqual(
      [],
    );
    // The table is still there.
    expect(await findIds({})).toEqual([charlie, alice, bob]);
  });
});
