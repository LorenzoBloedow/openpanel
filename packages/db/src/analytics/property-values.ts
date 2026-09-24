import { anQuery } from './client';
import { HIDDEN_PROPERTY_KEYS } from './rollups';
import { empty, sql } from './sql';

export interface RecentPropertyValuesInput {
  projectId: string;
  /** Only events with this name; every event when omitted. */
  eventName?: string;
  /** The flattened property key, e.g. `__query.utm_source`. */
  key: string;
  /** Events before this instant are not read. */
  since: Date;
  /** Read at most this many of the newest events that carry the key. */
  scanLimit: number;
  /** Return at most this many values. */
  limit: number;
}

/**
 * The distinct non-empty values of an event property, most recently seen
 * first (the value breaks ties) — what event_property_values_mv answered.
 * There is no values rollup: the values come from the newest events that
 * carry the key, at most `scanLimit` of them and none before `since`, so the
 * index scan stays bounded whatever the project's volume. Keys hidden from
 * discovery have no values.
 */
export async function recentPropertyValues(
  input: RecentPropertyValuesInput,
): Promise<string[]> {
  if (input.key === '' || HIDDEN_PROPERTY_KEYS.includes(input.key)) {
    return [];
  }
  const rows = await anQuery<{ value: string }>(sql`
    SELECT e.value
    FROM (
      SELECT properties ->> ${input.key}::text AS value, created_at
      FROM analytics.events
      WHERE project_id = ${input.projectId}
        ${input.eventName === undefined ? empty : sql`AND name = ${input.eventName}::text`}
        AND created_at >= ${input.since.toISOString()}::timestamptz
        AND properties ->> ${input.key}::text <> ''
      ORDER BY created_at DESC
      LIMIT ${input.scanLimit}
    ) AS e
    GROUP BY e.value
    ORDER BY max(e.created_at) DESC, e.value COLLATE "C"
    LIMIT ${input.limit}
  `);
  return rows.map((row) => row.value);
}
