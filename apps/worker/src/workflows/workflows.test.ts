/**
 * The Workflows' step logic, driven by a fake `step` against a throwaway
 * Postgres database. The fake runs each callback at once, rejects duplicate
 * step names (Workflows cache results by name) and clones results the way
 * persisted step state would be.
 */
import { db } from '@openpanel/db';
import { anQuery } from '@openpanel/db/src/analytics/client';
import { insertEvents } from '@openpanel/db/src/analytics/writers';
import { listCompleteBackups, readManifest } from '@openpanel/db/src/backup/backup';
import { MemoryBucket } from '@openpanel/db/src/backup/memory-bucket';
import {
  type TestDatabase,
  createTestDatabase,
} from '@openpanel/db/src/testing/database';
import { runWithScope } from '@openpanel/runtime';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { BackupWorkflow } from './backup';
import { GscBackfillWorkflow, backfillWindows } from './gsc-backfill';
import { ProjectDeleteWorkflow } from './project-delete';
import { startWorkflow } from './start';

let database: TestDatabase;

const inDatabase = <T>(fn: () => Promise<T>) =>
  runWithScope({ env: { DATABASE_URL: database.url }, route: 'direct' }, fn);

function fakeStep() {
  const names: string[] = [];
  const step = {
    async do(name: string, configOrFn: unknown, maybeFn?: () => Promise<unknown>) {
      const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as () => Promise<unknown>;
      if (names.includes(name)) {
        throw new Error(`Duplicate step name: ${name}`);
      }
      names.push(name);
      const result = await fn();
      return result === undefined ? undefined : structuredClone(result);
    },
  };
  return { step: step as unknown as WorkflowStep, names };
}

function workflowEvent<T>(payload: T, timestamp = new Date('2026-09-21T03:00:00Z')) {
  return { payload, timestamp, instanceId: 'test' } as WorkflowEvent<T>;
}

function events(projectId: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    name: 'screen_view',
    device_id: `device-${i}`,
    profile_id: `device-${i}`,
    project_id: projectId,
    session_id: `session-${i}`,
    properties: {},
    created_at: new Date(Date.UTC(2026, 8, 20, 12, i)).toISOString(),
  }));
}

const testEnv = (extra: Record<string, unknown> = {}) =>
  ({ DATABASE_URL: database.url, ...extra }) as unknown as Env;

beforeAll(async () => {
  database = await createTestDatabase();
  await inDatabase(async () => {
    for (const id of ['a', 'b']) {
      await db.organization.create({ data: { id: `org-${id}`, name: `Org ${id}` } });
      await db.project.create({
        data: { id: `proj-${id}`, name: `Project ${id}`, organizationId: `org-${id}` },
      });
    }
    await insertEvents([...events('proj-a', 30), ...events('proj-b', 12)]);
  });
});

afterAll(async () => {
  await database?.drop();
});

describe('BackupWorkflow', () => {
  it('exports every table, then writes the manifest and prunes', async () => {
    const bucket = new MemoryBucket();
    const { step, names } = fakeStep();
    const workflow = new BackupWorkflow(
      undefined as never,
      testEnv({ BACKUPS: bucket, BACKUP_RETENTION_DAYS: '30', BACKUP_FULL_EVERY_DAYS: '7' }),
    );
    const result = await workflow.run(workflowEvent({ date: '2026-09-21' }), step);

    expect(result).toMatchObject({ date: '2026-09-21', pruned: [] });
    expect(names[0]).toBe('plan');
    expect(names).toContain('export analytics.events #0');
    expect(names.slice(-2)).toEqual(['manifest', 'prune']);
    expect(await listCompleteBackups(bucket)).toEqual(['2026-09-21']);
    const manifest = await readManifest(bucket, '2026-09-21');
    const eventsTable = manifest?.tables.find((table) => table.table === 'events');
    expect(eventsTable).toMatchObject({ mode: 'full', rows: 42 });
    const projects = manifest?.tables.find((table) => table.table === 'projects');
    expect(projects?.rows).toBe(2);
  });

  it('does nothing without a bucket bound', async () => {
    const { step, names } = fakeStep();
    const workflow = new BackupWorkflow(undefined as never, testEnv());
    expect(await workflow.run(workflowEvent({ date: '2026-09-21' }), step)).toEqual({
      skipped: 'no BACKUPS bucket bound',
    });
    expect(names).toEqual([]);
  });
});

describe('ProjectDeleteWorkflow', () => {
  it('deletes the analytics rows, the project and the organization, and can rerun', async () => {
    const env = testEnv();
    const params = { projectIds: ['proj-a'], organizationIds: ['org-a'] };
    const first = await new ProjectDeleteWorkflow(undefined as never, env).run(
      workflowEvent(params),
      fakeStep().step,
    );
    expect(first).toMatchObject({ projects: 1, organizations: 1 });
    expect(first.rows).toBeGreaterThanOrEqual(30);

    await inDatabase(async () => {
      const counts = await anQuery<{ project_id: string; n: number }>(
        'SELECT project_id, count(*)::int AS n FROM analytics.events GROUP BY project_id',
      );
      expect(counts).toEqual([{ project_id: 'proj-b', n: 12 }]);
      expect(await db.project.findUnique({ where: { id: 'proj-a' } })).toBeNull();
      expect(await db.organization.findUnique({ where: { id: 'org-a' } })).toBeNull();
      expect(await db.project.findUnique({ where: { id: 'proj-b' } })).not.toBeNull();
    });

    // A rerun (e.g. the hourly cron starting it again) finds nothing to do.
    const second = await new ProjectDeleteWorkflow(undefined as never, env).run(
      workflowEvent(params),
      fakeStep().step,
    );
    expect(second.rows).toBe(0);
  });
});

describe('GscBackfillWorkflow', () => {
  it('skips projects without a Search Console site', async () => {
    const { step, names } = fakeStep();
    const result = await new GscBackfillWorkflow(undefined as never, testEnv()).run(
      workflowEvent({ projectId: 'proj-b' }),
      step,
    );
    expect(result).toEqual({ skipped: 'no connection or siteUrl' });
    expect(names).toEqual(['start']);
  });

  it('covers six months in contiguous 14-day windows, newest first', () => {
    const windows = backfillWindows(new Date('2026-09-21T03:00:00Z'));
    expect(windows[0]).toEqual({ from: '2026-09-07', to: '2026-09-20' });
    expect(windows.at(-1)?.from).toBe('2026-03-20');
    for (let i = 1; i < windows.length; i++) {
      const previousFrom = Date.parse(windows[i - 1]!.from);
      expect(Date.parse(windows[i]!.to)).toBe(previousFrom - 24 * 60 * 60 * 1000);
    }
    expect(new Set(windows.map((window) => `${window.from}..${window.to}`)).size).toBe(
      windows.length,
    );
  });
});

describe('startWorkflow', () => {
  const logger = { info: vi.fn() } as never;

  function binding(status?: string) {
    return {
      get: vi.fn(async (id: string) => {
        if (!status) {
          throw new Error(`instance ${id} not found`);
        }
        return { status: async () => ({ status }) };
      }),
      create: vi.fn(async () => ({})),
    };
  }

  it('creates the instance under its stable id', async () => {
    const workflow = binding();
    expect(await startWorkflow(workflow as never, 'backup-2026-09-21', {}, logger)).toBe(
      'backup-2026-09-21',
    );
    expect(workflow.create).toHaveBeenCalledWith({ id: 'backup-2026-09-21', params: {} });
  });

  it('leaves an instance in progress alone', async () => {
    const workflow = binding('running');
    expect(await startWorkflow(workflow as never, 'backup-2026-09-21', {}, logger)).toBe(
      'backup-2026-09-21',
    );
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it('starts a finished one again under a new id', async () => {
    const workflow = binding('errored');
    const id = await startWorkflow(workflow as never, 'backup-2026-09-21', {}, logger);
    expect(id).toMatch(/^backup-2026-09-21-[a-z0-9]+$/);
    expect(workflow.create).toHaveBeenCalledWith({ id, params: {} });
  });

  it('keeps ids within the allowed characters', async () => {
    const workflow = binding();
    expect(await startWorkflow(workflow as never, 'gsc backfill/p:1', {}, logger)).toBe(
      'gsc-backfill-p-1',
    );
  });
});
