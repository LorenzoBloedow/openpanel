import { generateSalt } from '@openpanel/common/server';
import { db, getSalts } from '@openpanel/db';
import {
  cleanupEventsOlderThan,
  cleanupIngestLedger,
  cleanupReplayChunks,
  cleanupRequestDedupe,
  refreshProjectEventCounts,
} from '@openpanel/db/src/analytics/maintenance';
import type { ILogger } from '@openpanel/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 5000;

/**
 * Daily salt rotation: a new salt, keeping the previous newest so device
 * ids stay stable across midnight. An interactive transaction pins one
 * connection, which transaction-mode pooling supports.
 */
export async function rotateSalt(): Promise<void> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; ; attempt++) {
    try {
      await db.$transaction(async (tx) => {
        const existing = await tx.salt.findMany({
          orderBy: { createdAt: 'desc' },
          take: 2,
        });
        const created = await tx.salt.create({ data: { salt: generateSalt() } });
        const keep = existing[0] ? [created.salt, existing[0].salt] : [created.salt];
        await tx.salt.deleteMany({ where: { salt: { notIn: keep } } });
      });
      await getSalts.clear();
      return;
    } catch (error) {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

/**
 * Organizations and projects due for deletion: scheduled ones, and
 * organizations nobody administers any more.
 */
export async function findScheduledDeletions(now = new Date()) {
  const organizations = await db.organization.findMany({
    where: {
      OR: [
        { deleteAt: { lte: now } },
        { members: { none: { role: 'org:admin' } } },
      ],
    },
    include: { projects: { select: { id: true } } },
  });
  const scheduledProjects = await db.project.findMany({
    where: { deleteAt: { lte: now } },
    select: { id: true },
  });
  const projectIds = [
    ...new Set([
      ...organizations.flatMap((organization) =>
        organization.projects.map((project) => project.id),
      ),
      ...scheduledProjects.map((project) => project.id),
    ]),
  ];
  return {
    projectIds,
    organizationIds: organizations.map((organization) => organization.id),
  };
}

async function deleteInBatches(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < 2000; batch++) {
    const deleted = await run();
    total += deleted;
    if (deleted < BATCH_SIZE) {
      break;
    }
  }
  return total;
}

/**
 * Insights retention (INSIGHTS_RETENTION_DAYS, default 90): suppressed rows
 * go unconditionally, closed ones once not seen since the cutoff, and old
 * insight events are trimmed. Active insights are never touched.
 */
async function cleanupInsights(retentionDays: number) {
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  const suppressed = await deleteInBatches(
    () => db.$executeRaw`
      DELETE FROM "project_insights"
      WHERE "id" IN (
        SELECT "id" FROM "project_insights"
        WHERE "state" = 'suppressed'
        LIMIT ${BATCH_SIZE}
      )`,
  );
  const closed = await deleteInBatches(
    () => db.$executeRaw`
      DELETE FROM "project_insights"
      WHERE "id" IN (
        SELECT "id" FROM "project_insights"
        WHERE "state" = 'closed' AND "lastSeenAt" < ${cutoff}
        LIMIT ${BATCH_SIZE}
      )`,
  );
  const events = await deleteInBatches(
    () => db.$executeRaw`
      DELETE FROM "insight_events"
      WHERE "id" IN (
        SELECT "id" FROM "insight_events"
        WHERE "createdAt" < ${cutoff}
        LIMIT ${BATCH_SIZE}
      )`,
  );
  return { insights: suppressed + closed, insightEvents: events };
}

function positiveInt(value: string | undefined, fallback?: number) {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Hourly: counters and short-lived state. */
export async function hourlyMaintenance(logger: ILogger) {
  const now = new Date();
  const [projectCounts, dedupe, rateLimitBlocks, cronRuns] = await Promise.all([
    refreshProjectEventCounts(),
    cleanupRequestDedupe(now),
    db.rateLimitBlock.deleteMany({ where: { strikeExpiresAt: { lt: now } } }),
    db.cronRun.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - 30 * DAY_MS) } },
    }),
  ]);
  logger.info(
    {
      projectCounts,
      dedupe,
      rateLimitBlocks: rateLimitBlocks.count,
      cronRuns: cronRuns.count,
    },
    'Hourly maintenance complete',
  );
}

/** Daily (04:30 UTC): retention sweeps. */
export async function dailyCleanup(env: Env, logger: ILogger) {
  const now = new Date();
  const insights = await cleanupInsights(
    positiveInt(env.INSIGHTS_RETENTION_DAYS, 90)!,
  );
  const replayChunks = await cleanupReplayChunks(now);
  const ledger = await cleanupIngestLedger(now);
  const retentionDays = positiveInt(env.EVENTS_RETENTION_DAYS);
  const events = retentionDays
    ? await cleanupEventsOlderThan(retentionDays, now)
    : 0;
  logger.info(
    { ...insights, replayChunks, ledger, events, retentionDays },
    'Daily cleanup complete',
  );
}
