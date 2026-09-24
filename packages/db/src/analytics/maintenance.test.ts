import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../prisma-client';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import { anQuery } from './client';
import {
  cleanupEventsOlderThan,
  cleanupIngestLedger,
  cleanupReplayChunks,
  cleanupRequestDedupe,
  deleteProjectAnalyticsChunk,
  refreshProjectEventCounts,
} from './maintenance';
import { insertEvents } from './writers';

let database: TestDatabase;

const inDatabase = <T>(fn: () => Promise<T>) =>
  runWithScope({ env: { DATABASE_URL: database.url }, route: 'direct' }, fn);

const NOW = new Date('2026-09-20T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function events(projectId: string, count: number, at = NOW) {
  return Array.from({ length: count }, (_, i) => ({
    id: `0199a5a4-7c00-7000-8000-${String(i).padStart(6, '0')}${projectId === 'proj-a' ? 'aaaaaa' : 'bbbbbb'}`,
    name: 'screen_view',
    device_id: `device-${i}`,
    profile_id: `device-${i}`,
    project_id: projectId,
    session_id: `session-${i}`,
    properties: {},
    created_at: new Date(at.getTime() - i * 1000).toISOString(),
  }));
}

async function count(table: string, projectId?: string) {
  const [row] = await anQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM analytics.${table}${projectId ? ' WHERE project_id = $1' : ''}`,
    projectId ? [projectId] : [],
  );
  return row!.n;
}

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await inDatabase(async () => {
    await anQuery(`
      TRUNCATE analytics.events, analytics.event_names, analytics.request_dedupe,
        analytics.ingest_ledger, analytics.session_replay_chunks
    `);
  });
});

describe('deleteProjectAnalyticsChunk', () => {
  it('deletes one project in bounded chunks and leaves the others', async () => {
    await inDatabase(async () => {
      await insertEvents([...events('proj-a', 25), ...events('proj-b', 5)]);

      const rounds: number[] = [];
      for (;;) {
        const deleted = await deleteProjectAnalyticsChunk('events', ['proj-a'], 10);
        rounds.push(deleted);
        if (deleted < 10) {
          break;
        }
      }
      expect(rounds).toEqual([10, 10, 5]);
      expect(await count('events', 'proj-a')).toBe(0);
      expect(await count('events', 'proj-b')).toBe(5);
    });
  });

  it('rejects tables outside the list', async () => {
    await inDatabase(async () => {
      await expect(
        deleteProjectAnalyticsChunk('schema_migrations' as never, ['proj-a']),
      ).rejects.toThrow('Not a project analytics table');
    });
  });
});

describe('retention sweeps', () => {
  it('drops expired dedupe claims only', async () => {
    await inDatabase(async () => {
      await anQuery(
        `INSERT INTO analytics.request_dedupe (hash, expires_at)
         VALUES ('old', $1), ('fresh', $2)`,
        [new Date(NOW.getTime() - 1000).toISOString(), new Date(NOW.getTime() + 1000).toISOString()],
      );
      expect(await cleanupRequestDedupe(NOW)).toBe(1);
      const rows = await anQuery<{ hash: string }>('SELECT hash FROM analytics.request_dedupe');
      expect(rows.map((row) => row.hash)).toEqual(['fresh']);
    });
  });

  it('keeps a week of the ingest ledger', async () => {
    await inDatabase(async () => {
      await anQuery(
        `INSERT INTO analytics.ingest_ledger (id, received_at) VALUES
           ('0199a5a4-7c00-7000-8000-000000000001', $1),
           ('0199a5a4-7c00-7000-8000-000000000002', $2)`,
        [
          new Date(NOW.getTime() - 8 * DAY_MS).toISOString(),
          new Date(NOW.getTime() - 6 * DAY_MS).toISOString(),
        ],
      );
      expect(await cleanupIngestLedger(NOW)).toBe(1);
      expect(await count('ingest_ledger')).toBe(1);
    });
  });

  it('keeps 30 days of replay chunks', async () => {
    await inDatabase(async () => {
      for (const [index, days] of [31, 29].entries()) {
        const startedAt = new Date(NOW.getTime() - days * DAY_MS).toISOString();
        await anQuery(
          `INSERT INTO analytics.session_replay_chunks
             (project_id, session_id, started_at, chunk_index, ended_at, payload)
           VALUES ('proj-a', 's', $1, $2, $1, '[]')`,
          [startedAt, index],
        );
      }
      expect(await cleanupReplayChunks(NOW)).toBe(1);
      expect(await count('session_replay_chunks')).toBe(1);
    });
  });

  it('applies the optional events retention', async () => {
    await inDatabase(async () => {
      await insertEvents([
        ...events('proj-a', 3, new Date(NOW.getTime() - 40 * DAY_MS)),
        ...events('proj-b', 2, NOW),
      ]);
      expect(await cleanupEventsOlderThan(30, NOW)).toBe(3);
      expect(await count('events')).toBe(2);
    });
  });
});

describe('refreshProjectEventCounts', () => {
  it('writes the event_names totals without session_start / session_end', async () => {
    await inDatabase(async () => {
      await db.organization.create({ data: { id: 'org-counts', name: 'Counts' } });
      await db.project.create({
        data: { id: 'proj-counts', name: 'Counts', organizationId: 'org-counts' },
      });
      await anQuery(
        `INSERT INTO analytics.event_names (project_id, name, event_count, first_seen_at, last_seen_at)
         VALUES ('proj-counts', 'screen_view', 40, now(), now()),
                ('proj-counts', 'signup', 2, now(), now()),
                ('proj-counts', 'session_start', 9, now(), now()),
                ('proj-counts', 'session_end', 9, now(), now())`,
      );

      expect(await refreshProjectEventCounts()).toBe(1);
      const project = await db.project.findUniqueOrThrow({ where: { id: 'proj-counts' } });
      expect(project.eventsCount).toBe(42);
      // Unchanged counts aren't written again.
      expect(await refreshProjectEventCounts()).toBe(0);
    });
  });
});
