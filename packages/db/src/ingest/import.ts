import { toDots } from '@openpanel/common';
import { splitEvery } from 'ramda';

import { anTransaction } from '../analytics/client';
import { type EventWriteRow, insertEvents, toUtcIso } from '../analytics/writers';
import { writeRollups } from './consumer';
import { stripNulChars } from './envelope';

const IMPORT_CHUNK_SIZE = 1000;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An event row as /import/events receives it (the ClickHouse row shape). */
export type ImportedEvent = Partial<Omit<EventWriteRow, 'properties'>> & {
  name: string;
  created_at: string;
  properties?: Record<string, unknown>;
};

/**
 * Bulk import of historical events (POST /import/events). Rows keep their
 * ids when they have valid ones, so re-sending a file doesn't duplicate it.
 * Each chunk is one transaction: the rows and the rollups they add.
 */
export async function importEvents(
  projectId: string,
  events: ImportedEvent[],
  mintId: () => string,
): Promise<number> {
  const importedAt = new Date().toISOString();
  const rows: EventWriteRow[] = stripNulChars(events).map((event) => ({
    ...event,
    id: event.id && UUID_REGEX.test(event.id) ? event.id : mintId(),
    device_id: event.device_id ?? '',
    profile_id: event.profile_id ?? '',
    session_id: event.session_id ?? '',
    project_id: projectId,
    properties: toDots(event.properties ?? {}),
    created_at: toUtcIso(event.created_at) ?? importedAt,
    imported_at: importedAt,
  }));

  let inserted = 0;
  for (const chunk of splitEvery(IMPORT_CHUNK_SIZE, rows)) {
    await anTransaction(async (client) => {
      const ids = new Set(await insertEvents(chunk, client));
      inserted += ids.size;
      await writeRollups(
        client,
        chunk.filter((row) => ids.has(row.id)),
      );
    });
  }
  return inserted;
}
