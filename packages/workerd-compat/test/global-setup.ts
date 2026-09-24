import {
  createTestDatabase,
  ensureTemplateDatabase,
} from '@openpanel/db/src/testing/database';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * A throwaway database for the workerd tests. Both connection routes point
 * at it: the Hyperdrive binding (Miniflare's local Hyperdrive) and the
 * DATABASE_URL secret the direct route dials with cloudflare:sockets.
 */
export default async function setup(project: TestProject) {
  await ensureTemplateDatabase();
  const database = await createTestDatabase();
  project.provide('databaseUrl', database.url);
  return async () => {
    await database.drop();
  };
}
