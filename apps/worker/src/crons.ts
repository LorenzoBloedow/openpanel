import { createHash } from 'node:crypto';
import { db } from '@openpanel/db';
import { reapIdleSessions } from '@openpanel/db/src/ingest/reaper';
import type { ILogger } from '@openpanel/logger';
import {
  cohortComputeQueue,
  gscQueue,
  insightsQueue,
  jobsQueue,
} from '@openpanel/queue';

import { afterCommit } from '@/consumers/events';
import { listDynamicCohorts, listInsightProjects } from '@/jobs/analytics';
import { listDigestProjects } from '@/jobs/digest';
import { listGscProjects } from '@/jobs/gsc';
import {
  dailyCleanup,
  findScheduledDeletions,
  hourlyMaintenance,
  rotateSalt,
} from '@/jobs/maintenance';
import { startWorkflow } from '@/workflows/start';

/**
 * The worker's crons (wrangler.jsonc `triggers.crons`). The minute cron
 * reaps sessions itself; every other cron only enqueues jobs or starts
 * Workflows, so it stays well inside a cron's CPU budget. A cron slot is
 * claimed in `cron_runs` first: Cloudflare may fire a trigger twice.
 */
export const CRONS = {
  '* * * * *': 'sessionReaper',
  '0 0 * * *': 'salt',
  '0 * * * *': 'hourly',
  '*/30 * * * *': 'cohortRefresh',
  '0 2 * * *': 'insightsDaily',
  '0 3 * * *': 'nightly',
  '30 4 * * *': 'cleanup',
  '0 8 * * 1': 'weeklyDigest',
} as const;

type CronTask = (typeof CRONS)[keyof typeof CRONS];

const REAPER_PAGE_SIZE = 500;
/** Leave headroom under the cron's wall-clock and CPU budget. */
const REAPER_BUDGET_MS = 25_000;

/**
 * Close sessions idle for longer than the timeout (wall clock). Pages of
 * up to 500 sessions, each in its own transaction, until a short page or
 * the time budget runs out; the next minute picks up the rest.
 */
export async function runSessionReaper(
  env: Env,
  logger: ILogger,
): Promise<number> {
  if (env.SESSION_REAPER === '0') {
    return 0;
  }
  const deadline = Date.now() + REAPER_BUDGET_MS;
  let closed = 0;
  for (;;) {
    const result = await reapIdleSessions({ limit: REAPER_PAGE_SIZE });
    closed += result.closed.length;
    await afterCommit(
      env,
      { insertedEvents: result.insertedEvents, closedSessions: result.closed },
      logger,
    );
    if (result.closed.length < REAPER_PAGE_SIZE || Date.now() > deadline) {
      break;
    }
  }
  if (closed > 0) {
    logger.info({ closed }, 'Session reaper closed idle sessions');
  }
  return closed;
}

/** Claim this run of `task` (idempotent across duplicate triggers). */
export async function claimCronSlot(
  task: CronTask,
  scheduledTime: number,
): Promise<boolean> {
  const slot = new Date(Math.floor(scheduledTime / 60_000) * 60_000);
  const inserted = await db.$executeRaw`
    INSERT INTO cron_runs (name, slot, "createdAt")
    VALUES (${task}, ${slot}, now())
    ON CONFLICT DO NOTHING
  `;
  return inserted === 1;
}

async function startScheduledDeletions(env: Env, logger: ILogger) {
  const { projectIds, organizationIds } = await findScheduledDeletions();
  if (projectIds.length === 0 && organizationIds.length === 0) {
    return;
  }
  const key = createHash('sha256')
    .update([...projectIds, '|', ...organizationIds].join(','))
    .digest('hex')
    .slice(0, 16);
  await startWorkflow(
    env.PROJECT_DELETE,
    `delete-${key}`,
    { projectIds, organizationIds },
    logger,
  );
  logger.info(
    { projects: projectIds.length, organizations: organizationIds.length },
    'Scheduled deletions started',
  );
}

async function runTask(
  task: CronTask,
  env: Env,
  logger: ILogger,
  scheduledTime: number,
) {
  const date = new Date(scheduledTime).toISOString().slice(0, 10);
  switch (task) {
    case 'sessionReaper':
      await runSessionReaper(env, logger);
      return;
    case 'salt':
      await rotateSalt();
      return;
    case 'hourly':
      await hourlyMaintenance(logger);
      await startScheduledDeletions(env, logger);
      return;
    case 'cohortRefresh': {
      const cohortIds = await listDynamicCohorts();
      await cohortComputeQueue.addBulk(
        cohortIds.map((cohortId) => ({
          name: 'cohortCompute',
          data: { cohortId },
          opts: { jobId: `cohort-${cohortId}` },
        })),
      );
      return;
    }
    case 'insightsDaily': {
      const projectIds = await listInsightProjects();
      await insightsQueue.addBulk(
        projectIds.map((projectId) => ({
          name: 'insightsProject',
          data: { type: 'insightsProject', payload: { projectId, date } },
          opts: { jobId: `daily:${date}:${projectId}` },
        })),
      );
      return;
    }
    case 'nightly': {
      const projectIds = await listGscProjects();
      await gscQueue.addBulk(
        projectIds.map((projectId) => ({
          name: 'gscProjectSync',
          data: { type: 'gscProjectSync', payload: { projectId } },
        })),
      );
      if (env.BACKUPS) {
        await startWorkflow(env.BACKUP, `backup-${date}`, { date }, logger);
      }
      return;
    }
    case 'cleanup':
      await dailyCleanup(env, logger);
      return;
    case 'weeklyDigest': {
      const projectIds = await listDigestProjects();
      await jobsQueue.addBulk(
        projectIds.map((projectId) => ({
          name: 'weeklyDigestProject',
          data: { type: 'weeklyDigestProject', payload: { projectId } },
          opts: { jobId: `digest:${date}:${projectId}` },
        })),
      );
      return;
    }
    default:
      logger.warn({ task }, 'No handler for cron task');
  }
}

export async function runScheduled(
  controller: { cron: string; scheduledTime: number },
  env: Env,
  logger: ILogger,
): Promise<void> {
  const task = CRONS[controller.cron as keyof typeof CRONS];
  if (!task) {
    logger.warn({ cron: controller.cron }, 'No handler for cron');
    return;
  }
  // The reaper is idempotent (SKIP LOCKED) and runs every minute.
  if (task !== 'sessionReaper' && !(await claimCronSlot(task, controller.scheduledTime))) {
    logger.info({ task }, 'Cron slot already claimed');
    return;
  }
  await runTask(task, env, logger, controller.scheduledTime);
}
