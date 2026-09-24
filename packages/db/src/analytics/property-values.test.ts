import { randomUUID } from 'node:crypto';
import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type TestDatabase, createTestDatabase } from '../testing/database';
import { anQuery } from './client';
import {
  type RecentPropertyValuesInput,
  recentPropertyValues,
} from './property-values';
import { sql } from './sql';

const PROJECT = 'property-values';

let testDb: TestDatabase;

const inDb = <T>(fn: () => Promise<T>) =>
  runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, fn);

async function insertEvent(
  name: string,
  createdAt: string,
  properties: Record<string, string>,
) {
  await anQuery(sql`
    INSERT INTO analytics.events (id, project_id, name, properties, created_at)
    VALUES (${randomUUID()}, ${PROJECT}, ${name}, ${JSON.stringify(properties)}::jsonb, ${createdAt}::timestamptz)
  `);
}

const values = (input: Partial<RecentPropertyValuesInput>) =>
  inDb(() =>
    recentPropertyValues({
      projectId: PROJECT,
      key: 'plan',
      since: new Date('2026-01-01T00:00:00Z'),
      scanLimit: 1000,
      limit: 100,
      ...input,
    }),
  );

beforeAll(async () => {
  testDb = await createTestDatabase();
  await inDb(async () => {
    await insertEvent('signup', '2025-12-31T23:59:59Z', { plan: 'legacy' });
    await insertEvent('signup', '2026-01-02T10:00:00Z', { plan: 'free' });
    await insertEvent('signup', '2026-01-03T10:00:00Z', { plan: 'pro' });
    await insertEvent('upgrade', '2026-01-04T10:00:00Z', { plan: 'team' });
    await insertEvent('upgrade', '2026-01-04T10:00:00Z', { plan: 'enterprise' });
    await insertEvent('signup', '2026-01-05T10:00:00Z', { plan: 'free' });
    await insertEvent('signup', '2026-01-06T10:00:00Z', { plan: '' });
    await insertEvent('signup', '2026-01-06T10:00:00Z', {
      other: 'x',
      __duration_from: 'abc',
    });
  });
});

afterAll(async () => {
  await testDb?.drop();
});

describe('recentPropertyValues', () => {
  it('lists distinct values, most recently seen first, the value breaking ties', async () => {
    expect(await values({})).toEqual(['free', 'enterprise', 'team', 'pro']);
  });

  it('reads one event name when given', async () => {
    expect(await values({ eventName: 'signup' })).toEqual(['free', 'pro']);
  });

  it('reads only events since the given instant', async () => {
    expect(
      await values({ since: new Date('2025-12-01T00:00:00Z'), eventName: 'signup' }),
    ).toEqual(['free', 'pro', 'legacy']);
  });

  it('reads only the newest events that carry the key', async () => {
    // The three newest non-empty values: free (05), then the two at 04.
    expect(await values({ scanLimit: 3 })).toEqual(['free', 'enterprise', 'team']);
  });

  it('caps the values', async () => {
    expect(await values({ limit: 2 })).toEqual(['free', 'enterprise']);
  });

  it('has no values for keys hidden from discovery', async () => {
    expect(await values({ key: '__duration_from' })).toEqual([]);
    expect(await values({ key: '' })).toEqual([]);
  });
});
