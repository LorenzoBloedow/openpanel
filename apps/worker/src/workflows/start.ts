import type { ILogger } from '@openpanel/logger';

const IN_PROGRESS = new Set(['queued', 'running', 'waiting', 'paused']);

/**
 * Start a Workflow instance under a stable id so a duplicate trigger (a
 * redelivered job, a cron that fired twice) doesn't start a second copy
 * while one is in progress. A finished instance's id gets a suffix.
 */
export async function startWorkflow<Params>(
  workflow: Workflow<Params>,
  baseId: string,
  params: Params,
  logger: ILogger,
): Promise<string> {
  const id = baseId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  let existing: WorkflowInstance | undefined;
  try {
    existing = await workflow.get(id);
  } catch {
    existing = undefined;
  }
  if (!existing) {
    await workflow.create({ id, params });
    return id;
  }
  const { status } = await existing.status();
  if (IN_PROGRESS.has(status)) {
    logger.info({ id, status }, 'Workflow already in progress');
    return id;
  }
  const retryId = `${id.slice(0, 50)}-${Date.now().toString(36)}`;
  await workflow.create({ id: retryId, params });
  return retryId;
}
