/**
 * Porting aid (removed with ClickHouse): builds the ClickHouse schema on a
 * local server by running the ClickHouse code-migrations in order, so the
 * golden capture can record what the ClickHouse services return.
 *
 *   CLICKHOUSE_URL=http://127.0.0.1:8123/openpanel SELF_HOSTED=true \
 *     npx jiti test/golden/setup-clickhouse.ts
 */
const CLICKHOUSE_MIGRATIONS = [
  '3-init-ch',
  '4-add-sessions',
  '5-add-imports-table',
  '6-add-revenue-column',
  '8-order-keys',
  '10-add-session-replay',
  '11-add-groups',
  '12-add-gsc',
  '13-cohorts',
  '14-profile-event-property-summary-mv',
  '15-backfill-cohort-mvs',
  '16-restructure-profiles',
  '18-events-profile-id-index',
  '19-event-property-values-projections',
  '20-cohort-summary-mv-sort-key',
  '21-backfill-cohort-summary-mvs',
  '22-add-events-inserted-at',
  '23-drop-old-cohort-summary-mvs',
];

async function main() {
  for (const name of CLICKHOUSE_MIGRATIONS) {
    console.log(`→ ${name}`);
    const migration = await import(`../../code-migrations/${name}.ts`);
    await migration.up();
  }
  console.log('ClickHouse schema ready');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
