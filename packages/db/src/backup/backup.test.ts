import { uuidv7 } from '@openpanel/common/server';
import { runWithScope } from '@openpanel/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateDataset } from '../../test/fixtures/analytics-dataset';
import { loadDatasetIntoPostgres } from '../../test/fixtures/load-postgres';
import { anQuery } from '../analytics/client';
import { insertEvents } from '../analytics/writers';
import { db } from '../prisma-client';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import { listBackupTables, listCompleteBackups, readManifest } from './backup';
import { MemoryBucket } from './memory-bucket';
import { restoreBackup } from './restore';
import { runBackup } from './run';

let source: TestDatabase;
let target: TestDatabase;

const inSource = <T>(fn: () => Promise<T>) =>
  runWithScope({ env: { DATABASE_URL: source.url }, route: 'direct' }, fn);

const OPTIONS = { pageSize: 400, pagesPerChunk: 3, fullEveryDays: 7, retentionDays: 30 };

async function fingerprints(url: string) {
  return runWithScope({ env: { DATABASE_URL: url }, route: 'direct' }, async () => {
    const tables = await listBackupTables();
    const result: Record<string, { rows: number; md5: string | null }> = {};
    for (const table of tables) {
      const order = table.columns.map((column) => `"${column.name}"`).join(', ');
      const [row] = await anQuery<{ rows: number; md5: string | null }>(
        `SELECT count(*)::int AS rows,
           md5(string_agg(row_to_json(t)::text, '' ORDER BY ${order})) AS md5
         FROM "${table.schema}"."${table.table}" t`,
      );
      result[`${table.schema}.${table.table}`] = row!;
    }
    return result;
  });
}

beforeAll(async () => {
  source = await createTestDatabase();
  target = await createTestDatabase();
  await inSource(async () => {
    await db.organization.create({ data: { id: 'org-backup', name: 'Backup org' } });
    await db.project.create({
      data: { id: 'proj-backup', name: 'Backup project', organizationId: 'org-backup' },
    });
    await db.user.create({
      data: { id: 'user-backup', email: 'backup@example.com', firstName: 'B' },
    });
    await db.member.create({
      data: {
        organizationId: 'org-backup',
        userId: 'user-backup',
        role: 'org:admin',
        email: 'backup@example.com',
      },
    });
    await loadDatasetIntoPostgres(
      generateDataset({ projectId: 'proj-backup', anchor: new Date('2026-09-20T12:00:00Z') }),
    );
  });
}, 120_000);

afterAll(async () => {
  await source?.drop();
  await target?.drop();
});

describe('backup and restore', () => {
  it('round-trips a full and an incremental backup', async () => {
    const bucket = new MemoryBucket();

    const full = await inSource(() => runBackup(bucket, '2026-09-20', OPTIONS));
    const fullEvents = full.tables.find((table) => table.table === 'events')!;
    expect(fullEvents.mode).toBe('full');
    expect(fullEvents.parts.length).toBeGreaterThan(1);

    // Events arriving after the first backup go into the next, incremental one.
    await inSource(() =>
      insertEvents(
        Array.from({ length: 25 }, (_, i) => ({
          id: uuidv7(),
          name: 'late_event',
          device_id: `late-${i}`,
          profile_id: `late-${i}`,
          project_id: 'proj-backup',
          session_id: '',
          properties: { i },
          created_at: new Date(Date.UTC(2026, 8, 20, 18, i)).toISOString(),
        })),
      ),
    );
    const incremental = await inSource(() => runBackup(bucket, '2026-09-21', OPTIONS));
    const incrementalEvents = incremental.tables.find((table) => table.table === 'events')!;
    expect(incrementalEvents).toMatchObject({
      mode: 'incremental',
      rows: 25,
      basedOn: '2026-09-20',
    });
    expect(await listCompleteBackups(bucket)).toEqual(['2026-09-20', '2026-09-21']);

    const client = new pg.Client({ connectionString: target.url });
    await client.connect();
    try {
      const restored = await restoreBackup({ bucket, date: '2026-09-21', client });
      for (const table of restored.tables) {
        expect(table.skipped, table.name).toBe(0);
        expect(table.inserted, table.name).toBe(table.expected);
      }
    } finally {
      await client.end();
    }

    const [before, after] = await Promise.all([
      fingerprints(source.url),
      fingerprints(target.url),
    ]);
    expect(after).toEqual(before);
  }, 120_000);

  it('restores into a schema with columns added after the backup', async () => {
    const bucket = new MemoryBucket();
    await inSource(() => runBackup(bucket, '2026-09-20', OPTIONS));

    const newer = await createTestDatabase();
    const client = new pg.Client({ connectionString: newer.url });
    await client.connect();
    try {
      await client.query(
        `ALTER TABLE public.organizations ADD COLUMN "restoreCheck" text NOT NULL DEFAULT 'default'`,
      );
      const restored = await restoreBackup({ bucket, date: '2026-09-20', client });
      const organizations = restored.tables.find((table) => table.name === 'public.organizations');
      expect(organizations).toMatchObject({ inserted: 1, expected: 1, skipped: 0 });
      const { rows } = await client.query<{ restoreCheck: string }>(
        'SELECT "restoreCheck" FROM public.organizations',
      );
      expect(rows).toEqual([{ restoreCheck: 'default' }]);
    } finally {
      await client.end();
      await newer.drop();
    }
  }, 120_000);

  it('keeps the newest full backup and its incrementals when pruning', async () => {
    const bucket = new MemoryBucket();
    await inSource(() => runBackup(bucket, '2026-06-01', { ...OPTIONS, retentionDays: 3650 }));
    await inSource(() => runBackup(bucket, '2026-06-02', { ...OPTIONS, retentionDays: 3650 }));
    // 60 days later, with a 30 day retention: both are past the cutoff, but
    // the 06-02 incremental still needs its 06-01 base, the newest full one.
    await inSource(() =>
      runBackup(bucket, '2026-08-01', { ...OPTIONS, fullEveryDays: 365, retentionDays: 30 }),
    );
    expect(await listCompleteBackups(bucket)).toEqual(['2026-06-01', '2026-06-02', '2026-08-01']);
    const latest = await readManifest(bucket, '2026-08-01');
    expect(latest?.tables.find((table) => table.table === 'events')?.basedOn).toBe('2026-06-01');
  }, 120_000);
});
