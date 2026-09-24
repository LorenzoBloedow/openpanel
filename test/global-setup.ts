import { ensureTemplateDatabase } from '../packages/db/src/testing/database';

export { FIXTURE, TEST_ORG_ID, TEST_PROJECT_ID } from './fixtures';

/**
 * Builds the migrated template database that createTestDatabase() clones for
 * every test file that needs one (the server comes from TEST_DATABASE_URL,
 * local Postgres by default). Nothing is written to DATABASE_URL's database:
 * it needn't be migrated, and in CI it isn't.
 */
export async function setup() {
  await ensureTemplateDatabase();
}
