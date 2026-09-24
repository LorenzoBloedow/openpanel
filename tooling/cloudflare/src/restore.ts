/**
 * pnpm cf:restore — load a backup the Backup workflow wrote to R2 into a
 * Postgres database (a fresh Neon project or branch, or a local one).
 *
 * Runs the migrations first (Prisma's and the analytics schema's), checks
 * the backup's migrations are all present, refuses a database that already
 * has data unless --force, then restores every table in one transaction.
 */
import { spawnSync } from 'node:child_process';
import { migrateAnalytics } from '@openpanel/db/src/analytics/migrate';
import { listCompleteBackups, readManifest } from '@openpanel/db/src/backup/backup';
import { restoreBackup } from '@openpanel/db/src/backup/restore';
import arg from 'arg';
import pg from 'pg';

import {
  REPO_ROOT,
  SOURCE_ARGS,
  SOURCE_HELP,
  UsageError,
  databaseUrl,
  main,
  openBucket,
  redact,
} from './cli';

const HELP = `Restore an OpenPanel backup into a Postgres database.

Usage: pnpm cf:restore <source> [options]

Source (one of):
${SOURCE_HELP}

Options:
  --list                list the complete backups and exit
  --date <YYYY-MM-DD>   the backup to restore (default: the newest complete one)
  --database-url <url>  the target (default DATABASE_URL_DIRECT, then DATABASE_URL);
                        for Neon, the direct (unpooled) connection string
  --skip-migrate        don't run the migrations before restoring
  --force               restore into a database that already has data
                        (existing rows win over the backup's)`;

function runPrismaMigrations(url: string) {
  console.log('Applying Prisma migrations…');
  const result = spawnSync(
    'pnpm',
    ['--filter', '@openpanel/db', 'exec', 'prisma', 'migrate', 'deploy'],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: url, DATABASE_URL_DIRECT: url },
    },
  );
  if (result.status !== 0) {
    throw new Error('prisma migrate deploy failed');
  }
}

async function appliedMigrations(client: pg.Client) {
  const { rows } = await client.query<{ prisma: string[] | null; analytics: string[] | null }>(`
    SELECT
      CASE WHEN to_regclass('public._prisma_migrations') IS NOT NULL THEN (
        SELECT array_agg(migration_name) FROM public._prisma_migrations WHERE finished_at IS NOT NULL
      ) END AS prisma,
      CASE WHEN to_regclass('analytics.schema_migrations') IS NOT NULL THEN (
        SELECT array_agg(version) FROM analytics.schema_migrations
      ) END AS analytics
  `);
  return { prisma: rows[0]?.prisma ?? [], analytics: rows[0]?.analytics ?? [] };
}

async function hasData(client: pg.Client) {
  const { rows } = await client.query<{ present: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM public.organizations)
      OR EXISTS (SELECT 1 FROM analytics.events) AS present
  `);
  return rows[0]?.present ?? false;
}

async function restore() {
  const flags = arg({
    ...SOURCE_ARGS,
    '--list': Boolean,
    '--date': String,
    '--database-url': String,
    '--skip-migrate': Boolean,
    '--force': Boolean,
    '--help': Boolean,
    '-h': '--help',
  });
  if (flags['--help']) {
    console.log(HELP);
    return;
  }

  const source = await openBucket(flags);
  try {
    const dates = await listCompleteBackups(source.bucket);
    if (flags['--list']) {
      console.log(`Complete backups in ${source.label}:`);
      for (const date of dates) {
        const manifest = await readManifest(source.bucket, date);
        const events = manifest?.tables.find((table) => table.table === 'events');
        const rows = manifest?.tables.reduce((sum, table) => sum + table.rows, 0) ?? 0;
        console.log(`  ${date}  ${rows} rows, events ${events?.mode ?? 'none'}`);
      }
      return;
    }

    const date = flags['--date'] ?? dates.at(-1);
    if (!date) {
      throw new UsageError(`No complete backup in ${source.label}`);
    }
    const manifest = await readManifest(source.bucket, date);
    if (!manifest) {
      throw new UsageError(`No complete backup for ${date} in ${source.label}`);
    }

    const url = databaseUrl(flags['--database-url']);
    console.log(`Restoring ${date} from ${source.label} into ${redact(url)}`);
    if (!flags['--skip-migrate']) {
      runPrismaMigrations(url);
    }

    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      if (!flags['--skip-migrate']) {
        const migrated = await migrateAnalytics(client, { log: console.log });
        console.log(`Analytics migrations: ${migrated.applied.length} applied`);
      }

      const applied = await appliedMigrations(client);
      const missing = [
        ...manifest.migrations.prisma.filter((name) => !applied.prisma.includes(name)),
        ...manifest.migrations.analytics.filter((name) => !applied.analytics.includes(name)),
      ];
      if (missing.length > 0) {
        throw new Error(
          `The backup was taken on a newer schema; this database lacks: ${missing.join(', ')}. Restore with the OpenPanel version that made the backup, or a newer one.`,
        );
      }
      if (!flags['--force'] && (await hasData(client))) {
        throw new UsageError(
          'The database already has organizations or events. Restore into an empty database, or pass --force to merge (existing rows are kept).',
        );
      }

      const started = Date.now();
      const result = await restoreBackup({
        bucket: source.bucket,
        date,
        client,
        log: (message) => console.log(`  ${message}`),
      });
      const inserted = result.tables.reduce((sum, table) => sum + table.inserted, 0);
      const skipped = result.tables.reduce((sum, table) => sum + table.skipped, 0);
      const kept = result.tables.filter(
        (table) => table.inserted + table.skipped < table.expected,
      );
      console.log(
        `Restored ${inserted} rows in ${((Date.now() - started) / 1000).toFixed(1)} s` +
          (skipped ? `; ${skipped} rows referenced rows missing from the backup and were skipped` : ''),
      );
      for (const table of kept) {
        console.log(
          `  ${table.name}: ${table.expected - table.inserted - table.skipped} rows already existed`,
        );
      }
    } finally {
      await client.end();
    }
  } finally {
    await source.dispose();
  }
}

await main(restore, HELP);
