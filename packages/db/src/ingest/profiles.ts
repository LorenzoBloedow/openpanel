import { anQueryOne } from '../analytics/client';
import { sql } from '../analytics/sql';

/**
 * A profile's stored properties, or null when the profile doesn't exist.
 * The API validates increments/decrements with it before queuing them.
 */
export async function getProfileProperties(
  projectId: string,
  profileId: string,
): Promise<Record<string, unknown> | null> {
  const row = await anQueryOne<{ properties: Record<string, unknown> }>(sql`
    SELECT properties FROM analytics.profiles
    WHERE project_id = ${projectId} AND id = ${profileId}
  `);
  return row?.properties ?? null;
}
