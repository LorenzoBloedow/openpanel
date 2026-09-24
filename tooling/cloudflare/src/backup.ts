/**
 * pnpm cf:backup — take a backup from Node, in the format the Backup
 * workflow writes (e.g. before an upgrade, or to copy a database out).
 * Nothing is pruned unless --prune-days is given.
 */
import { DEFAULT_BACKUP_OPTIONS, runBackup } from '@openpanel/db/src/backup/run';
import { runWithScope } from '@openpanel/runtime';
import arg from 'arg';

import {
  SOURCE_ARGS,
  SOURCE_HELP,
  UsageError,
  databaseUrl,
  main,
  openBucket,
  redact,
} from './cli';

const HELP = `Back up an OpenPanel database (the Backup workflow's format).

Usage: pnpm cf:backup <destination> [options]

Destination (one of):
${SOURCE_HELP}

Options:
  --date <YYYY-MM-DD>   the backup's name (default: today, UTC)
  --database-url <url>  the source (default DATABASE_URL_DIRECT, then DATABASE_URL)
  --full                export all events even if an earlier full backup exists
  --prune-days <n>      afterwards, delete backups older than n days`;

// Pruning is opt-in here: a century keeps everything.
const KEEP_ALL_DAYS = 36_500;

async function backup() {
  const flags = arg({
    ...SOURCE_ARGS,
    '--date': String,
    '--database-url': String,
    '--full': Boolean,
    '--prune-days': Number,
    '--help': Boolean,
    '-h': '--help',
  });
  if (flags['--help']) {
    console.log(HELP);
    return;
  }
  const date = flags['--date'] ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new UsageError(`Not a date: ${date}`);
  }
  const url = databaseUrl(flags['--database-url']);
  const destination = await openBucket(flags);
  try {
    console.log(`Backing up ${redact(url)} to ${destination.label} as ${date}`);
    const started = Date.now();
    const manifest = await runWithScope({ env: { DATABASE_URL: url }, route: 'direct' }, () =>
      runBackup(destination.bucket, date, {
        ...DEFAULT_BACKUP_OPTIONS,
        fullEveryDays: flags['--full'] ? 0 : DEFAULT_BACKUP_OPTIONS.fullEveryDays,
        retentionDays: flags['--prune-days'] ?? KEEP_ALL_DAYS,
      }),
    );
    for (const table of manifest.tables) {
      if (table.rows > 0) {
        console.log(`  ${table.schema}.${table.table}: ${table.rows} rows (${table.mode})`);
      }
    }
    const rows = manifest.tables.reduce((sum, table) => sum + table.rows, 0);
    console.log(`Backed up ${rows} rows in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } finally {
    await destination.dispose();
  }
}

await main(backup, HELP);
