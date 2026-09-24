import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackupBucket } from '@openpanel/db/src/backup/backup';

import {
  DirectoryBucket,
  R2S3Bucket,
  openLocalR2,
  r2CredentialsFromEnv,
} from './buckets';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Paths are relative to where the command was typed (pnpm runs scripts in the package). */
export function userPath(path: string) {
  return isAbsolute(path) ? path : resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

export const SOURCE_HELP = `  --dir <path>          a directory laid out like the bucket (backups/<date>/…)
  --r2                  the R2 bucket over its S3 API: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
                        R2_SECRET_ACCESS_KEY, R2_BUCKET (openpanel-backups), R2_JURISDICTION
  --local [worker dir]  the worker's local R2 as wrangler dev keeps it (apps/worker)`;

export const SOURCE_ARGS = {
  '--dir': String,
  '--r2': Boolean,
  '--local': Boolean,
} as const;

/** Open the bucket the flags point at. `--local` takes an optional path as the next positional. */
export async function openBucket(
  flags: { '--dir'?: string; '--r2'?: boolean; '--local'?: boolean; _: string[] },
): Promise<{ bucket: BackupBucket; label: string; dispose: () => Promise<void> }> {
  const chosen = [flags['--dir'], flags['--r2'], flags['--local']].filter(Boolean).length;
  if (chosen !== 1) {
    throw new UsageError('Pick one of --dir, --r2 or --local');
  }
  if (flags['--dir']) {
    const root = userPath(flags['--dir']);
    return { bucket: new DirectoryBucket(root), label: root, dispose: async () => undefined };
  }
  if (flags['--r2']) {
    const credentials = r2CredentialsFromEnv();
    return {
      bucket: new R2S3Bucket(credentials),
      label: `r2://${credentials.bucket}`,
      dispose: async () => undefined,
    };
  }
  const workerDir = flags._[0] ? userPath(flags._[0]) : join(REPO_ROOT, 'apps/worker');
  const local = await openLocalR2(workerDir);
  return { ...local, label: `local R2 of ${workerDir}` };
}

export class UsageError extends Error {}

/**
 * The database to work on: --database-url, else DATABASE_URL_DIRECT, else
 * DATABASE_URL. Neon's pooled endpoint (PgBouncer in transaction mode)
 * drops the session locks the migration runner takes, so it's refused.
 */
export function databaseUrl(flag: string | undefined): string {
  const url = flag ?? process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) {
    throw new UsageError('Set --database-url, DATABASE_URL_DIRECT or DATABASE_URL');
  }
  if (new URL(url).hostname.includes('-pooler.')) {
    throw new UsageError(
      "That's Neon's pooled endpoint; use the direct (unpooled) connection string",
    );
  }
  return url;
}

/** The URL without its password, for logs. */
export function redact(url: string) {
  const parsed = new URL(url);
  if (parsed.password) {
    parsed.password = '***';
  }
  return parsed.toString();
}

export async function main(run: () => Promise<void>, help: string) {
  try {
    await run();
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${help}`);
      process.exit(2);
    }
    console.error(error);
    process.exit(1);
  }
}
