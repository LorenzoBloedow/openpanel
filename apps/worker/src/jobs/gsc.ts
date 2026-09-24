import { db, syncGscData } from '@openpanel/db';
import type { ILogger } from '@openpanel/logger';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Yesterday (UTC midnight) — Search Console data lags by a day or more. */
function yesterday(now = new Date()) {
  const day = new Date(now.getTime() - DAY_MS);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

async function recordSync(
  projectId: string,
  result: { ok: true } | { ok: false; error: unknown },
) {
  await db.gscConnection.update({
    where: { projectId },
    data: {
      lastSyncedAt: new Date(),
      lastSyncStatus: result.ok ? 'success' : 'error',
      lastSyncError: result.ok
        ? null
        : result.error instanceof Error
          ? result.error.message
          : String(result.error),
    },
  });
}

/** Nightly sync of a rolling three-day window (GSC data arrives late). */
export async function gscProjectSyncJob(projectId: string, logger: ILogger) {
  const connection = await db.gscConnection.findUnique({ where: { projectId } });
  if (!connection?.siteUrl) {
    logger.warn({ projectId }, 'GSC sync skipped: no connection or siteUrl');
    return;
  }
  const endDate = yesterday();
  const startDate = new Date(endDate.getTime() - 2 * DAY_MS);
  try {
    await syncGscData(projectId, startDate, endDate);
    await recordSync(projectId, { ok: true });
    logger.info({ projectId }, 'GSC sync completed');
  } catch (error) {
    await recordSync(projectId, { ok: false, error });
    throw error;
  }
}

/** Projects with a connected Search Console site. */
export async function listGscProjects() {
  const connections = await db.gscConnection.findMany({
    where: { siteUrl: { not: '' } },
    select: { projectId: true },
  });
  return connections.map((connection) => connection.projectId);
}

export { recordSync as recordGscSync, yesterday as gscLastCompleteDay };
