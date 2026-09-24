import { anQuery } from '../../src/analytics/client';
import { rebuildRollups } from '../../src/analytics/rollups';
import { sql } from '../../src/analytics/sql';
import {
  insertBotEvents,
  insertCohortMembers,
  insertEvents,
  insertReplayChunk,
  upsertGroups,
  upsertGscRows,
  upsertProfiles,
  upsertSessions,
} from '../../src/analytics/writers';
import type { Dataset } from './analytics-dataset';

const PROJECT_TABLES = [
  'events',
  'sessions',
  'profiles',
  'groups',
  'events_bots',
  'session_replay_chunks',
  'gsc_daily',
  'gsc_pages_daily',
  'gsc_queries_daily',
  'cohort_members',
  'cohort_metadata',
  'live_sessions',
] as const;

/** Replace a project's analytics data with the dataset (Node, fallback scope). */
export async function loadDatasetIntoPostgres(dataset: Dataset): Promise<void> {
  for (const table of PROJECT_TABLES) {
    await anQuery(
      `DELETE FROM analytics.${table} WHERE project_id = $1`,
      [dataset.projectId],
    );
  }

  const EVENT_CHUNK = 2000;
  for (let i = 0; i < dataset.events.length; i += EVENT_CHUNK) {
    await insertEvents(dataset.events.slice(i, i + EVENT_CHUNK));
  }
  await upsertSessions(dataset.sessions);
  await upsertProfiles(dataset.profiles);
  await upsertGroups(dataset.groups);
  await insertBotEvents(dataset.bots);
  for (const chunk of dataset.replayChunks) {
    await insertReplayChunk(chunk);
  }
  await upsertGscRows('gsc_daily', dataset.gscDaily);
  await upsertGscRows('gsc_pages_daily', dataset.gscPages);
  await upsertGscRows('gsc_queries_daily', dataset.gscQueries);
  await insertCohortMembers(dataset.cohortMembers);
  await rebuildRollups(dataset.projectId);
}

/** Row counts per table for a project, for sanity checks. */
export async function countProjectRows(projectId: string) {
  const [row] = await anQuery<Record<string, number>>(sql`
    SELECT
      (SELECT count(*) FROM analytics.events WHERE project_id = ${projectId}) AS events,
      (SELECT count(*) FROM analytics.sessions WHERE project_id = ${projectId}) AS sessions,
      (SELECT count(*) FROM analytics.profiles WHERE project_id = ${projectId}) AS profiles,
      (SELECT count(*) FROM analytics.dau WHERE project_id = ${projectId}) AS dau,
      (SELECT count(*) FROM analytics.event_names WHERE project_id = ${projectId}) AS event_names
  `);
  return row!;
}
