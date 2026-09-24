import { refreshProjectEventCounts } from '@openpanel/db/src/analytics/maintenance';
import type { ILogger } from '@openpanel/logger';
import type { AnyJobMessage } from '@openpanel/queue';
import {
  FeatureUnavailableError,
  isFeatureUnavailableError,
} from '@openpanel/runtime';

import { cohortComputeJob, insightsProjectJob } from '@/jobs/analytics';
import { weeklyDigestProjectJob } from '@/jobs/digest';
import { gscProjectSyncJob } from '@/jobs/gsc';
import {
  checkEventRulesJob,
  checkFunnelRulesJob,
  sendNotificationJob,
} from '@/jobs/notification';
import { startWorkflow } from '@/workflows/start';
import type { QueueMessage } from './message';

/**
 * The op-jobs consumer: the background jobs BullMQ ran, dispatched on the
 * message's `queue` + payload type. Duplicate job ids within a batch run
 * once. A failing job is retried with backoff and lands in the DLQ after
 * max_retries; jobs of features compiled out on Cloudflare are dropped.
 */

function isJobMessage(body: unknown): body is AnyJobMessage {
  return (
    !!body &&
    typeof body === 'object' &&
    'queue' in body &&
    'data' in body &&
    typeof (body as { queue: unknown }).queue === 'string'
  );
}

function retryDelaySeconds(attempts: number) {
  return Math.min(900, 30 * 2 ** Math.max(0, attempts - 1));
}

export async function runJob(
  message: AnyJobMessage,
  env: Env,
  logger: ILogger,
): Promise<void> {
  switch (message.queue) {
    case 'notification': {
      const job = message.data;
      switch (job.type) {
        case 'sendNotification':
          return sendNotificationJob(job.payload, env);
        case 'checkEventRules':
          return checkEventRulesJob(job.payload);
        case 'checkFunnelRules':
          return checkFunnelRulesJob(job.payload);
        default:
          throw new Error(`Unknown notification job: ${JSON.stringify(job)}`);
      }
    }
    case 'cohortCompute':
      return cohortComputeJob(message.data);
    case 'insights':
      return insightsProjectJob(message.data.payload);
    case 'gsc': {
      const job = message.data;
      if (job.type === 'gscProjectSync') {
        return gscProjectSyncJob(job.payload.projectId, logger);
      }
      await startWorkflow(env.GSC_BACKFILL, `gsc-backfill-${job.payload.projectId}`, {
        projectId: job.payload.projectId,
      }, logger);
      return;
    }
    case 'jobs': {
      const job = message.data;
      switch (job.type) {
        case 'weeklyDigestProject':
          return weeklyDigestProjectJob(job.payload.projectId, env, logger);
        case 'updateEventsCount':
          await refreshProjectEventCounts();
          return;
        case 'deleteProjectData':
          await startWorkflow(
            env.PROJECT_DELETE,
            `delete-${job.payload.projectId}`,
            { projectIds: [job.payload.projectId], organizationIds: [] },
            logger,
          );
          return;
        default:
          throw new Error(`Unknown maintenance job: ${JSON.stringify(job)}`);
      }
    }
    case 'import':
      throw new FeatureUnavailableError('importers');
    default:
      throw new Error(`Unknown job queue: ${JSON.stringify(message)}`);
  }
}

export async function consumeJobs(
  messages: readonly QueueMessage[],
  env: Env,
  logger: ILogger,
): Promise<void> {
  const seen = new Set<string>();
  for (const message of messages) {
    const body = message.body;
    if (!isJobMessage(body)) {
      logger.error({ messageId: message.id, body }, 'Invalid job message');
      message.ack();
      continue;
    }
    if (body.jobId) {
      if (seen.has(body.jobId)) {
        message.ack();
        continue;
      }
      seen.add(body.jobId);
    }
    try {
      await runJob(body, env, logger);
      message.ack();
    } catch (error) {
      if (isFeatureUnavailableError(error)) {
        logger.warn(
          { queue: body.queue, name: body.name, feature: error.feature },
          'Job dropped: feature not available on Cloudflare',
        );
        message.ack();
        continue;
      }
      logger.error(
        { err: error, queue: body.queue, name: body.name, attempts: message.attempts },
        'Job failed',
      );
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}
