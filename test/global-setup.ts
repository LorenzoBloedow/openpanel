import { ensureTemplateDatabase } from '../packages/db/src/testing/database';
import { setupPostgresFixtures, teardownPostgresFixtures } from './fixtures';

export { FIXTURE } from './fixtures';
export const TEST_PROJECT_ID = 'integration-test';
export const TEST_ORG_ID = 'integration-org';

// globalSetup runs in the parent process before vitest workers start,
// so vitest's `env` config is not applied — set defaults explicitly.
function setEnvDefaults() {
  process.env.DATABASE_URL ??=
    process.env.TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/postgres?schema=public';
}

export async function setup() {
  setEnvDefaults();
  // Migrated template that createTestDatabase() clones per test file.
  await ensureTemplateDatabase();
  await setupPostgresFixtures(TEST_PROJECT_ID, TEST_ORG_ID);
}

export async function teardown() {
  setEnvDefaults();
  await teardownPostgresFixtures(TEST_PROJECT_ID, TEST_ORG_ID);
}
