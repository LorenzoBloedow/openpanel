import { reapIdleSessions } from '@openpanel/db/src/ingest/reaper';
import type { ILogger } from '@openpanel/logger';

import { afterCommit } from '@/consumers/events';

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

export async function runScheduled(
  cron: string,
  env: Env,
  logger: ILogger,
): Promise<void> {
  switch (cron) {
    case '* * * * *':
      await runSessionReaper(env, logger);
      return;
    default:
      logger.warn({ cron }, 'No handler for cron');
  }
}
