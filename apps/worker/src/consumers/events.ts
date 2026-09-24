import {
  type ApplyEnvelopesResult,
  applyEnvelopes,
} from '@openpanel/db/src/ingest/consumer';
import {
  getNotificationRuleKinds,
  isExcludedByProjectFilter,
  markFirstEvent,
} from '@openpanel/db/src/ingest/effects';
import {
  type EventsEnvelope,
  serializeEventPayload,
  zEventsEnvelope,
} from '@openpanel/db/src/ingest/envelope';
import type { ILogger } from '@openpanel/logger';
import { getLiveHub } from '@openpanel/queue/src/live';
import { notificationQueue } from '@openpanel/queue/src/queues';

import type { QueueMessage } from './message';

/**
 * The op-events consumer. A batch is applied in ONE Postgres transaction
 * (ledger, row locks, session state machine, bulk writes). If the batch
 * fails, each message is retried in its own transaction so one poison
 * message can't hold back the rest; it goes to the DLQ after max_retries.
 * Side effects run after the commit and never fail the batch: the ledger
 * already makes a redelivery a no-op, so a retry would only lose them.
 */

/** Keep job messages well under the 128 KB queue limit. */
const MAX_JOB_MESSAGE_BYTES = 96 * 1024;

function retryDelaySeconds(attempts: number) {
  return Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
}

export async function consumeEvents(
  messages: readonly QueueMessage[],
  env: Env,
  logger: ILogger,
): Promise<void> {
  const accepted: { message: QueueMessage; envelope: EventsEnvelope }[] = [];
  for (const message of messages) {
    const parsed = zEventsEnvelope.safeParse(message.body);
    if (parsed.success) {
      accepted.push({ message, envelope: parsed.data });
      continue;
    }
    // Most likely a newer API during a deploy (the worker deploys first).
    // Retrying lets a fixed consumer pick it up; the DLQ keeps the rest.
    logger.error(
      {
        messageId: message.id,
        attempts: message.attempts,
        issues: parsed.error.issues.slice(0, 5),
      },
      'Invalid events envelope',
    );
    message.retry({ delaySeconds: 60 });
  }
  if (accepted.length === 0) {
    return;
  }

  const options = { isExcluded: isExcludedByProjectFilter };
  try {
    const result = await applyEnvelopes(
      accepted.map((item) => item.envelope),
      options,
    );
    for (const { message } of accepted) {
      message.ack();
    }
    await afterCommit(env, result, logger);
    return;
  } catch (error) {
    if (accepted.length === 1) {
      logger.error(
        { err: error, messageId: accepted[0]!.message.id },
        'Events message failed',
      );
      accepted[0]!.message.retry({
        delaySeconds: retryDelaySeconds(accepted[0]!.message.attempts),
      });
      return;
    }
    logger.warn(
      { err: error, size: accepted.length },
      'Events batch failed; applying messages one by one',
    );
  }

  for (const { message, envelope } of accepted) {
    let result: ApplyEnvelopesResult;
    try {
      result = await applyEnvelopes([envelope], options);
    } catch (error) {
      logger.error(
        { err: error, messageId: message.id, attempts: message.attempts },
        'Events message failed',
      );
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    message.ack();
    await afterCommit(env, result, logger);
  }
}

/** Split serialized items into messages under the queue's size limit. */
function chunkBySize<T>(items: T[], maxBytes: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = JSON.stringify(item).length;
    if (current.length > 0 && size + itemSize > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export async function afterCommit(
  env: Env,
  result: Pick<ApplyEnvelopesResult, 'insertedEvents' | 'closedSessions'>,
  logger: ILogger,
): Promise<void> {
  const byProject = new Map<string, ApplyEnvelopesResult['insertedEvents']>();
  for (const event of result.insertedEvents) {
    const list = byProject.get(event.payload.projectId) ?? [];
    list.push(event);
    byProject.set(event.payload.projectId, list);
  }
  const closedByProject = new Map<string, string[]>();
  for (const session of result.closedSessions) {
    const list = closedByProject.get(session.project_id) ?? [];
    list.push(session.id);
    closedByProject.set(session.project_id, list);
  }

  const tasks: Promise<unknown>[] = [];
  for (const [projectId, events] of byProject) {
    tasks.push(
      getLiveHub(env.LIVE_HUB, 'project', projectId).publish({
        type: 'events',
        projectId,
        count: events.length,
      }),
      markFirstEvent(projectId),
    );
  }

  const projects = new Set([...byProject.keys(), ...closedByProject.keys()]);
  for (const projectId of projects) {
    tasks.push(
      (async () => {
        const rules = await getNotificationRuleKinds(projectId);
        if (rules?.events) {
          const events = (byProject.get(projectId) ?? [])
            .filter((event) => event.payload.name !== 'session_end')
            .map(({ payload }) => ({
              ...serializeEventPayload(payload),
              id: payload.id,
            }));
          for (const chunk of chunkBySize(events, MAX_JOB_MESSAGE_BYTES)) {
            await notificationQueue.add('checkEventRules', {
              type: 'checkEventRules',
              payload: { projectId, events: chunk },
            });
          }
        }
        const sessionIds = closedByProject.get(projectId) ?? [];
        if (rules?.funnel && sessionIds.length > 0) {
          await notificationQueue.add('checkFunnelRules', {
            type: 'checkFunnelRules',
            payload: { projectId, sessionIds },
          });
        }
      })(),
    );
  }

  const results = await Promise.allSettled(tasks);
  for (const settled of results) {
    if (settled.status === 'rejected') {
      logger.error({ err: settled.reason }, 'Ingest side effect failed');
    }
  }
}
