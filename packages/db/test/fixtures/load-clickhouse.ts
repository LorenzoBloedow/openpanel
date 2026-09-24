/**
 * Porting aid (removed with ClickHouse): loads the dataset into the local
 * ClickHouse the golden capture runs the original services against.
 */
import { ch } from '../../src/clickhouse/client';
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
  'dau_mv',
  'distinct_event_names_mv',
  'event_property_values_mv',
  'cohort_events_mv',
  'event_profile_summary_mv',
  'event_property_profile_summary_mv',
];

async function insert(table: string, values: unknown[]) {
  if (values.length === 0) {
    return;
  }
  await ch.insert({ table, values, format: 'JSONEachRow' });
}

export async function loadDatasetIntoClickhouse(dataset: Dataset): Promise<void> {
  for (const table of PROJECT_TABLES) {
    // A mutation (not a lightweight DELETE) so it also works on the
    // materialized views' storage.
    await ch.command({
      query: `ALTER TABLE ${table} DELETE WHERE project_id = {projectId:String}`,
      query_params: { projectId: dataset.projectId },
      clickhouse_settings: { mutations_sync: '2' },
    });
  }

  await insert('events', dataset.events);
  await insert('sessions', dataset.sessions);
  await insert('profiles', dataset.profiles);
  await insert(
    'groups',
    dataset.groups.map((group) => ({ ...group, deleted: 0 })),
  );
  await insert('events_bots', dataset.bots);
  await insert('session_replay_chunks', dataset.replayChunks);
  await insert('gsc_daily', dataset.gscDaily);
  await insert('gsc_pages_daily', dataset.gscPages);
  await insert('gsc_queries_daily', dataset.gscQueries);
  await insert('cohort_members', dataset.cohortMembers);
}
