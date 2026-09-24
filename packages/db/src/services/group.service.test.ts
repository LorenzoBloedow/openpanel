/**
 * Group writes on Postgres: one row per (project, id), replaced by newer
 * versions, and deleted groups are deleted rows. (The reads are compared
 * with ClickHouse in test/golden/groups.golden.test.ts.)
 */
import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type TestDatabase, createTestDatabase } from '../testing/database';
import {
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupList,
  getGroupListCount,
  getGroupPropertyKeys,
  updateGroup,
  upsertGroup,
} from './group.service';

let testDb: TestDatabase;
const PROJECT = 'group-writes';

const inDb = <T>(fn: () => Promise<T>) =>
  runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, fn);

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  vi.useRealTimers();
  await testDb?.drop();
});

describe('group writes', () => {
  it('creates, merges properties on update, and deletes', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-01-01T10:00:00Z') });
    const created = await inDb(() =>
      createGroup({
        id: 'acme',
        projectId: PROJECT,
        type: 'company',
        name: 'Acme',
        properties: { plan: 'pro', billing: { country: 'SE' } },
      }),
    );
    expect(created).toMatchObject({
      id: 'acme',
      name: 'Acme',
      properties: { plan: 'pro', 'billing.country': 'SE' },
      updatedAt: new Date('2026-01-01T10:00:00Z'),
    });

    vi.setSystemTime(new Date('2026-01-02T10:00:00Z'));
    const updated = await inDb(() =>
      updateGroup('acme', PROJECT, { name: 'Acme Inc', properties: { seats: 5 } }),
    );
    expect(updated.name).toBe('Acme Inc');
    const stored = await inDb(() => getGroupById('acme', PROJECT));
    expect(stored).toMatchObject({
      name: 'Acme Inc',
      type: 'company',
      properties: { plan: 'pro', 'billing.country': 'SE', seats: '5' },
      // created_at is kept, the version moves on.
      createdAt: created!.createdAt,
      updatedAt: new Date('2026-01-02T10:00:00Z'),
    });

    // An upsert merges into the stored properties too.
    await inDb(() =>
      upsertGroup({ id: 'acme', projectId: PROJECT, type: 'company', name: 'Acme Inc', properties: { plan: 'enterprise' } }),
    );
    expect((await inDb(() => getGroupById('acme', PROJECT)))?.properties).toEqual({
      plan: 'enterprise',
      'billing.country': 'SE',
      seats: '5',
    });
    expect(await inDb(() => getGroupPropertyKeys(PROJECT))).toEqual(['billing.country', 'plan', 'seats']);

    const deleted = await inDb(() => deleteGroup('acme', PROJECT));
    expect(deleted.id).toBe('acme');
    expect(await inDb(() => getGroupById('acme', PROJECT))).toBeNull();
    expect(await inDb(() => getGroupListCount({ projectId: PROJECT }))).toBe(0);
    expect(await inDb(() => getGroupList({ projectId: PROJECT, take: 10 }))).toEqual([]);
    await expect(inDb(() => deleteGroup('acme', PROJECT))).rejects.toThrow(/not found/);
    await expect(inDb(() => updateGroup('acme', PROJECT, { name: 'x' }))).rejects.toThrow(/not found/);
  });
});
