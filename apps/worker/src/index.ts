import { runWithScope } from '@openpanel/runtime';

import { consumeEvents } from './consumers/events';
import { consumeJobs } from './consumers/jobs';
import { runScheduled } from './crons';
import { logger } from './utils/logger';

export { BackupWorkflow } from './workflows/backup';
export { GscBackfillWorkflow } from './workflows/gsc-backfill';
export { ProjectDeleteWorkflow } from './workflows/project-delete';

/**
 * openpanel-worker: queue consumers, crons and Workflows. Nothing here has
 * a user waiting on it, so every invocation uses the direct database route.
 */
export default {
  async queue(batch, env, ctx) {
    await runWithScope({ env, ctx, route: 'direct' }, async () => {
      switch (batch.queue) {
        case 'op-events':
          await consumeEvents(batch.messages, env, logger);
          return;
        case 'op-jobs':
          await consumeJobs(batch.messages, env, logger);
          return;
        default:
          logger.error({ queue: batch.queue }, 'Unknown queue');
          batch.retryAll({ delaySeconds: 60 });
      }
    });
  },

  async scheduled(controller, env, ctx) {
    await runWithScope({ env, ctx, route: 'direct' }, () =>
      runScheduled(controller, env, logger),
    );
  },
} satisfies ExportedHandler<Env>;
