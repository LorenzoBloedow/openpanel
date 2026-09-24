import { sql } from '../analytics/sql';
import {
  BACKUP_PREFIX,
  type BackupBucket,
  type BackupManifest,
  type ExportedPart,
  type KeyCursor,
  type TableKey,
  exportTablePage,
  listBackupTables,
  maxEventSeq,
  planEventsExport,
  pruneBackups,
  readMigrationVersions,
  writeManifest,
} from './backup';

/**
 * A backup as a sequence of bounded chunks, so the Backup workflow can run
 * each chunk as a durable step (and `runBackup` can run them in a row).
 */

export interface BackupOptions {
  pageSize: number;
  pagesPerChunk: number;
  /** Full events export at least every N days (else incremental by seq). */
  fullEveryDays: number;
  retentionDays: number;
}

export const DEFAULT_BACKUP_OPTIONS: BackupOptions = {
  pageSize: 5000,
  pagesPerChunk: 20,
  fullEveryDays: 7,
  retentionDays: 30,
};

export interface BackupPlan {
  date: string;
  prefix: string;
  tables: TableKey[];
  events:
    | { mode: 'full' }
    | { mode: 'incremental'; afterSeq: number; basedOn: string };
  /** Events up to this seq belong to this backup (a stable upper bound). */
  maxSeq: number;
  migrations: BackupManifest['migrations'];
}

export async function planBackup(
  bucket: BackupBucket,
  date: string,
  options: Pick<BackupOptions, 'fullEveryDays'>,
): Promise<BackupPlan> {
  const [tables, events, maxSeq, migrations] = await Promise.all([
    listBackupTables(),
    planEventsExport(bucket, date, options.fullEveryDays),
    maxEventSeq(),
    readMigrationVersions(),
  ]);
  return { date, prefix: `${BACKUP_PREFIX}${date}/`, tables, events, maxSeq, migrations };
}

const isEvents = (table: TableKey) =>
  table.schema === 'analytics' && table.table === 'events';

export interface ChunkPosition {
  cursor: KeyCursor | null;
  index: number;
}

export interface ChunkResult extends ChunkPosition {
  parts: ExportedPart[];
}

/** Export up to `pagesPerChunk` pages of a table from `cursor`. */
export async function exportTableChunk(
  bucket: BackupBucket,
  plan: BackupPlan,
  table: TableKey,
  start: ChunkPosition,
  options: Pick<BackupOptions, 'pageSize' | 'pagesPerChunk'>,
): Promise<ChunkResult> {
  const events = isEvents(table);
  const afterSeq = plan.events.mode === 'incremental' ? plan.events.afterSeq : 0;
  const parts: ExportedPart[] = [];
  let { cursor, index } = start;
  for (let page = 0; page < options.pagesPerChunk; page++) {
    const result = await exportTablePage({
      bucket,
      prefix: plan.prefix,
      table,
      cursor,
      index,
      pageSize: options.pageSize,
      // events: ordered by seq, bounded by the plan's snapshot of max(seq).
      ...(events
        ? {
            orderBy: { name: 'seq', type: 'bigint' },
            where: sql`t.seq > ${afterSeq} AND t.seq <= ${plan.maxSeq}`,
          }
        : {}),
    });
    if (result.part) {
      parts.push(result.part);
      index++;
    }
    cursor = result.cursor;
    if (!cursor) {
      break;
    }
  }
  return { parts, cursor, index };
}

export function buildManifest(
  plan: BackupPlan,
  exported: Map<string, ExportedPart[]>,
): BackupManifest {
  return {
    version: 1,
    date: plan.date,
    createdAt: new Date().toISOString(),
    migrations: plan.migrations,
    tables: plan.tables.map((table) => {
      const parts = exported.get(`${table.schema}.${table.table}`) ?? [];
      const base = {
        schema: table.schema,
        table: table.table,
        rows: parts.reduce((sum, part) => sum + part.rows, 0),
        parts,
      };
      if (!isEvents(table)) {
        return { ...base, mode: 'full' as const };
      }
      return plan.events.mode === 'incremental'
        ? { ...base, mode: 'incremental' as const, maxSeq: plan.maxSeq, basedOn: plan.events.basedOn }
        : { ...base, mode: 'full' as const, maxSeq: plan.maxSeq };
    }),
  };
}

/** The whole backup in one call (Node scripts, tests). */
export async function runBackup(
  bucket: BackupBucket,
  date: string,
  options: BackupOptions = DEFAULT_BACKUP_OPTIONS,
): Promise<BackupManifest> {
  const plan = await planBackup(bucket, date, options);
  const exported = new Map<string, ExportedPart[]>();
  for (const table of plan.tables) {
    const parts: ExportedPart[] = [];
    let position: ChunkPosition = { cursor: null, index: 0 };
    do {
      const chunk = await exportTableChunk(bucket, plan, table, position, options);
      parts.push(...chunk.parts);
      position = { cursor: chunk.cursor, index: chunk.index };
    } while (position.cursor);
    exported.set(`${table.schema}.${table.table}`, parts);
  }
  const manifest = buildManifest(plan, exported);
  await writeManifest(bucket, manifest);
  await pruneBackups(bucket, date, options.retentionDays);
  return manifest;
}
