import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Throwaway Postgres databases for tests (Node only).
 *
 * The global setup builds a template database from the migrations once per
 * migration set; every test file that needs a clean database clones it with
 * `CREATE DATABASE … TEMPLATE`, which takes a fraction of a second.
 */

const TEMPLATE_DATABASE = 'openpanel_test_template';
const DEFAULT_URL = 'postgresql://postgres:postgres@localhost:5432/postgres';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Migration directories, applied in order. Phase 3 adds the analytics set. */
const MIGRATION_SETS = [
  {
    dir: join(packageRoot, 'prisma/migrations'),
    files: (dir: string) =>
      readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(dir, entry.name, 'migration.sql'))
        .sort(),
  },
];

function baseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
}

function urlFor(database: string): string {
  const url = new URL(baseUrl());
  url.pathname = `/${database}`;
  url.search = '';
  return url.toString();
}

function migrationFiles(): string[] {
  return MIGRATION_SETS.flatMap((set) => set.files(set.dir));
}

function migrationsHash(files: string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.slice(packageRoot.length));
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: urlFor('postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Create (or reuse) the migrated template database. Safe to call from
 * several processes at once.
 */
export async function ensureTemplateDatabase(): Promise<void> {
  const files = migrationFiles();
  const hash = migrationsHash(files);

  await withAdminClient(async (admin) => {
    // Session lock on the admin connection: local Postgres, no pooler.
    await admin.query('SELECT pg_advisory_lock(hashtext($1))', [
      TEMPLATE_DATABASE,
    ]);
    try {
      const existing = await admin.query<{ comment: string | null }>(
        `SELECT shobj_description(oid, 'pg_database') AS comment
         FROM pg_database WHERE datname = $1`,
        [TEMPLATE_DATABASE],
      );
      if (existing.rows[0]?.comment === hash) {
        return;
      }

      await admin.query(
        `DROP DATABASE IF EXISTS ${quoteIdent(TEMPLATE_DATABASE)} WITH (FORCE)`,
      );
      await admin.query(`CREATE DATABASE ${quoteIdent(TEMPLATE_DATABASE)}`);

      const template = new pg.Client({
        connectionString: urlFor(TEMPLATE_DATABASE),
      });
      await template.connect();
      try {
        for (const file of files) {
          try {
            // One simple-protocol script per file, as `prisma migrate` does.
            await template.query(readFileSync(file, 'utf8'));
          } catch (error) {
            throw new Error(
              `Applying ${file.slice(packageRoot.length)} failed: ${String(error)}`,
            );
          }
        }
      } finally {
        await template.end();
      }

      await admin.query(
        `COMMENT ON DATABASE ${quoteIdent(TEMPLATE_DATABASE)} IS '${hash}'`,
      );
    } finally {
      await admin.query('SELECT pg_advisory_unlock(hashtext($1))', [
        TEMPLATE_DATABASE,
      ]);
    }
  });
}

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

/** A fresh, fully migrated database cloned from the template. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `op_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  await withAdminClient(async (admin) => {
    await admin.query(
      `CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(TEMPLATE_DATABASE)}`,
    );
  });
  return {
    name,
    url: urlFor(name),
    drop: () =>
      withAdminClient(async (admin) => {
        await admin.query(
          `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`,
        );
      }),
  };
}
