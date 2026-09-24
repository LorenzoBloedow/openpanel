import type { ILogger } from '@openpanel/logger';

import type { QueueMessage } from './message';

/**
 * The op-jobs consumer. Job handlers are ported in Phase 7; until then
 * messages are retried (and end up in the DLQ) rather than dropped.
 */
export async function consumeJobs(
  messages: readonly QueueMessage[],
  _env: Env,
  logger: ILogger,
): Promise<void> {
  for (const message of messages) {
    logger.warn(
      { messageId: message.id, body: message.body },
      'No handler for job yet',
    );
    message.retry({ delaySeconds: 300 });
  }
}
