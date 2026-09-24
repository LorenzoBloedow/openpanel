import { anQueryOne } from '../analytics/client';
import { sql } from '../analytics/sql';

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Distinct visitors of the last five minutes — the realtime counter of the
 * overview, widgets and the public insights API. (The LiveHub computes the
 * same number for the visitors WebSocket.)
 */
export async function getActiveVisitorCount(projectId: string): Promise<number> {
  const row = await anQueryOne<{ count: number }>(sql`
    SELECT COUNT(DISTINCT profile_id)::int AS count
    FROM analytics.events
    WHERE project_id = ${projectId}
      AND profile_id <> ''
      AND created_at >= ${new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString()}::timestamptz
  `);
  return row?.count ?? 0;
}
