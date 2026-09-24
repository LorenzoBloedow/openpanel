import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { withDbRoute } from '@openpanel/db/src/db-routing';
import { getPool } from '@openpanel/db/src/pool';
import { db, getPrismaClient } from '@openpanel/db/src/prisma-client';
import { type DbRoute, runWithScope } from '@openpanel/runtime';

const ROUTES: DbRoute[] = ['hyperdrive', 'direct'];

function inScope<T>(route: DbRoute, fn: () => Promise<T>) {
  return runWithScope({ env, route }, fn);
}

describe.each(ROUTES)('Prisma on the %s route', (route) => {
  it('reads and writes', async () => {
    await inScope(route, async () => {
      const id = `org-${route}`;
      await db.organization.upsert({
        where: { id },
        create: { id, name: `Org ${route}`, timezone: 'UTC' },
        update: {},
      });
      const org = await db.organization.findUniqueOrThrow({ where: { id } });
      expect(org.slug).toBe(id);
    });
  });

  it('runs interactive transactions', async () => {
    await inScope(route, async () => {
      const id = `org-tx-${route}`;
      await expect(
        db.$transaction(async (tx) => {
          await tx.organization.create({ data: { id, name: 'tx' } });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await db.organization.findUnique({ where: { id } })).toBeNull();
    });
  });

  it('runs raw queries', async () => {
    await inScope(route, async () => {
      const rows = await db.$queryRaw<{ one: number }[]>`SELECT 1::int AS one`;
      expect(rows).toEqual([{ one: 1 }]);
    });
  });
});

describe('connection routes', () => {
  it('uses separate pools per route and honours db-routing overrides', async () => {
    await inScope('hyperdrive', async () => {
      expect(getPool('hyperdrive')).not.toBe(getPool('direct'));
      const direct = withDbRoute('replayInsert', () => getPrismaClient());
      expect(direct).toBe(getPrismaClient('direct'));
      expect(direct).not.toBe(getPrismaClient());
    });
  });

  it('refuses to open connections outside a scope', () => {
    expect(() => db.organization).toThrow(/No runtime scope/);
  });

  it('points the hyperdrive route at the Hyperdrive binding', async () => {
    await inScope('hyperdrive', async () => {
      const client = await getPool().connect();
      try {
        const { rows } = await client.query('SELECT current_database() AS name');
        expect(rows[0].name).toMatch(/^op_test_/);
      } finally {
        client.release();
      }
    });
  });
});
