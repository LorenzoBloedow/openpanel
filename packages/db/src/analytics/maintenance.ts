import { anQuery } from './client';
import { ident, sql } from './sql';

/**
 * Housekeeping for the analytics schema: project deletion in chunks (the
 * ProjectDelete workflow) and the retention sweeps the maintenance crons
 * run. Deletes go in bounded batches so no single statement holds locks on
 * a large slice of a table (or runs into a pooler's statement timeout).
 */

/** Every analytics table keyed by project. */
export const PROJECT_ANALYTICS_TABLES = [
  'live_sessions',
  'events',
  'sessions',
  'profiles',
  'groups',
  'events_bots',
  'session_replay_chunks',
  'dau',
  'profile_event_days',
  'event_names',
  'event_property_keys',
  'cohort_members',
  'cohort_metadata',
  'gsc_daily',
  'gsc_pages_daily',
  'gsc_queries_daily',
] as const;

export type ProjectAnalyticsTable = (typeof PROJECT_ANALYTICS_TABLES)[number];

const DEFAULT_DELETE_BATCH = 50_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete up to `limit` rows of the projects from one table. Returns how many
 * went; the caller repeats until a short batch.
 */
export async function deleteProjectAnalyticsChunk(
  table: ProjectAnalyticsTable,
  projectIds: string[],
  limit = DEFAULT_DELETE_BATCH,
): Promise<number> {
  if (!PROJECT_ANALYTICS_TABLES.includes(table)) {
    throw new Error(`Not a project analytics table: ${table}`);
  }
  const target = ident('analytics', table);
  const rows = await anQuery<{ n: number }>(sql`
    WITH doomed AS (
      SELECT ctid FROM ${target}
      WHERE project_id = ANY(${projectIds}::text[])
      LIMIT ${limit}
    ), deleted AS (
      DELETE FROM ${target} t USING doomed
      WHERE t.ctid = doomed.ctid
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM deleted
  `);
  return rows[0]?.n ?? 0;
}

async function deleteInBatches(
  run: (limit: number) => Promise<number>,
  limit = DEFAULT_DELETE_BATCH,
  maxBatches = 200,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const deleted = await run(limit);
    total += deleted;
    if (deleted < limit) {
      break;
    }
  }
  return total;
}

async function deleteOlderThan(
  table: string,
  column: string,
  cutoff: Date,
  limit?: number,
): Promise<number> {
  const target = ident('analytics', table);
  const at = ident(column);
  return deleteInBatches(async (batch) => {
    const rows = await anQuery<{ n: number }>(sql`
      WITH doomed AS (
        SELECT ctid FROM ${target} WHERE ${at} < ${cutoff.toISOString()}::timestamptz LIMIT ${batch}
      ), deleted AS (
        DELETE FROM ${target} t USING doomed WHERE t.ctid = doomed.ctid RETURNING 1
      )
      SELECT count(*)::int AS n FROM deleted
    `);
    return rows[0]?.n ?? 0;
  }, limit);
}

/** Dedupe claims expire after 100 ms; sweep the leftovers. */
export function cleanupRequestDedupe(now = new Date()) {
  return deleteOlderThan('request_dedupe', 'expires_at', now);
}

/**
 * The exactly-once ledger only has to outlive queue redelivery (retries
 * span minutes; a week is generous).
 */
export function cleanupIngestLedger(now = new Date(), days = 7) {
  return deleteOlderThan('ingest_ledger', 'received_at', new Date(now.getTime() - days * DAY_MS));
}

/** Session replays are kept for 30 days, as before. */
export function cleanupReplayChunks(now = new Date(), days = 30) {
  return deleteOlderThan(
    'session_replay_chunks',
    'started_at',
    new Date(now.getTime() - days * DAY_MS),
  );
}

/** Optional event retention (EVENTS_RETENTION_DAYS). Off by default. */
export function cleanupEventsOlderThan(days: number, now = new Date()) {
  return deleteOlderThan('events', 'created_at', new Date(now.getTime() - days * DAY_MS));
}

/**
 * Refresh projects.eventsCount (the dashboard's project cards and the
 * onboarding checklist) from the event_names rollup, for every project at
 * once. Only rows whose count changed are written.
 */
export async function refreshProjectEventCounts(): Promise<number> {
  const rows = await anQuery<{ n: number }>(sql`
    WITH counts AS (
      SELECT project_id, LEAST(sum(event_count), 2147483647)::int AS count
      FROM analytics.event_names
      WHERE name NOT IN ('session_start', 'session_end')
      GROUP BY project_id
    ), updated AS (
      UPDATE public.projects p SET "eventsCount" = counts.count
      FROM counts
      WHERE p.id = counts.project_id
        AND p."eventsCount" IS DISTINCT FROM counts.count
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM updated
  `);
  return rows[0]?.n ?? 0;
}
