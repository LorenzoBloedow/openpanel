import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_ROUTES, withDbRoute } from './db-routing';
import { getPool } from './pool';
import { db, getPrismaClient } from './prisma-client';
import { createInitialSalts, getSalts } from './services/salt.service';
import { type TestDatabase, createTestDatabase } from './testing/database';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

/** Every test runs in its own scope, like a Worker invocation would. */
function inScope<T>(fn: () => Promise<T>, route: 'hyperdrive' | 'direct' = 'hyperdrive') {
  return runWithScope({ env: { DATABASE_URL: testDb.url }, route }, fn);
}

describe('db (engine-less Prisma on pg)', () => {
  it('queries through the scoped client', async () => {
    await inScope(async () => {
      await db.organization.create({
        data: { id: 'org-a', name: 'Org A', timezone: 'UTC' },
      });
      const org = await db.organization.findUniqueOrThrow({
        where: { id: 'org-a' },
      });
      // Computed fields from the $extends block still apply.
      expect(org.slug).toBe('org-a');
      expect(org.subscriptionStatus).toBe('active');
    });
  });

  it('runs interactive transactions and rolls them back', async () => {
    await inScope(async () => {
      await expect(
        db.$transaction(async (tx) => {
          await tx.organization.create({
            data: { id: 'org-rollback', name: 'Rollback' },
          });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(
        await db.organization.findUnique({ where: { id: 'org-rollback' } }),
      ).toBeNull();
    });
  });

  it('runs raw queries', async () => {
    await inScope(async () => {
      const rows = await db.$queryRaw<{ one: number }[]>`SELECT 1::int AS one`;
      expect(rows).toEqual([{ one: 1 }]);
    });
  });

  it('creates one client per scope and route', async () => {
    const [a1, a2] = await inScope(async () => [
      getPrismaClient(),
      getPrismaClient(),
    ]);
    const b = await inScope(async () => getPrismaClient());
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);

    await inScope(async () => {
      const hyperdrive = getPrismaClient('hyperdrive');
      const direct = withDbRoute('replayInsert', () => getPrismaClient());
      expect(DB_ROUTES.replayInsert).toBe('direct');
      expect(direct).not.toBe(hyperdrive);
      // Node has a single pool for both routes.
      expect(getPool('hyperdrive')).toBe(getPool('direct'));
    });
  });
});

describe('salts', () => {
  it('bootstraps salts lazily and exactly once under concurrency', async () => {
    await inScope(async () => {
      expect(await db.salt.count()).toBe(0);
      await Promise.all(Array.from({ length: 5 }, () => createInitialSalts()));
      expect(await db.salt.count()).toBe(2);

      const salts = await getSalts();
      const [today, yesterday] = await db.salt.findMany({
        orderBy: { createdAt: 'desc' },
      });
      expect(salts).toEqual({
        current: today!.salt,
        previous: yesterday!.salt,
      });
    }, 'direct');
  });
});
