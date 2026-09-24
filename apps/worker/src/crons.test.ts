/**
 * Cron dispatch against a throwaway Postgres database: slot claims make a
 * duplicate trigger a no-op, and enqueue-only crons send their fan-out to
 * JOBS_QUEUE (a fake binding here).
 */
import { db } from '@openpanel/db';
import {
  type TestDatabase,
  createTestDatabase,
} from '@openpanel/db/src/testing/database';
import type { JobMessage } from '@openpanel/queue';
import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimCronSlot, runScheduled, runSessionReaper } from './crons';

let database: TestDatabase;

const sent: JobMessage[] = [];
const jobsQueue = {
  send: vi.fn(async (body: JobMessage) => {
    sent.push(body);
  }),
  sendBatch: vi.fn(async (messages: Iterable<{ body: JobMessage }>) => {
    for (const message of messages) {
      sent.push(message.body);
    }
  }),
};
const backupWorkflow = {
  get: vi.fn(async () => {
    throw new Error('not found');
  }),
  create: vi.fn(async () => ({})),
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as never;

const env = (extra: Record<string, unknown> = {}) =>
  ({
    DATABASE_URL: database.url,
    JOBS_QUEUE: jobsQueue,
    BACKUP: backupWorkflow,
    ...extra,
  }) as unknown as Env;

function scheduled(cron: string, scheduledTime: number, workerEnv = env()) {
  return runWithScope({ env: workerEnv, route: 'direct' }, () =>
    runScheduled({ cron, scheduledTime }, workerEnv, logger),
  );
}

const inDatabase = <T>(fn: () => Promise<T>) =>
  runWithScope({ env: env(), route: 'direct' }, fn);

beforeAll(async () => {
  database = await createTestDatabase();
  await inDatabase(async () => {
    await db.organization.create({ data: { id: 'org-cron', name: 'Cron org' } });
    await db.project.create({
      data: { id: 'proj-cron', name: 'Cron project', organizationId: 'org-cron' },
    });
    await db.cohort.createMany({
      data: [
        { id: '0199a5a4-7c00-7000-8000-00000000c001', name: 'Dynamic', projectId: 'proj-cron' },
        {
          id: '0199a5a4-7c00-7000-8000-00000000c002',
          name: 'Static',
          projectId: 'proj-cron',
          isStatic: true,
        },
      ],
    });
  });
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(() => {
  sent.length = 0;
  jobsQueue.send.mockClear();
  jobsQueue.sendBatch.mockClear();
  backupWorkflow.get.mockClear();
  backupWorkflow.create.mockClear();
});

describe('claimCronSlot', () => {
  it('claims each (task, minute) once', async () => {
    const at = Date.UTC(2026, 8, 21, 2, 0, 0);
    await inDatabase(async () => {
      expect(await claimCronSlot('insightsDaily', at)).toBe(true);
      // The same minute, even a few seconds later, is the same slot.
      expect(await claimCronSlot('insightsDaily', at + 5000)).toBe(false);
      expect(await claimCronSlot('insightsDaily', at + 60_000)).toBe(true);
      expect(await claimCronSlot('cleanup', at)).toBe(true);
    });
  });
});

describe('runScheduled', () => {
  it('fans the cohort refresh out once per slot', async () => {
    const at = Date.UTC(2026, 8, 21, 10, 30, 0);
    await scheduled('*/30 * * * *', at);
    await scheduled('*/30 * * * *', at);

    expect(sent).toEqual([
      expect.objectContaining({
        queue: 'cohortCompute',
        name: 'cohortCompute',
        data: { cohortId: '0199a5a4-7c00-7000-8000-00000000c001' },
        jobId: 'cohort-0199a5a4-7c00-7000-8000-00000000c001',
      }),
    ]);
  });

  it('starts the nightly backup under the date', async () => {
    const at = Date.UTC(2026, 8, 21, 3, 0, 0);
    await scheduled('0 3 * * *', at, env({ BACKUPS: {} }));
    expect(backupWorkflow.create).toHaveBeenCalledWith({
      id: 'backup-2026-09-21',
      params: { date: '2026-09-21' },
    });
  });

  it('skips the backup when no bucket is bound', async () => {
    await scheduled('0 3 * * *', Date.UTC(2026, 8, 22, 3, 0, 0));
    expect(backupWorkflow.create).not.toHaveBeenCalled();
  });

  it('ignores crons it has no task for', async () => {
    await scheduled('*/5 * * * *', Date.UTC(2026, 8, 21, 10, 5, 0));
    expect(sent).toEqual([]);
    expect(backupWorkflow.create).not.toHaveBeenCalled();
  });
});

describe('runSessionReaper', () => {
  it('can be switched off', async () => {
    expect(await runSessionReaper(env({ SESSION_REAPER: '0' }), logger)).toBe(0);
  });

  it('closes nothing when no session is idle', async () => {
    expect(await runWithScope({ env: env(), route: 'direct' }, () => runSessionReaper(env(), logger))).toBe(0);
  });
});
