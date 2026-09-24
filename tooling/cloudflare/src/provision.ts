import type { CloudflareApi } from './cloudflare-api';

/**
 * The account-level resources OpenPanel's Workers bind to, created if
 * missing and left alone when they already exist (setup can run again).
 * Queues' consumers, Workflows, Durable Objects and rate limits are created
 * by `wrangler deploy` from the Workers' configs.
 */

export type Log = (message: string) => void;

export const QUEUE_NAMES = ['op-events', 'op-events-dlq', 'op-jobs', 'op-jobs-dlq'] as const;
export const BACKUP_BUCKET = 'openpanel-backups';
export const HYPERDRIVE_NAME = 'openpanel';

const DAY_SECONDS = 24 * 60 * 60;

export interface PostgresOrigin {
  scheme: 'postgresql';
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** Hyperdrive's origin from a connection string (Neon's direct URL). */
export function originFromUrl(connectionString: string): PostgresOrigin {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('The database URL must be a postgres:// or postgresql:// URL');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!(url.hostname && url.username && url.password && database)) {
    throw new Error('The database URL needs a host, user, password and database name');
  }
  return {
    scheme: 'postgresql',
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

interface HyperdriveConfig {
  id: string;
  name: string;
  origin: Omit<PostgresOrigin, 'password'>;
  caching?: { disabled?: boolean };
}

/**
 * The Hyperdrive config in front of Neon's direct (unpooled) endpoint, with
 * query caching off: dashboard reads must be fresh. An existing config of
 * the same name is updated to the given origin.
 */
export async function ensureHyperdrive(
  api: CloudflareApi,
  options: { origin: PostgresOrigin; connectionLimit?: number; dryRun?: boolean },
  log: Log,
): Promise<string> {
  const configs = await api.list<HyperdriveConfig>('/hyperdrive/configs');
  const existing = configs.find((config) => config.name === HYPERDRIVE_NAME);
  const body = {
    name: HYPERDRIVE_NAME,
    origin: options.origin,
    caching: { disabled: true },
    ...(options.connectionLimit ? { origin_connection_limit: options.connectionLimit } : {}),
  };
  if (existing) {
    log(`Hyperdrive "${HYPERDRIVE_NAME}" exists (${existing.id}); updating its origin`);
    if (!options.dryRun) {
      await api.request('PATCH', `/hyperdrive/configs/${existing.id}`, body);
    }
    return existing.id;
  }
  log(`Creating Hyperdrive "${HYPERDRIVE_NAME}" → ${options.origin.host}`);
  if (options.dryRun) {
    return '<new hyperdrive id>';
  }
  const { result } = await api.request<HyperdriveConfig>('POST', '/hyperdrive/configs', body);
  return result.id;
}

export async function ensureQueues(
  api: CloudflareApi,
  options: { dryRun?: boolean },
  log: Log,
): Promise<void> {
  const queues = await api.list<{ queue_name: string }>('/queues');
  const existing = new Set(queues.map((queue) => queue.queue_name));
  for (const name of QUEUE_NAMES) {
    if (existing.has(name)) {
      log(`Queue ${name} exists`);
      continue;
    }
    log(`Creating queue ${name}`);
    if (!options.dryRun) {
      await api.request('POST', '/queues', { queue_name: name });
    }
  }
}

/**
 * The backup bucket and its lifecycle rule. The Backup workflow prunes by
 * BACKUP_RETENTION_DAYS itself (keeping the newest full export and its
 * incrementals); the rule is a backstop for backups a failed run left
 * without a manifest, which pruning never sees, so it must outlast the
 * longest chain the workflow keeps.
 */
export async function ensureBackupBucket(
  api: CloudflareApi,
  options: {
    retentionDays: number;
    fullEveryDays: number;
    locationHint?: string;
    dryRun?: boolean;
  },
  log: Log,
): Promise<void> {
  const { result } = await api.request<{ buckets: { name: string }[] }>('GET', '/r2/buckets');
  if (result.buckets.some((bucket) => bucket.name === BACKUP_BUCKET)) {
    log(`R2 bucket ${BACKUP_BUCKET} exists`);
  } else {
    log(`Creating R2 bucket ${BACKUP_BUCKET}`);
    if (!options.dryRun) {
      await api.request('POST', '/r2/buckets', {
        name: BACKUP_BUCKET,
        ...(options.locationHint ? { locationHint: options.locationHint } : {}),
      });
    }
  }
  const expireDays = lifecycleExpiryDays(options.retentionDays, options.fullEveryDays);
  log(`Setting the lifecycle of ${BACKUP_BUCKET}: backups/ expires after ${expireDays} days`);
  if (!options.dryRun) {
    await api.request('PUT', `/r2/buckets/${BACKUP_BUCKET}/lifecycle`, {
      rules: [
        {
          id: 'openpanel-backups-expiry',
          enabled: true,
          conditions: { prefix: 'backups/' },
          deleteObjectsTransition: {
            condition: { type: 'Age', maxAge: expireDays * DAY_SECONDS },
          },
          abortMultipartUploadsTransition: {
            condition: { type: 'Age', maxAge: DAY_SECONDS },
          },
        },
      ],
    });
  }
}

/** Retention plus one full-export interval plus a week of slack. */
export function lifecycleExpiryDays(retentionDays: number, fullEveryDays: number): number {
  return retentionDays + fullEveryDays + 7;
}

/** The account's workers.dev subdomain, for default URLs without custom domains. */
export async function workersSubdomain(api: CloudflareApi): Promise<string | null> {
  try {
    const { result } = await api.request<{ subdomain?: string }>('GET', '/workers/subdomain');
    return result.subdomain ?? null;
  } catch {
    return null;
  }
}

/** Neon's region id (e.g. aws-us-east-2) as a Workers placement region (aws:us-east-2). */
export function placementRegion(neonRegion: string): string {
  const match = /^(aws|gcp|azure)-(.+)$/.exec(neonRegion.trim());
  if (!match) {
    throw new Error(
      `Unrecognized Neon region "${neonRegion}" (expected e.g. aws-us-east-2 or azure-eastus2)`,
    );
  }
  return `${match[1]}:${match[2]}`;
}
