import { anQuery } from '../analytics/client';
import { ident, join, raw, sql } from '../analytics/sql';

/**
 * Logical backups of the whole database (the `public` schema Prisma
 * manages and the `analytics` schema) to object storage (R2 in production).
 *
 * Every table is exported in primary-key order, page by page (keyset
 * pagination), as gzipped JSON Lines: one `row_to_json` object per line, so
 * types survive the round trip (restore uses json_populate_recordset). Each
 * page is its own object, so a backup is resumable at any page and needs no
 * multipart uploads. A manifest written last lists every part with its row
 * count and SHA-256; a backup without a manifest is incomplete.
 *
 * analytics.events is exported incrementally by its `seq` column between
 * full exports; see {@link planEventsExport}.
 *
 * Neon's point-in-time restore is the first line of defense; these backups
 * cover account-level loss and give a portable copy.
 */

/** The object storage calls a backup makes (an R2 bucket binding fits). */
export interface BackupBucket {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> } | null>;
  list(options: { prefix?: string; cursor?: string; delimiter?: string }): Promise<{
    objects: { key: string }[];
    delimitedPrefixes?: string[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

export const BACKUP_PREFIX = 'backups/';
export const MANIFEST_NAME = 'manifest.json';

/** Tables not worth backing up: ephemeral state rebuilt on its own. */
const SKIPPED_TABLES = new Set([
  'analytics.request_dedupe',
  'analytics.ingest_ledger',
  'analytics.live_sessions',
  'public.cron_runs',
  'public.rate_limit_blocks',
  // Migration bookkeeping: restore targets a migrated database; the
  // manifest records the versions instead.
  'public._prisma_migrations',
  'analytics.schema_migrations',
]);

export interface TableKey {
  schema: string;
  table: string;
  /** Primary key columns in index order, with their SQL types. */
  columns: { name: string; type: string }[];
}

/** Every backed-up table and its primary key. */
export async function listBackupTables(): Promise<TableKey[]> {
  const rows = await anQuery<{
    schema: string;
    table: string;
    columns: { name: string; type: string }[] | null;
  }>(sql`
    SELECT n.nspname AS schema, c.relname AS table,
      (
        -- The primary key, or else the first full unique index (a few
        -- Prisma models only have @unique ids).
        SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod))
          ORDER BY array_position(i.indkey::int2[], a.attnum))
        FROM (
          SELECT i.indexrelid, i.indrelid, i.indkey
          FROM pg_index i
          WHERE i.indrelid = c.oid
            AND (i.indisprimary OR (i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL))
          ORDER BY i.indisprimary DESC, i.indexrelid
          LIMIT 1
        ) i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      ) AS columns
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname IN ('public', 'analytics')
      AND NOT c.relispartition
    ORDER BY n.nspname, c.relname
  `);
  return rows
    .filter((row) => !SKIPPED_TABLES.has(`${row.schema}.${row.table}`))
    .map((row) => {
      if (!row.columns || row.columns.length === 0) {
        throw new Error(
          `${row.schema}.${row.table} has no primary key or unique index; it can't be exported page by page`,
        );
      }
      return { schema: row.schema, table: row.table, columns: row.columns };
    });
}

/** A page cursor: the last exported row's key values, as JSON scalars. */
export type KeyCursor = (string | number | boolean | null)[];

export interface ExportedPart {
  key: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface ExportPageResult {
  part: ExportedPart | null;
  /** The last row's key values (resume after it), or null when done. */
  cursor: KeyCursor | null;
}

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Export one page of a table after `cursor` (its primary key values) and
 * store it as `<prefix><schema>.<table>/<index>.jsonl.gz`.
 */
export async function exportTablePage(options: {
  bucket: BackupBucket;
  prefix: string;
  table: TableKey;
  cursor: KeyCursor | null;
  index: number;
  pageSize: number;
  /** Extra condition, e.g. `seq > …` for the incremental events export. */
  where?: ReturnType<typeof sql>;
  /** Order by this column instead of the primary key (with `where`). */
  orderBy?: { name: string; type: string };
}): Promise<ExportPageResult> {
  const { table } = options;
  const target = ident(table.schema, table.table);
  const keyColumns = options.orderBy ? [options.orderBy] : table.columns;
  const keyList = join(keyColumns.map((column) => sql`t.${ident(column.name)}`));
  const conditions = [options.where ?? raw('TRUE')];
  if (options.cursor) {
    const values = join(
      keyColumns.map(
        (column, index) => sql`${options.cursor![index] ?? null}::${raw(column.type)}`,
      ),
    );
    conditions.push(sql`ROW(${keyList}) > ROW(${values})`);
  }
  const keyJson = join(
    keyColumns.map((column) => sql`t.${ident(column.name)}`),
  );

  const rows = await anQuery<{ line: string; key: KeyCursor }>(sql`
    SELECT row_to_json(t)::text AS line, json_build_array(${keyJson}) AS key
    FROM ${target} t
    WHERE ${join(conditions, ' AND ')}
    ORDER BY ${keyList}
    LIMIT ${options.pageSize}
  `);
  if (rows.length === 0) {
    return { part: null, cursor: null };
  }

  const body = await gzip(`${rows.map((row) => row.line).join('\n')}\n`);
  const key = `${options.prefix}${table.schema}.${table.table}/${String(options.index).padStart(6, '0')}.jsonl.gz`;
  const sha256 = await sha256Hex(body);
  await options.bucket.put(key, body, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { rows: String(rows.length), sha256 },
  });
  return {
    part: { key, rows: rows.length, bytes: body.byteLength, sha256 },
    cursor: rows.length < options.pageSize ? null : rows.at(-1)!.key,
  };
}

export interface BackupManifest {
  version: 1;
  date: string;
  createdAt: string;
  /** Migrations applied at backup time (restore needs the same schema). */
  migrations: { prisma: string[]; analytics: string[] };
  tables: {
    schema: string;
    table: string;
    /** 'incremental': rows after the previous backup's watermark only. */
    mode: 'full' | 'incremental';
    rows: number;
    parts: ExportedPart[];
    /** analytics.events: the highest `seq` exported (the next watermark). */
    maxSeq?: number;
    /** The full backup an incremental export continues from. */
    basedOn?: string;
  }[];
}

export async function readMigrationVersions() {
  // A database set up from SQL files (tests, local copies) may lack either
  // bookkeeping table.
  const [present] = await anQuery<{ prisma: boolean; analytics: boolean }>(sql`
    SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS prisma,
      to_regclass('analytics.schema_migrations') IS NOT NULL AS analytics
  `);
  const [prisma, analytics] = await Promise.all([
    present?.prisma
      ? anQuery<{ name: string }>(sql`
          SELECT migration_name AS name FROM public._prisma_migrations
          WHERE finished_at IS NOT NULL ORDER BY migration_name
        `)
      : [],
    present?.analytics
      ? anQuery<{ name: string }>(sql`
          SELECT version AS name FROM analytics.schema_migrations ORDER BY version
        `)
      : [],
  ]);
  return {
    prisma: prisma.map((row) => row.name),
    analytics: analytics.map((row) => row.name),
  };
}

/** Backup dates (YYYY-MM-DD) that have a manifest, oldest first. */
export async function listCompleteBackups(bucket: BackupBucket): Promise<string[]> {
  const dates: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, delimiter: '/', cursor });
    for (const prefix of page.delimitedPrefixes ?? []) {
      dates.push(prefix.slice(BACKUP_PREFIX.length).replace(/\/$/, ''));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const complete: string[] = [];
  for (const date of dates.sort()) {
    if (await bucket.get(`${BACKUP_PREFIX}${date}/${MANIFEST_NAME}`)) {
      complete.push(date);
    }
  }
  return complete;
}

export async function readManifest(
  bucket: BackupBucket,
  date: string,
): Promise<BackupManifest | null> {
  const object = await bucket.get(`${BACKUP_PREFIX}${date}/${MANIFEST_NAME}`);
  return object ? (JSON.parse(await object.text()) as BackupManifest) : null;
}

/**
 * Full or incremental export of analytics.events: incremental (rows with
 * `seq` above the last backup's watermark) unless there is no previous
 * backup or the last full export is older than `fullEveryDays`.
 */
export async function planEventsExport(
  bucket: BackupBucket,
  date: string,
  fullEveryDays: number,
): Promise<{ mode: 'full' } | { mode: 'incremental'; afterSeq: number; basedOn: string }> {
  const dates = (await listCompleteBackups(bucket)).filter((value) => value < date);
  for (const previous of dates.reverse()) {
    const manifest = await readManifest(bucket, previous);
    const events = manifest?.tables.find(
      (table) => table.schema === 'analytics' && table.table === 'events',
    );
    if (!events || events.maxSeq === undefined) {
      continue;
    }
    const base = events.mode === 'full' ? previous : events.basedOn;
    if (!base) {
      break;
    }
    const ageDays = (Date.parse(date) - Date.parse(base)) / 86_400_000;
    if (ageDays >= fullEveryDays) {
      break;
    }
    return { mode: 'incremental', afterSeq: events.maxSeq, basedOn: base };
  }
  return { mode: 'full' };
}

export async function maxEventSeq(): Promise<number> {
  const rows = await anQuery<{ seq: number | null }>(sql`SELECT max(seq) AS seq FROM analytics.events`);
  return rows[0]?.seq ?? 0;
}

export async function writeManifest(
  bucket: BackupBucket,
  manifest: BackupManifest,
): Promise<void> {
  await bucket.put(
    `${BACKUP_PREFIX}${manifest.date}/${MANIFEST_NAME}`,
    JSON.stringify(manifest, null, 2),
    { httpMetadata: { contentType: 'application/json' } },
  );
}

/**
 * Delete backups older than `retentionDays`, never the newest full backup
 * of events nor the incrementals that depend on it.
 */
export async function pruneBackups(
  bucket: BackupBucket,
  today: string,
  retentionDays: number,
): Promise<string[]> {
  const complete = await listCompleteBackups(bucket);
  const cutoff = new Date(Date.parse(today) - retentionDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  let protectedFrom = today;
  for (const date of [...complete].reverse()) {
    const manifest = await readManifest(bucket, date);
    const events = manifest?.tables.find(
      (table) => table.schema === 'analytics' && table.table === 'events',
    );
    if (events) {
      protectedFrom = events.mode === 'full' ? date : (events.basedOn ?? date);
      break;
    }
  }
  const doomed = complete.filter((date) => date < cutoff && date < protectedFrom);
  for (const date of doomed) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: `${BACKUP_PREFIX}${date}/`, cursor });
      if (page.objects.length > 0) {
        await bucket.delete(page.objects.map((object) => object.key));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return doomed;
}
