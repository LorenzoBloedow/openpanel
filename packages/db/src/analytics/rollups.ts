import { type Queryable, anQuery } from './client';
import { sql } from './sql';

/**
 * Property keys never offered for discovery (event_property_values_mv
 * excluded them too).
 */
export const HIDDEN_PROPERTY_KEYS = ['__duration_from', '__properties_from'];

/**
 * Recompute a project's rollups from its events: after loading fixtures, a
 * restore or a backfill. The ingest consumer maintains them incrementally.
 */
export async function rebuildRollups(
  projectId: string,
  client?: Queryable,
): Promise<void> {
  const statements = [
    sql`DELETE FROM analytics.dau WHERE project_id = ${projectId}`,
    sql`DELETE FROM analytics.profile_event_days WHERE project_id = ${projectId}`,
    sql`DELETE FROM analytics.event_names WHERE project_id = ${projectId}`,
    sql`DELETE FROM analytics.event_property_keys WHERE project_id = ${projectId}`,
    sql`
      INSERT INTO analytics.dau (project_id, day, profile_id)
      SELECT DISTINCT project_id, (created_at AT TIME ZONE 'UTC')::date, profile_id
      FROM analytics.events
      WHERE project_id = ${projectId} AND profile_id <> ''
    `,
    sql`
      INSERT INTO analytics.profile_event_days (project_id, name, day, profile_id)
      SELECT DISTINCT project_id, name, (created_at AT TIME ZONE 'UTC')::date, profile_id
      FROM analytics.events
      WHERE project_id = ${projectId} AND profile_id <> '' AND profile_id <> device_id
    `,
    sql`
      INSERT INTO analytics.event_names (project_id, name, event_count, first_seen_at, last_seen_at)
      SELECT project_id, name, count(*), min(created_at), max(created_at)
      FROM analytics.events
      WHERE project_id = ${projectId}
      GROUP BY project_id, name
    `,
    sql`
      INSERT INTO analytics.event_property_keys (project_id, name, property_key, last_seen_at)
      SELECT e.project_id, e.name, p.key, max(e.created_at)
      FROM analytics.events e
      CROSS JOIN LATERAL jsonb_each_text(e.properties) AS p(key, value)
      WHERE e.project_id = ${projectId}
        AND p.key <> ''
        AND p.value <> ''
        AND p.key <> ALL(${HIDDEN_PROPERTY_KEYS}::text[])
      GROUP BY e.project_id, e.name, p.key
    `,
  ];
  for (const statement of statements) {
    await anQuery(statement, undefined, client);
  }
}
