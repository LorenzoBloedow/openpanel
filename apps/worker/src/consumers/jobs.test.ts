/**
 * The op-jobs consumer's dispatch and retry policy. The jobs themselves are
 * mocked; they're covered by their own modules' tests.
 */
import { FeatureUnavailableError } from '@openpanel/runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendNotificationJob = vi.fn();
const checkEventRulesJob = vi.fn();
const cohortComputeJob = vi.fn();
const gscProjectSyncJob = vi.fn();
const weeklyDigestProjectJob = vi.fn();
const refreshProjectEventCounts = vi.fn();
const startWorkflow = vi.fn();

vi.mock('@/jobs/notification', () => ({
  sendNotificationJob: (...args: unknown[]) => sendNotificationJob(...args),
  checkEventRulesJob: (...args: unknown[]) => checkEventRulesJob(...args),
  checkFunnelRulesJob: vi.fn(),
}));
vi.mock('@/jobs/analytics', () => ({
  cohortComputeJob: (...args: unknown[]) => cohortComputeJob(...args),
  insightsProjectJob: vi.fn(),
}));
vi.mock('@/jobs/gsc', () => ({
  gscProjectSyncJob: (...args: unknown[]) => gscProjectSyncJob(...args),
}));
vi.mock('@/jobs/digest', () => ({
  weeklyDigestProjectJob: (...args: unknown[]) => weeklyDigestProjectJob(...args),
}));
vi.mock('@openpanel/db/src/analytics/maintenance', () => ({
  refreshProjectEventCounts: (...args: unknown[]) => refreshProjectEventCounts(...args),
}));
vi.mock('@/workflows/start', () => ({
  startWorkflow: (...args: unknown[]) => startWorkflow(...args),
}));

const { consumeJobs } = await import('./jobs');

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as never;
const env = { GSC_BACKFILL: { name: 'gsc' }, PROJECT_DELETE: { name: 'delete' } } as unknown as Env;

function job(queue: string, name: string, data: unknown, jobId?: string) {
  return { v: 1, queue, name, data, enqueuedAt: 0, ...(jobId ? { jobId } : {}) };
}

function message(body: unknown, attempts = 1) {
  return { id: crypto.randomUUID(), body, attempts, ack: vi.fn(), retry: vi.fn() };
}

beforeEach(() => {
  for (const mock of [
    sendNotificationJob,
    checkEventRulesJob,
    cohortComputeJob,
    gscProjectSyncJob,
    weeklyDigestProjectJob,
    refreshProjectEventCounts,
    startWorkflow,
  ]) {
    mock.mockReset();
  }
});

describe('consumeJobs', () => {
  it('dispatches on queue and job type, and acks', async () => {
    const messages = [
      message(job('notification', 'sendNotification', {
        type: 'sendNotification',
        payload: { notification: { projectId: 'p1' } },
      })),
      message(job('notification', 'checkEventRules', {
        type: 'checkEventRules',
        payload: { projectId: 'p1', events: [] },
      })),
      message(job('cohortCompute', 'cohortCompute', { cohortId: 'c1' })),
      message(job('gsc', 'gscProjectSync', { type: 'gscProjectSync', payload: { projectId: 'p1' } })),
      message(job('jobs', 'weeklyDigestProject', { type: 'weeklyDigestProject', payload: { projectId: 'p1' } })),
      message(job('jobs', 'updateEventsCount', { type: 'updateEventsCount', payload: { projectId: 'p1' } })),
    ];
    await consumeJobs(messages, env, logger);

    expect(sendNotificationJob).toHaveBeenCalledWith({ notification: { projectId: 'p1' } }, env);
    expect(checkEventRulesJob).toHaveBeenCalledWith({ projectId: 'p1', events: [] });
    expect(cohortComputeJob).toHaveBeenCalledWith({ cohortId: 'c1' });
    expect(gscProjectSyncJob).toHaveBeenCalledWith('p1', logger);
    expect(weeklyDigestProjectJob).toHaveBeenCalledWith('p1', env, logger);
    expect(refreshProjectEventCounts).toHaveBeenCalledTimes(1);
    for (const m of messages) {
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(m.retry).not.toHaveBeenCalled();
    }
  });

  it('starts Workflows under stable ids', async () => {
    await consumeJobs(
      [
        message(job('gsc', 'gscProjectBackfill', { type: 'gscProjectBackfill', payload: { projectId: 'p1' } })),
        message(job('jobs', 'deleteProjectData', { type: 'deleteProjectData', payload: { projectId: 'p2' } })),
      ],
      env,
      logger,
    );
    expect(startWorkflow).toHaveBeenCalledWith(
      env.GSC_BACKFILL,
      'gsc-backfill-p1',
      { projectId: 'p1' },
      logger,
    );
    expect(startWorkflow).toHaveBeenCalledWith(
      env.PROJECT_DELETE,
      'delete-p2',
      { projectIds: ['p2'], organizationIds: [] },
      logger,
    );
  });

  it('runs a job id once per batch', async () => {
    const first = message(job('cohortCompute', 'cohortCompute', { cohortId: 'c1' }, 'cohort-c1'));
    const second = message(job('cohortCompute', 'cohortCompute', { cohortId: 'c1' }, 'cohort-c1'));
    await consumeJobs([first, second], env, logger);
    expect(cohortComputeJob).toHaveBeenCalledTimes(1);
    expect(first.ack).toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalled();
  });

  it('retries a failed job with exponential backoff', async () => {
    cohortComputeJob.mockRejectedValue(new Error('database is down'));
    const firstAttempt = message(job('cohortCompute', 'cohortCompute', { cohortId: 'c1' }), 1);
    const thirdAttempt = message(job('cohortCompute', 'cohortCompute', { cohortId: 'c2' }), 3);
    const lateAttempt = message(job('cohortCompute', 'cohortCompute', { cohortId: 'c3' }), 9);
    await consumeJobs([firstAttempt, thirdAttempt, lateAttempt], env, logger);
    expect(firstAttempt.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(thirdAttempt.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(lateAttempt.retry).toHaveBeenCalledWith({ delaySeconds: 900 });
    expect(firstAttempt.ack).not.toHaveBeenCalled();
  });

  it('drops jobs of features compiled out on Cloudflare', async () => {
    sendNotificationJob.mockRejectedValue(new FeatureUnavailableError('integrations'));
    const slack = message(job('notification', 'sendNotification', {
      type: 'sendNotification',
      payload: { notification: { projectId: 'p1', integrationId: 'i1' } },
    }));
    const importer = message(job('import', 'import', { type: 'import', payload: { importId: 'x' } }));
    await consumeJobs([slack, importer], env, logger);
    expect(slack.ack).toHaveBeenCalled();
    expect(importer.ack).toHaveBeenCalled();
    expect(slack.retry).not.toHaveBeenCalled();
    expect(importer.retry).not.toHaveBeenCalled();
  });

  it('acks malformed messages instead of retrying them forever', async () => {
    const malformed = message({ hello: 'world' });
    await consumeJobs([malformed], env, logger);
    expect(malformed.ack).toHaveBeenCalled();
  });

  it('retries unknown job types (a newer producer, an older consumer)', async () => {
    const unknown = message(job('jobs', 'somethingNew', { type: 'somethingNew', payload: {} }));
    await consumeJobs([unknown], env, logger);
    expect(unknown.retry).toHaveBeenCalled();
  });
});
