import { generateSalt } from '@openpanel/common/server';

import { cacheable } from '@openpanel/redis';
import { db } from '../prisma-client';

const DAY_MS = 1000 * 60 * 60 * 24;

async function readSalts() {
  const [curr, prev] = await db.salt.findMany({
    orderBy: {
      createdAt: 'desc',
    },
    take: 2,
  });

  if (!curr) {
    return null;
  }

  return {
    current: curr.salt,
    previous: prev?.salt ?? curr.salt,
  };
}

/**
 * Creates the first two salts (yesterday's and today's) on a fresh database.
 *
 * There is no process start to hook this into on Workers, so it runs lazily
 * from getSalts. Many isolates can find the table empty at once: the table
 * lock makes the first transaction create the salts and the others see them.
 * The lock ends with the transaction, which keeps it safe behind the
 * transaction-mode poolers (Hyperdrive, Neon's PgBouncer).
 */
export async function createInitialSalts() {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`LOCK TABLE "salts" IN SHARE ROW EXCLUSIVE MODE`;
    if ((await tx.salt.count()) > 0) {
      return;
    }
    await tx.salt.createMany({
      data: [
        {
          salt: generateSalt(),
          createdAt: new Date(Date.now() - DAY_MS),
        },
        {
          salt: generateSalt(),
        },
      ],
    });
  });
}

export const getSalts = cacheable(
  'op:salt',
  async () => {
    const salts = await readSalts();
    if (salts) {
      return salts;
    }

    await createInitialSalts();
    const created = await readSalts();
    if (!created) {
      throw new Error('No salt found');
    }
    return created;
  },
  60 * 5,
);
