/**
 * Background job queues on Cloudflare Queues.
 *
 * Every named queue that used to be a BullMQ `Queue` is now a thin producer
 * that sends `{ v, queue, name, data }` to the shared `JOBS_QUEUE` binding;
 * the worker's `op-jobs` consumer dispatches on `queue` + `name`. The exported
 * objects keep BullMQ's `.add(name, data, opts)` shape so producers stay as
 * they were.
 *
 * Cloudflare Queues have no job ids, deduplication or ordering. `jobId` and
 * `deduplication.id` travel with the message and the consumer drops
 * duplicates it sees in the same batch; the jobs themselves are idempotent
 * (they recompute and upsert).
 */
import type { Prisma } from '@openpanel/db';
import { getEnv } from '@openpanel/runtime';

/** Mirrors `@cloudflare/workers-types` Queue without depending on it. */
export interface QueueBinding<Body = unknown> {
  send(body: Body, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(
    messages: Iterable<{ body: Body; delaySeconds?: number }>,
  ): Promise<void>;
}

export const JOB_MESSAGE_VERSION = 1;

export type JobQueueName =
  | 'notification'
  | 'insights'
  | 'gsc'
  | 'cohortCompute'
  | 'import'
  | 'jobs';

export interface JobMessage<Data = unknown> {
  v: typeof JOB_MESSAGE_VERSION;
  queue: JobQueueName;
  name: string;
  data: Data;
  /** BullMQ jobId / deduplication id, used by the consumer to drop duplicates. */
  jobId?: string;
  enqueuedAt: number;
}

export interface JobsOptions {
  /** Delay in milliseconds (BullMQ semantics). Rounded up to whole seconds. */
  delay?: number;
  jobId?: string;
  deduplication?: { id: string };
  // Accepted for compatibility; Cloudflare Queues retries are configured on
  // the consumer (max_retries / retry_delay).
  attempts?: number;
  backoff?: unknown;
  removeOnComplete?: unknown;
  removeOnFail?: unknown;
}

// Cloudflare Queues cap delaySeconds at 24 hours.
const MAX_DELAY_SECONDS = 24 * 60 * 60;
// sendBatch accepts at most 100 messages per call.
const MAX_BATCH_SIZE = 100;

export function getJobsQueueBinding(): QueueBinding<JobMessage> {
  const binding = getEnv<{ JOBS_QUEUE?: QueueBinding<JobMessage> }>()
    .JOBS_QUEUE;
  if (!binding) {
    throw new Error(
      'JOBS_QUEUE binding is missing. Background jobs can only be enqueued from a Worker with the jobs queue bound.',
    );
  }
  return binding;
}

function toDelaySeconds(delayMs: number | undefined) {
  if (!delayMs || delayMs <= 0) {
    return undefined;
  }
  return Math.min(Math.ceil(delayMs / 1000), MAX_DELAY_SECONDS);
}

export class JobQueue<Data> {
  constructor(readonly name: JobQueueName) {}

  createMessage(jobName: string, data: Data, opts?: JobsOptions): JobMessage<Data> {
    const jobId = opts?.deduplication?.id ?? opts?.jobId;
    return {
      v: JOB_MESSAGE_VERSION,
      queue: this.name,
      name: jobName,
      data,
      ...(jobId ? { jobId } : {}),
      enqueuedAt: Date.now(),
    };
  }

  async add(jobName: string, data: Data, opts?: JobsOptions) {
    const message = this.createMessage(jobName, data, opts);
    await getJobsQueueBinding().send(message, {
      delaySeconds: toDelaySeconds(opts?.delay),
    });
    return { id: message.jobId, name: jobName, data };
  }

  async addBulk(
    jobs: Array<{ name: string; data: Data; opts?: JobsOptions }>,
  ) {
    const binding = getJobsQueueBinding();
    for (let i = 0; i < jobs.length; i += MAX_BATCH_SIZE) {
      await binding.sendBatch(
        jobs.slice(i, i + MAX_BATCH_SIZE).map((job) => ({
          body: this.createMessage(job.name, job.data, job.opts),
          delaySeconds: toDelaySeconds(job.opts?.delay),
        })),
      );
    }
  }
}

export type CronQueueType =
  | 'salt'
  | 'delete'
  | 'insightsDaily'
  | 'gscSync'
  | 'cohortRefresh'
  | 'sessionReaper'
  | 'insightCleanup'
  | 'weeklyDigest'
  | 'backup'
  | 'maintenance';

export type NotificationQueuePayload =
  | {
      type: 'sendNotification';
      payload: {
        notification: Prisma.NotificationUncheckedCreateInput;
      };
    }
  | {
      /** Match freshly ingested events against the project's event rules. */
      type: 'checkEventRules';
      payload: {
        projectId: string;
        /** Serialized event payloads (ISO dates) with their row ids. */
        events: Array<Record<string, unknown> & { id: string }>;
      };
    }
  | {
      /** Match closed sessions' events against the project's funnel rules. */
      type: 'checkFunnelRules';
      payload: { projectId: string; sessionIds: string[] };
    };

export const notificationQueue = new JobQueue<NotificationQueuePayload>(
  'notification',
);

export type ImportQueuePayload = {
  type: 'import';
  payload: {
    importId: string;
  };
};

export const importQueue = new JobQueue<ImportQueuePayload>('import');

export type InsightsQueuePayloadProject = {
  type: 'insightsProject';
  payload: { projectId: string; date: string };
};

export const insightsQueue = new JobQueue<InsightsQueuePayloadProject>(
  'insights',
);

export type GscQueuePayloadSync = {
  type: 'gscProjectSync';
  payload: { projectId: string };
};
export type GscQueuePayloadBackfill = {
  type: 'gscProjectBackfill';
  payload: { projectId: string };
};
export type GscQueuePayload = GscQueuePayloadSync | GscQueuePayloadBackfill;

export const gscQueue = new JobQueue<GscQueuePayload>('gsc');

export type CohortComputePayload = {
  cohortId: string;
};

export const cohortComputeQueue = new JobQueue<CohortComputePayload>(
  'cohortCompute',
);

/** Generic maintenance jobs fanned out by crons (digests, counts, cleanup). */
export type MaintenanceJobPayload =
  | { type: 'weeklyDigestProject'; payload: { projectId: string } }
  | { type: 'updateEventsCount'; payload: { projectId: string } }
  | { type: 'deleteProjectData'; payload: { projectId: string } };

export const jobsQueue = new JobQueue<MaintenanceJobPayload>('jobs');

export type AnyJobMessage =
  | (JobMessage<NotificationQueuePayload> & { queue: 'notification' })
  | (JobMessage<ImportQueuePayload> & { queue: 'import' })
  | (JobMessage<InsightsQueuePayloadProject> & { queue: 'insights' })
  | (JobMessage<GscQueuePayload> & { queue: 'gsc' })
  | (JobMessage<CohortComputePayload> & { queue: 'cohortCompute' })
  | (JobMessage<MaintenanceJobPayload> & { queue: 'jobs' });
