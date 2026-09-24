import { toObject } from '@openpanel/common';
import { cacheable } from '@openpanel/redis';
import type { IChartEventFilter } from '@openpanel/validation';
import { uniq } from 'ramda';
import sqlstring from 'sqlstring';
import { anQuery, anQueryOne } from '../analytics/client';
import {
  convertClickhouseDateToJs,
  toNullIfDefaultMinDate,
} from '../analytics/dates';
import { prefixedFilterClauses } from '../analytics/filters';
import { eventRow, profileRow, sessionRow } from '../analytics/rows';
import { type Sql, and, empty, or, raw, sql } from '../analytics/sql';
import type { IClickhouseEvent } from './event.service';
import type { IClickhouseSession } from './session.service';

/** The list queries of this service ran in UTC (ClickHouse `clix(ch)`). */
const UTC = { timezone: 'UTC' } as const;

const DAY_MS = 86_400_000;

export interface IProfileMetrics {
  lastSeen: Date | null;
  firstSeen: Date | null;
  screenViews: number;
  sessions: number;
  durationAvg: number;
  durationP90: number;
  totalEvents: number;
  uniqueDaysActive: number;
  bounceRate: number;
  avgEventsPerSession: number;
  conversionEvents: number;
  avgTimeBetweenSessions: number;
  revenue: number;
}

/**
 * ClickHouse `round(x, digits)` on a Float64: `nearbyint(x * 10^digits) /
 * 10^digits`, ties to even — which is what Postgres' `round(float8)` does.
 */
function roundTo(value: Sql, digits: number): Sql {
  const scale = raw(String(10 ** digits));
  return sql`(round((${value}) * ${scale}) / ${scale})`;
}

/**
 * SQL for the profile metrics panel: one point-read of the profile row
 * (first/last seen) plus ONE conditional-aggregate scan of the profile's
 * events. Exported for SQL-shape tests.
 *
 * Reproduces the ClickHouse arithmetic: Float64 averages, round() ties to
 * even, quantileExactInclusive(0.9) (R-7) for the p90, and
 * dateDiff('second') (whole-second boundaries) between first and last seen.
 * `bounceRate` compares `__bounce` with '1' while sessions store
 * 'true'/'false', so it is 0 whenever there are session_end events — as it
 * always was.
 */
export function buildProfileMetricsSql(profileId: string, projectId: string): Sql {
  const durations = raw('stats.session_durations');
  const size = sql`cardinality(${durations})`;
  // quantileExactInclusive: h = level * (n - 1) + 1, interpolate between
  // the h-th and the next value.
  const p90 = sql`(SELECT CASE
      WHEN q.k >= ${size} THEN ${durations}[${size}]::double precision
      ELSE ${durations}[q.k]::double precision + (q.h - q.k) * (${durations}[q.k + 1] - ${durations}[q.k])::double precision
    END
    FROM (SELECT h, floor(h)::integer AS k FROM (SELECT 0.9::double precision * (${size} - 1) + 1 AS h) AS l) AS q)`;
  const secondsBetween = sql`COALESCE(
      floor(extract(epoch from (SELECT last_seen FROM profile_seen)))
        - floor(extract(epoch from (SELECT first_seen FROM profile_seen))),
      0
    )::double precision`;

  return sql`
    WITH profile_seen AS (
      SELECT created_at AS first_seen, last_seen_at AS last_seen
      FROM analytics.profiles
      WHERE project_id = ${projectId} AND id = ${profileId}
      LIMIT 1
    ),
    stats AS (
      SELECT
        count(*) FILTER (WHERE name = 'screen_view') AS screen_views,
        count(*) FILTER (WHERE name = 'session_start') AS sessions,
        avg(duration::double precision) FILTER (WHERE name = 'session_end' AND duration <> 0) AS duration_avg,
        array_agg(duration ORDER BY duration) FILTER (WHERE name = 'session_end' AND duration <> 0) AS session_durations,
        count(*) AS total_events,
        count(DISTINCT (created_at AT TIME ZONE 'UTC')::date) AS unique_days_active,
        avg(CASE WHEN COALESCE(properties ->> '__bounce', '') = '1' THEN 1 ELSE 0 END::double precision) FILTER (WHERE name = 'session_end') AS bounce_avg,
        count(*) FILTER (WHERE name NOT IN ('screen_view', 'session_start', 'session_end')) AS conversion_events,
        COALESCE(sum(revenue) FILTER (WHERE name = 'revenue'), 0) AS revenue
      FROM analytics.events
      WHERE project_id = ${projectId} AND profile_id = ${profileId}
    )
    SELECT
      (SELECT last_seen FROM profile_seen) AS "lastSeen",
      (SELECT first_seen FROM profile_seen) AS "firstSeen",
      stats.screen_views AS "screenViews",
      stats.sessions AS "sessions",
      ${roundTo(sql`stats.duration_avg / 1000 / 60`, 2)} AS "durationAvg",
      ${roundTo(sql`${p90} / 1000 / 60`, 2)} AS "durationP90",
      stats.total_events AS "totalEvents",
      stats.unique_days_active AS "uniqueDaysActive",
      ${roundTo(sql`stats.bounce_avg * 100`, 4)} AS "bounceRate",
      ${roundTo(sql`stats.total_events::double precision / NULLIF(stats.sessions, 0)`, 2)} AS "avgEventsPerSession",
      stats.conversion_events AS "conversionEvents",
      CASE
        WHEN stats.sessions <= 1 THEN 0
        ELSE ${roundTo(sql`${secondsBetween} / NULLIF(stats.sessions - 1, 0)`, 1)}
      END AS "avgTimeBetweenSessions",
      stats.revenue AS "revenue"
    FROM stats
  `;
}

export async function getProfileMetrics(profileId: string, projectId: string) {
  const data = await anQueryOne<
    Omit<IProfileMetrics, 'lastSeen' | 'firstSeen'> & {
      lastSeen: string | null;
      firstSeen: string | null;
    }
  >(buildProfileMetricsSql(profileId, projectId));
  return {
    ...data!,
    lastSeen: toNullIfDefaultMinDate(data!.lastSeen),
    firstSeen: toNullIfDefaultMinDate(data!.firstSeen),
  };
}

export async function getProfileById(id: string, projectId: string) {
  if (id === '' || projectId === '') {
    return null;
  }

  const profile = await anQueryOne<IClickhouseProfile>(sql`
    SELECT ${profileRow()}
    FROM analytics.profiles
    WHERE project_id = ${projectId} AND id = ${String(id)}
    LIMIT 1
  `);

  if (!profile) {
    return null;
  }

  return transformProfile(profile);
}

interface GetProfileListOptions {
  projectId: string;
  take: number;
  cursor?: number;
  filters?: IChartEventFilter[];
  search?: string;
  isExternal?: boolean;
}

function searchTokens(search: string | null | undefined): string[] {
  return (search ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
}

/**
 * A profile search predicate that handles multi-token queries like
 * "John Smith": splits on whitespace, and every token (at most five) has to
 * match SOME profile field (id/email/first/last/full name),
 * case-insensitively. Pasting a full profile id matches on `id`. The tokens
 * are LIKE patterns as typed (`%` and `_` keep their meaning), as before.
 * Returns `null` when the search string is empty.
 */
export function profileSearchWhere(
  search: string | null | undefined,
  alias?: string,
): Sql | null {
  const tokens = searchTokens(search);
  if (tokens.length === 0) {
    return null;
  }
  const column = (name: string) => raw(alias ? `${alias}.${name}` : name);
  return and(
    tokens.map((token) => {
      const like = sql`${`%${token}%`}::text`;
      return or([
        sql`${column('id')} ILIKE ${like}`,
        sql`${column('email')} ILIKE ${like}`,
        sql`${column('first_name')} ILIKE ${like}`,
        sql`${column('last_name')} ILIKE ${like}`,
        sql`concat(${column('first_name')}, ' ', ${column('last_name')}) ILIKE ${like}`,
      ]);
    }),
  );
}

/**
 * @deprecated ClickHouse text for cohort.service.ts until it is ported; the
 * Postgres queries use {@link profileSearchWhere}.
 */
export function profileSearchSql(search: string | null | undefined): string | null {
  const tokens = searchTokens(search);
  if (tokens.length === 0) {
    return null;
  }
  const perToken = tokens.map((token) => {
    const like = sqlstring.escape(`%${token}%`);
    return `(id ILIKE ${like} OR email ILIKE ${like} OR first_name ILIKE ${like} OR last_name ILIKE ${like} OR concat(first_name, ' ', last_name) ILIKE ${like})`;
  });
  return `(${perToken.join(' AND ')})`;
}

export async function getProfiles(ids: string[], projectId: string) {
  const filteredIds = uniq(ids.filter((id) => id !== ''));

  if (filteredIds.length === 0) {
    return [];
  }

  const data = await anQuery<IClickhouseProfile>(sql`
    SELECT ${profileRow()}
    FROM analytics.profiles
    WHERE project_id = ${projectId} AND id = ANY(${filteredIds}::text[])
  `);

  return data.map(transformProfile);
}

export const getProfilesCached = cacheable(getProfiles, 60 * 5);

type ProfileListFilterOptions = Omit<GetProfileListOptions, 'cursor' | 'take'>;

/** Where clause shared by the profile list and its count, so the two agree. */
function profileListWhere({
  projectId,
  filters,
  search,
  isExternal,
}: ProfileListFilterOptions): Sql {
  return and([
    sql`project_id = ${projectId}`,
    profileSearchWhere(search),
    isExternal === undefined ? null : sql`is_external = ${raw(isExternal ? 'true' : 'false')}`,
    // Only cohort / group.* / profile.* filters apply to profiles; plain
    // `properties.*` names are event filters and are dropped.
    ...prefixedFilterClauses(filters ?? [], { ...UTC, projectId, table: 'profiles' }),
  ]);
}

export function buildProfileListSql({ take, cursor, ...options }: GetProfileListOptions): Sql {
  const offset = Math.max(0, (cursor ?? 0) * take);
  return sql`
    SELECT ${profileRow()}
    FROM analytics.profiles
    WHERE ${profileListWhere(options)}
    ORDER BY created_at DESC
    ${take ? sql`LIMIT ${take}` : empty}
    ${offset ? sql`OFFSET ${offset}` : empty}
  `;
}

export function buildProfileListCountSql(options: ProfileListFilterOptions): Sql {
  return sql`
    SELECT count(*) AS count
    FROM analytics.profiles
    WHERE ${profileListWhere(options)}
  `;
}

export async function getProfileList(options: GetProfileListOptions) {
  const data = await anQuery<IClickhouseProfile>(buildProfileListSql(options));
  return data.map(transformProfile);
}

export async function getProfileListCount(options: ProfileListFilterOptions) {
  const data = await anQuery<{ count: number }>(buildProfileListCountSql(options));
  return data[0]?.count ?? 0;
}

export interface IServiceProfile {
  id: string;
  email: string;
  avatar: string;
  firstName: string;
  lastName: string;
  /** First time this profile was seen — preserved across upserts. */
  createdAt: Date;
  /** Most recent activity. */
  lastSeenAt: Date;
  isExternal: boolean;
  projectId: string;
  groups: string[];
  properties: Record<string, unknown> & {
    region?: string;
    country?: string;
    city?: string;
    os?: string;
    os_version?: string;
    browser?: string;
    browser_version?: string;
    referrer_name?: string;
    referrer_type?: string;
    device?: string;
    brand?: string;
    model?: string;
    referrer?: string;
  };
}

export interface IClickhouseProfile {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  avatar: string;
  properties: Record<string, string | undefined>;
  project_id: string;
  is_external: boolean;
  /** First time this profile was seen — preserved across upserts. */
  created_at: string;
  /** Most recent activity. */
  last_seen_at: string;
  groups: string[];
}

export interface IServiceUpsertProfile {
  projectId: string;
  id: string | number;
  firstName?: string;
  lastName?: string;
  email?: string;
  avatar?: string;
  properties?: Record<string, unknown>;
  isExternal: boolean;
  groups?: string[];
}

export function transformProfile({
  created_at,
  last_seen_at,
  first_name,
  last_name,
  ...profile
}: IClickhouseProfile): IServiceProfile {
  const createdAtJs = convertClickhouseDateToJs(created_at);
  return {
    firstName: first_name,
    lastName: last_name,
    isExternal: profile.is_external,
    properties: toObject(profile.properties),
    createdAt: createdAtJs,
    lastSeenAt: last_seen_at
      ? convertClickhouseDateToJs(last_seen_at)
      : createdAtJs,
    projectId: profile.project_id,
    id: profile.id,
    email: profile.email,
    avatar: profile.avatar,
    groups: profile.groups ?? [],
  };
}

export const PROFILE_COLUMNS =
  'id, first_name, last_name, email, avatar, properties, project_id, is_external, created_at, last_seen_at, groups';

export interface FindProfilesInput {
  projectId: string;
  name?: string;
  email?: string;
  country?: string;
  city?: string;
  device?: string;
  browser?: string;
  inactiveDays?: number;
  minSessions?: number;
  performedEvent?: string;
  filters?: IChartEventFilter[];
  sortBy?: 'created_at';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
}

/** `now()` of the database, at the JS clock (second precision, like ClickHouse). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

export function findProfilesCore(
  input: FindProfilesInput,
): Promise<IClickhouseProfile[]> {
  const pid = input.projectId;
  const property = (key: string, value: string) =>
    sql`COALESCE(properties ->> ${key}::text, '') = ${value}::text`;
  const conditions: (Sql | null)[] = [sql`project_id = ${pid}`];

  if (input.email) {
    conditions.push(sql`email ILIKE ${`%${input.email}%`}::text`);
  }
  if (input.name) {
    conditions.push(profileSearchWhere(input.name));
  }
  if (input.country) {
    conditions.push(property('country', input.country));
  }
  if (input.city) {
    conditions.push(property('city', input.city));
  }
  if (input.device) {
    conditions.push(property('device', input.device));
  }
  if (input.browser) {
    conditions.push(property('browser', input.browser));
  }

  if (input.inactiveDays !== undefined) {
    const days = Math.floor(input.inactiveDays);
    const since = new Date(nowSeconds() - days * DAY_MS).toISOString();
    conditions.push(sql`id NOT IN (
      SELECT profile_id FROM analytics.events
      WHERE project_id = ${pid}
        AND profile_id <> ''
        AND created_at >= ${since}::timestamptz
    )`);
  }

  if (input.minSessions !== undefined) {
    const min = Math.floor(input.minSessions);
    conditions.push(sql`id IN (
      SELECT profile_id FROM analytics.sessions
      WHERE project_id = ${pid}
        AND profile_id <> ''
      GROUP BY profile_id
      HAVING count(*) >= ${min}
    )`);
  }

  if (input.performedEvent) {
    conditions.push(sql`id IN (
      SELECT profile_id FROM analytics.events
      WHERE project_id = ${pid}
        AND name = ${input.performedEvent}::text
    )`);
  }

  conditions.push(
    ...prefixedFilterClauses(input.filters ?? [], { ...UTC, projectId: pid, table: 'profiles' }),
  );

  const orderDir = raw(input.sortOrder === 'asc' ? 'ASC' : 'DESC');
  const limit = Math.trunc(Math.min(input.limit ?? 20, 100));

  return anQuery<IClickhouseProfile>(sql`
    SELECT ${profileRow()}
    FROM analytics.profiles
    WHERE ${and(conditions)}
    ORDER BY created_at ${orderDir}
    LIMIT ${limit}
  `);
}

export async function getProfileWithEvents(
  projectId: string,
  profileId: string,
  eventLimit = 10,
): Promise<{
  profile: IClickhouseProfile | null;
  recent_events: IClickhouseEvent[];
}> {
  const [profiles, recent_events] = await Promise.all([
    anQuery<IClickhouseProfile>(sql`
      SELECT ${profileRow()}
      FROM analytics.profiles
      WHERE project_id = ${projectId} AND id = ${profileId}
      LIMIT 1
    `),
    anQuery<IClickhouseEvent>(sql`
      SELECT ${eventRow()}
      FROM analytics.events
      WHERE project_id = ${projectId} AND profile_id = ${profileId}
      ORDER BY created_at DESC
      LIMIT ${Math.trunc(eventLimit)}
    `),
  ]);

  return { profile: profiles[0] ?? null, recent_events };
}

export function getProfileSessionsCore(
  projectId: string,
  profileId: string,
  limit = 20,
): Promise<IClickhouseSession[]> {
  return anQuery<IClickhouseSession>(sql`
    SELECT ${sessionRow()}
    FROM analytics.sessions
    WHERE project_id = ${projectId} AND profile_id = ${profileId}
    ORDER BY created_at DESC
    LIMIT ${Math.trunc(limit)}
  `);
}

export async function getProfileMetricsCore(input: {
  projectId: string;
  profileId: string;
}) {
  const raw = await getProfileMetrics(input.profileId, input.projectId);
  if (!raw) {
    throw new Error(`Profile not found or has no events: ${input.profileId}`);
  }
  return {
    profileId: input.profileId,
    firstSeen: raw.firstSeen,
    lastSeen: raw.lastSeen,
    sessions: raw.sessions,
    screenViews: raw.screenViews,
    totalEvents: raw.totalEvents,
    conversionEvents: raw.conversionEvents,
    uniqueDaysActive: raw.uniqueDaysActive,
    avgSessionDurationMin: raw.durationAvg,
    p90SessionDurationMin: raw.durationP90,
    avgEventsPerSession: raw.avgEventsPerSession,
    avgTimeBetweenSessionsSec: raw.avgTimeBetweenSessions,
    bounceRate: raw.bounceRate,
    revenue: raw.revenue,
  };
}

/**
 * Every distinct key present in any external profile's `properties` map,
 * sorted.
 */
export async function getProfilePropertyKeys(
  projectId: string,
): Promise<string[]> {
  const rows = await anQuery<{ key: string }>(sql`
    SELECT DISTINCT jsonb_object_keys(properties) AS key
    FROM analytics.profiles
    WHERE project_id = ${projectId} AND is_external = true
  `);
  return rows.map((r) => r.key).sort();
}

/**
 * Cached by projectId only. The picker's tRPC-level cache keys on the whole
 * input, which includes `event` — so without this the full profile scan would
 * repeat once per event within the same window, even though the profile keys
 * don't depend on the event at all.
 */
export const getProfilePropertyKeysCached = cacheable(
  getProfilePropertyKeys,
  60,
);
