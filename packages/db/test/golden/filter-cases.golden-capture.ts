/**
 * Porting aid (removed with ClickHouse): checks the expected matches in
 * test/fixtures/filter-cases.ts against the ClickHouse filter builders
 * (getEventFiltersWhereClause / buildFilterWhere), the way the golden
 * capture records the services. Runs with the golden capture config, in a
 * throwaway database whose tables copy the schema of CLICKHOUSE_URL's
 * database (see setup-clickhouse.ts); the golden data is not touched.
 *
 *   pnpm vitest run --config vitest.golden.config.ts test/golden/filter-cases.golden-capture.ts
 */
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import type { IChartEventFilter } from '@openpanel/validation';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { getEventFiltersWhereClause } from '../../src/services/chart.service';
import {
  buildFilterWhere,
  profileJoinColumns,
} from '../../src/services/filter-where.service';
import {
  EVENT_FILTER_CASES,
  FILTER_COHORT_MEMBERS,
  FILTER_DATE_SCOPE,
  FILTER_EVENTS,
  FILTER_GROUPS,
  FILTER_PROFILES,
  FILTER_PROJECT,
  FILTER_SESSIONS,
  FILTER_TIMEZONE,
  PREFIXED_FILTER_CASES,
  shortEventId,
} from '../fixtures/filter-cases';

const source = new URL(process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123/openpanel');
const SOURCE_DB = source.pathname.replace(/^\//, '') || 'default';
const CHECK_DB = `filter_cases_${process.pid}`;
const TABLES = ['events', 'profiles', 'groups', 'sessions', 'cohort_members'];
const P = FILTER_PROJECT;

const client = (database: string) =>
  createClient({ url: source.origin, database, log: { level: ClickHouseLogLevel.OFF } });
const admin = client(SOURCE_DB);
const check = client(CHECK_DB);

beforeAll(async () => {
  await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${CHECK_DB}` });
  for (const table of TABLES) {
    await admin.command({ query: `CREATE TABLE ${CHECK_DB}.${table} AS ${SOURCE_DB}.${table}` });
  }
  const insert = (table: string, values: unknown[]) =>
    check.insert({ table, values, format: 'JSONEachRow' });
  await insert('events', FILTER_EVENTS.map((row) => ({ ...row, inserted_at: row.created_at })));
  await insert('profiles', FILTER_PROFILES);
  await insert('groups', FILTER_GROUPS.map((row) => ({ ...row, deleted: 0 })));
  await insert('sessions', FILTER_SESSIONS);
  await insert('cohort_members', FILTER_COHORT_MEMBERS);
});

afterAll(async () => {
  await admin.command({ query: `DROP DATABASE IF EXISTS ${CHECK_DB}` });
  await Promise.all([admin.close(), check.close()]);
});

async function ids(query: string): Promise<string[] | string> {
  try {
    const result = await check.query({
      query,
      format: 'JSONEachRow',
      clickhouse_settings: { session_timezone: FILTER_TIMEZONE },
    });
    const rows = (await result.json()) as { id: string }[];
    return [...new Set(rows.map((row) => String(row.id)))].sort();
  } catch (error) {
    return `ERROR: ${(error as Error).message.split('\n')[0]}`;
  }
}

/** The joins getEventList added for profile.* and group.* filters. */
function eventQuery(filter: IChartEventFilter) {
  const where = Object.values(getEventFiltersWhereClause([filter], P, 'e'));
  const joins: string[] = [];
  if (filter.name.startsWith('profile.')) {
    const columns = profileJoinColumns([filter.name.replace('profile.', '')]).join(', ');
    joins.push(
      `LEFT ANY JOIN (SELECT ${columns} FROM profiles FINAL WHERE project_id = '${P}') as profile on profile.id = profile_id`,
    );
  }
  if (filter.name.startsWith('group.')) {
    joins.push('ARRAY JOIN groups AS _group_id');
    joins.push(
      `LEFT ANY JOIN (SELECT id, name, type, properties FROM groups FINAL WHERE project_id = '${P}') AS _g ON _g.id = _group_id`,
    );
  }
  const whereSql = [`project_id = '${P}'`, ...where].map((clause) => `(${clause})`).join(' AND ');
  return `SELECT e.id AS id FROM events e ${joins.join(' ')} WHERE ${whereSql}`;
}

const SELF_TABLES = {
  events: { from: 'events', profileId: 'profile_id' },
  sessions: { from: 'sessions', profileId: 'profile_id' },
  profiles: { from: 'profiles FINAL', profileId: 'id' },
} as const;

const describe = (filter: IChartEventFilter) =>
  `${filter.name} ${filter.operator}${filter.type ? `:${filter.type}` : ''} ${JSON.stringify(filter.value)}`;

it('filter-cases expectations are what ClickHouse returned', async () => {
  const differences: string[] = [];
  for (const { filter, expected } of EVENT_FILTER_CASES) {
    const actual = await ids(eventQuery(filter));
    const short = typeof actual === 'string' ? actual : actual.map(shortEventId);
    if (JSON.stringify(short) !== JSON.stringify(expected)) {
      differences.push(`events ${describe(filter)}: ClickHouse ${JSON.stringify(short)}`);
    }
  }
  for (const { table, filter, expected } of PREFIXED_FILTER_CASES) {
    const self = SELF_TABLES[table];
    const where = Object.values(
      buildFilterWhere([filter], P, {
        selfTable: table,
        profileIdExpr: self.profileId,
        groupsExpr: 'groups',
        ...FILTER_DATE_SCOPE,
      }),
    );
    const actual = await ids(
      `SELECT id FROM ${self.from} WHERE ${[`project_id = '${P}'`, ...where].join(' AND ')}`,
    );
    const short =
      typeof actual === 'string' ? actual : table === 'events' ? actual.map(shortEventId) : actual;
    if (JSON.stringify(short) !== JSON.stringify(expected)) {
      differences.push(`${table} ${describe(filter)}: ClickHouse ${JSON.stringify(short)}`);
    }
  }
  expect(differences).toEqual([]);
}, 600_000);
