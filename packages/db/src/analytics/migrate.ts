import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Runner for the `analytics` schema migrations (Node only: deploy scripts,
 * tests). Prisma manages `public`; these plain SQL files manage everything
 * that replaced ClickHouse, so Prisma's drift detection never sees them.
 *
 * Each file runs in its own transaction and is recorded in
 * `analytics.schema_migrations`. Run it on a direct (unpooled) connection:
 * it holds a session-level advisory lock while it works.
 */

export const ANALYTICS_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../analytics-migrations',
);

const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 'openpanel:analytics-migrations';

export interface AnalyticsMigration {
  version: string;
  path: string;
  sql: string;
  checksum: string;
}

export function listAnalyticsMigrations(
  dir = ANALYTICS_MIGRATIONS_DIR,
): AnalyticsMigration[] {
  return readdirSync(dir)
    .filter((file) => FILE_PATTERN.test(file))
    .sort()
    .map((file) => {
      const path = join(dir, file);
      const sql = readFileSync(path, 'utf8');
      return {
        version: file.replace(/\.sql$/, ''),
        path,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrateAnalytics(
  client: pg.Client | pg.PoolClient,
  options: { dir?: string; log?: (message: string) => void } = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  const migrations = listAnalyticsMigrations(options.dir);
  const result: MigrateResult = { applied: [], skipped: [] };

  await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
  try {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS analytics;
      CREATE TABLE IF NOT EXISTS analytics.schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM analytics.schema_migrations',
    );
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));

    for (const migration of migrations) {
      const previous = applied.get(migration.version);
      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          throw new Error(
            `Analytics migration ${migration.version} changed after it was applied. Add a new migration instead of editing an applied one.`,
          );
        }
        result.skipped.push(migration.version);
        continue;
      }

      log(`Applying analytics migration ${migration.version}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO analytics.schema_migrations (version, checksum) VALUES ($1, $2)',
          [migration.version, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Analytics migration ${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      result.applied.push(migration.version);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
  }

  return result;
}
