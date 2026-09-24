import { db } from '@openpanel/db/src/prisma-client';
import { Hono } from 'hono';

import type { AppEnv } from '@/env';

export const healthRoutes = new Hono<AppEnv>();

/** Dependency health: Postgres through Hyperdrive (Redis and ClickHouse are gone). */
healthRoutes.get('/healthcheck', async (c) => {
  let dbOk = false;
  let dbError: string | undefined;
  try {
    await db.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
  }

  const dependencies = { db: dbOk };
  const failedDependencies = dbOk ? [] : ['db'];
  const workingDependencies = dbOk ? ['db'] : [];
  if (!dbOk) {
    c.get('logger').warn(
      { failedDependencies, dependencyErrors: { db: dbError } },
      'healthcheck failed',
    );
  }

  return c.json(
    { ready: dbOk, ...dependencies, failedDependencies, workingDependencies },
    dbOk ? 200 : 503,
  );
});

// Liveness / readiness stay shallow: a Worker has no process to restart.
healthRoutes.get('/healthz/live', (c) => c.json({ live: true }));
healthRoutes.get('/healthz/ready', (c) => c.json({ ready: true }));

healthRoutes.get('/', (c) =>
  c.json({ status: 'ok', message: 'Successfully running OpenPanel.dev API' }),
);
