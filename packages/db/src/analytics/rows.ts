import { type Sql, join, raw } from './sql';

/**
 * Select lists that return the rows ClickHouse's `SELECT *` did, for the
 * services that hand raw rows to their callers (IClickhouseEvent,
 * IClickhouseSession, IClickhouseProfile): the same columns, none of the
 * Postgres-only ones (`events.seq`), and the constant `sign` sessions had.
 */

function columns(alias: string | undefined, names: readonly string[]): Sql {
  const prefix = alias ? `${alias}.` : '';
  return join(names.map((name) => raw(`${prefix}${name}`)));
}

export const EVENT_ROW_COLUMNS = [
  'id',
  'name',
  'sdk_name',
  'sdk_version',
  'device_id',
  'profile_id',
  'project_id',
  'session_id',
  'path',
  'origin',
  'referrer',
  'referrer_name',
  'referrer_type',
  'duration',
  'properties',
  'created_at',
  'country',
  'city',
  'region',
  'longitude',
  'latitude',
  'os',
  'os_version',
  'browser',
  'browser_version',
  'device',
  'brand',
  'model',
  'imported_at',
  'inserted_at',
  'revenue',
  'groups',
] as const;

export const SESSION_ROW_COLUMNS = [
  'id',
  'project_id',
  'profile_id',
  'device_id',
  'groups',
  'created_at',
  'ended_at',
  'is_bounce',
  'entry_origin',
  'entry_path',
  'exit_origin',
  'exit_path',
  'screen_view_count',
  'revenue',
  'event_count',
  'duration',
  'country',
  'region',
  'city',
  'longitude',
  'latitude',
  'device',
  'brand',
  'model',
  'browser',
  'browser_version',
  'os',
  'os_version',
  'utm_medium',
  'utm_source',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'referrer',
  'referrer_name',
  'referrer_type',
  'version',
] as const;

export const PROFILE_ROW_COLUMNS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'avatar',
  'properties',
  'project_id',
  'is_external',
  'created_at',
  'last_seen_at',
  'groups',
] as const;

/** An events row (IClickhouseEvent). */
export function eventRow(alias?: string): Sql {
  return columns(alias, EVENT_ROW_COLUMNS);
}

/** A sessions row (IClickhouseSession), with `sign` = 1. */
export function sessionRow(alias?: string): Sql {
  return join([columns(alias, SESSION_ROW_COLUMNS), raw('1 AS sign')]);
}

/** A profiles row (IClickhouseProfile, PROFILE_COLUMNS). */
export function profileRow(alias?: string): Sql {
  return columns(alias, PROFILE_ROW_COLUMNS);
}
