import {
  EnvelopeTooLargeError,
  type IngestRecord,
  buildEnvelope,
} from '@openpanel/db/src/ingest/envelope';

import { HttpError } from '@/utils/errors';

/**
 * Put one request's records on the op-events queue as a single envelope.
 * The consumer applies it in one transaction; ids minted here make a
 * redelivery a no-op.
 */
export async function enqueueRecords(
  queue: Queue,
  projectId: string,
  records: IngestRecord[],
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  try {
    const envelope = buildEnvelope(projectId, records);
    await queue.send(envelope, { contentType: 'json' });
  } catch (error) {
    if (error instanceof EnvelopeTooLargeError) {
      throw new HttpError(error.message, {
        status: 413,
        error: 'Payload Too Large',
      });
    }
    throw error;
  }
}
