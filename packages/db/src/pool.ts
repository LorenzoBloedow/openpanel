import {
  type DbRoute,
  getEnv,
  getRoute,
  getScopedResource,
  isWorkerd,
} from '@openpanel/runtime';
import pg from 'pg';

/**
 * Postgres connection pools, one per connection route, scoped to the current
 * invocation (see @openpanel/runtime).
 *
 * - `hyperdrive`: interactive paths where a user waits on the data. Goes
 *   through the Hyperdrive binding (origin: Neon's unpooled endpoint).
 * - `direct`: ingestion and background work. A plain TCP connection
 *   (`cloudflare:sockets`, TLS from `sslmode` in the URL) to Neon's pooled
 *   endpoint, read from the `DATABASE_URL` secret.
 *
 * Workers cannot reuse sockets across invocations, so pools live and die
 * with the scope. Together they stay under the six simultaneous connections
 * a Worker invocation may open. Both of Neon's poolers run in transaction
 * mode: session state (SET, advisory locks, LISTEN, PREPARE) does not
 * survive a transaction.
 *
 * In Node (tests, scripts) both routes share one pool on `DATABASE_URL`.
 */

interface HyperdriveBinding {
  connectionString: string;
}

export interface DbEnv {
  HYPERDRIVE?: HyperdriveBinding;
  DATABASE_URL?: string;
}

const HYPERDRIVE_POOL_MAX = 3;
const DIRECT_POOL_MAX = 2;
const NODE_POOL_MAX = 10;

// A socket whose peer went away shouldn't take the invocation down with it;
// the next query surfaces the failure where it can be handled.
function onIdleClientError(error: Error) {
  console.error('Idle Postgres connection failed', error);
}

function requireDatabaseUrl(env: DbEnv): string {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  return env.DATABASE_URL;
}

function poolConfig(route: DbRoute): pg.PoolConfig {
  const env = getEnv<DbEnv>();
  if (!isWorkerd()) {
    return {
      connectionString: requireDatabaseUrl(env),
      max: NODE_POOL_MAX,
    };
  }
  if (route === 'hyperdrive') {
    if (!env.HYPERDRIVE) {
      throw new Error(
        'The HYPERDRIVE binding is not configured on this Worker; interactive queries need it',
      );
    }
    return {
      connectionString: env.HYPERDRIVE.connectionString,
      max: HYPERDRIVE_POOL_MAX,
    };
  }
  return {
    connectionString: requireDatabaseUrl(env),
    max: DIRECT_POOL_MAX,
  };
}

/** The pool for `route` (the scope's default route when omitted). */
export function getPool(route: DbRoute = getRoute()): pg.Pool {
  const key = isWorkerd() ? route : 'node';
  return getScopedResource(
    `pg-pool:${key}`,
    () => {
      const pool = new pg.Pool(poolConfig(route));
      pool.on('error', onIdleClientError);
      return pool;
    },
    (pool) => pool.end(),
  );
}
