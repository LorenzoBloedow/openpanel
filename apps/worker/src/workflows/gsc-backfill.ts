import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { db, syncGscData } from '@openpanel/db';

import { gscLastCompleteDay } from '@/jobs/gsc';
import { inStepScope } from './scope';

export interface GscBackfillParams {
  projectId: string;
}

const BACKFILL_MONTHS = 6;
const CHUNK_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_CONFIG = {
  retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} as const;

/** 14-day windows covering the last six months, newest first. */
export function backfillWindows(now: Date): { from: string; to: string }[] {
  const end = gscLastCompleteDay(now);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - BACKFILL_MONTHS);
  const windows: { from: string; to: string }[] = [];
  let chunkEnd = end;
  while (chunkEnd > start) {
    const chunkStart = new Date(
      Math.max(chunkEnd.getTime() - (CHUNK_DAYS - 1) * DAY_MS, start.getTime()),
    );
    windows.push({
      from: chunkStart.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10),
    });
    chunkEnd = new Date(chunkStart.getTime() - DAY_MS);
  }
  return windows;
}

/**
 * Six months of Search Console history, one durable step per 14-day window
 * (a failed window retries on its own instead of restarting the backfill).
 */
export class GscBackfillWorkflow extends WorkflowEntrypoint<Env, GscBackfillParams> {
  async run(event: WorkflowEvent<GscBackfillParams>, step: WorkflowStep) {
    const { projectId } = event.payload;

    const ready = await step.do('start', () =>
      inStepScope(this.env, this.ctx, async () => {
        const connection = await db.gscConnection.findUnique({ where: { projectId } });
        if (!connection?.siteUrl) {
          return false;
        }
        await db.gscConnection.update({
          where: { projectId },
          data: { backfillStatus: 'running' },
        });
        return true;
      }),
    );
    if (!ready) {
      return { skipped: 'no connection or siteUrl' };
    }

    // The instance's creation time keeps the windows stable across replays.
    const windows = backfillWindows(new Date(event.timestamp));
    try {
      for (const window of windows) {
        await step.do(`sync ${window.from}..${window.to}`, SYNC_CONFIG, () =>
          inStepScope(this.env, this.ctx, () =>
            syncGscData(
              projectId,
              new Date(`${window.from}T00:00:00Z`),
              new Date(`${window.to}T00:00:00Z`),
            ),
          ),
        );
      }
    } catch (error) {
      await step.do('mark failed', () =>
        inStepScope(this.env, this.ctx, async () => {
          await db.gscConnection.update({
            where: { projectId },
            data: {
              backfillStatus: 'failed',
              lastSyncStatus: 'error',
              lastSyncError: error instanceof Error ? error.message : String(error),
            },
          });
        }),
      );
      throw error;
    }

    await step.do('complete', () =>
      inStepScope(this.env, this.ctx, async () => {
        await db.gscConnection.update({
          where: { projectId },
          data: {
            backfillStatus: 'completed',
            lastSyncedAt: new Date(),
            lastSyncStatus: 'success',
            lastSyncError: null,
          },
        });
      }),
    );
    return { windows: windows.length };
  }
}
