import { createLogger } from '@openpanel/logger';
import pg from 'pg';

import { getPool } from '../pool';
import { type Sql, compile } from './sql';

const logger = createLogger({ name: 'analytics' });

/** Postgres type OIDs we parse differently from pg's defaults. */
const OID = {
  int8: 20,
  numeric: 1700,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
} as const;

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/**
 * `2024-05-01 12:34:56.789` in UTC — the way ClickHouse rendered
 * DateTime64(3). The ported services still turn these into Dates with
 * `convertClickhouseDateToJs`.
 */
export function toClickhouseDateTime(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
}

function parseTimestamptz(value: string): string {
  // Postgres renders timestamptz in the session time zone with an offset
  // ("2024-05-01 14:34:56.789+02"); normalise to UTC so the result does not
  // depend on the connection's TimeZone setting.
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  return toClickhouseDateTime(new Date(iso));
}

const identity = (value: string) => value;

/**
 * Per-query type parsers (never pg's global registry, which Prisma's adapter
 * shares):
 * - int8 / numeric → number, as the ClickHouse client returned Int/Float.
 * - timestamptz → ClickHouse-style UTC string.
 * - timestamp / date → the text as-is (local wall-clock buckets).
 */
export const analyticsTypes: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (format === 'binary') {
      return (value: unknown) => value;
    }
    switch (oid) {
      case OID.int8:
        return (value: string) => Number.parseInt(value, 10);
      case OID.numeric:
        return (value: string) => Number.parseFloat(value);
      case OID.timestamptz:
        return parseTimestamptz;
      case OID.timestamp:
      case OID.date:
        return identity;
      default:
        return pg.types.getTypeParser(oid, 'text');
    }
  }) as pg.CustomTypesConfig['getTypeParser'],
};

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    config: pg.QueryConfig,
  ): Promise<pg.QueryResult<R>>;
}

function toConfig(query: Sql | string, values?: unknown[]): pg.QueryConfig {
  if (typeof query === 'string') {
    return { text: query, values, types: analyticsTypes };
  }
  const compiled = compile(query);
  return { text: compiled.text, values: compiled.values, types: analyticsTypes };
}

const cleanQuery = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Run an analytics query on the current scope's pool (its default route —
 * Hyperdrive in API requests, direct in background work).
 */
export async function anQuery<T extends pg.QueryResultRow = Record<string, any>>(
  query: Sql | string,
  values?: unknown[],
  client: Queryable = getPool(),
): Promise<T[]> {
  const config = toConfig(query, values);
  const start = Date.now();
  try {
    const result = await client.query<T>(config);
    logger.debug(
      { query: cleanQuery(config.text), rows: result.rowCount, elapsed: Date.now() - start },
      'analytics query',
    );
    return result.rows;
  } catch (error) {
    logger.error(
      { err: error, query: cleanQuery(config.text), elapsed: Date.now() - start },
      'analytics query failed',
    );
    throw error;
  }
}

/** Like {@link anQuery} but returns the first row, or undefined. */
export async function anQueryOne<T extends pg.QueryResultRow = Record<string, any>>(
  query: Sql | string,
  values?: unknown[],
  client?: Queryable,
): Promise<T | undefined> {
  const rows = await anQuery<T>(query, values, client);
  return rows[0];
}

/**
 * Run `fn` inside `BEGIN … COMMIT` on one pinned connection. Both of Neon's
 * poolers are transaction-mode, so anything that must see the same session
 * (row locks, SET LOCAL) has to happen inside this callback.
 */
export async function anTransaction<T>(
  fn: (client: Queryable) => Promise<T>,
  pool: pg.Pool = getPool(),
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'analytics rollback failed');
    }
    throw error;
  } finally {
    client.release();
  }
}
