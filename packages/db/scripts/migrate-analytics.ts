/**
 * pnpm migrate:deploy:analytics — apply the analytics schema migrations.
 *
 * Uses DATABASE_URL_DIRECT (Neon's unpooled endpoint): the runner holds a
 * session-level advisory lock, which transaction-mode poolers drop.
 */
import pg from 'pg';
import { migrateAnalytics } from '../src/analytics/migrate';

async function main() {
  const connectionString =
    process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Set DATABASE_URL_DIRECT (or DATABASE_URL)');
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await migrateAnalytics(client, { log: console.log });
    console.log(
      `Analytics migrations: ${result.applied.length} applied, ${result.skipped.length} already up to date`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
