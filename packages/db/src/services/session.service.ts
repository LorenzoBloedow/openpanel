import { getSafeJson } from '@openpanel/json';
import { cacheable } from '@openpanel/redis';
import type { IChartEventFilter } from '@openpanel/validation';
import { anQuery } from '../analytics/client';
import { convertClickhouseDateToJs } from '../analytics/dates';
import { prefixedFilterClauses } from '../analytics/filters';
import { clix } from '../analytics/query-builder';
import { sessionRow } from '../analytics/rows';
import { type Sql, and, join, or, raw, sql } from '../analytics/sql';
import { resolveDateRange } from './date.service';
import { resolveMaxLookbackDays } from './lookback';
import { getProfilesCached, type IServiceProfile } from './profile.service';

/**
 * The session queries ran in UTC (no session_timezone): day boundaries of
 * the date filters are UTC days.
 */
const UTC = { timezone: 'UTC' } as const;

const DAY_MS = 86_400_000;

export interface IClickhouseSession {
  id: string;
  profile_id: string;
  event_count: number;
  screen_view_count: number;
  entry_path: string;
  entry_origin: string;
  exit_path: string;
  exit_origin: string;
  created_at: string;
  ended_at: string;
  referrer: string;
  referrer_name: string;
  referrer_type: string;
  os: string;
  os_version: string;
  browser: string;
  browser_version: string;
  device: string;
  brand: string;
  model: string;
  country: string;
  region: string;
  city: string;
  longitude: number | null;
  latitude: number | null;
  is_bounce: boolean;
  project_id: string;
  device_id: string;
  duration: number;
  utm_medium: string;
  utm_source: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  revenue: number;
  sign: 1 | -1;
  version: number;
  // Dynamically added
  has_replay?: boolean;
  groups: string[];
}

export interface IServiceSession {
  id: string;
  profileId: string;
  eventCount: number;
  screenViewCount: number;
  entryPath: string;
  entryOrigin: string;
  exitPath: string;
  exitOrigin: string;
  createdAt: Date;
  endedAt: Date;
  referrer: string;
  referrerName: string;
  referrerType: string;
  os: string;
  osVersion: string;
  browser: string;
  browserVersion: string;
  device: string;
  brand: string;
  model: string;
  country: string;
  region: string;
  city: string;
  longitude: number | null;
  latitude: number | null;
  isBounce: boolean;
  projectId: string;
  deviceId: string;
  duration: number;
  utmMedium: string;
  utmSource: string;
  utmCampaign: string;
  utmContent: string;
  utmTerm: string;
  revenue: number;
  profile?: IServiceProfile;
  hasReplay?: boolean;
  groups: string[];
}

export interface GetSessionListOptions {
  projectId: string;
  profileId?: string;
  take: number;
  filters?: IChartEventFilter[];
  startDate?: Date;
  endDate?: Date;
  search?: string;
  cursor?: Date;
  dateIntervalInDays?: number;
}

export function transformSession(session: IClickhouseSession): IServiceSession {
  return {
    id: session.id,
    profileId: session.profile_id,
    eventCount: session.event_count,
    screenViewCount: session.screen_view_count,
    entryPath: session.entry_path,
    entryOrigin: session.entry_origin,
    exitPath: session.exit_path,
    exitOrigin: session.exit_origin,
    createdAt: convertClickhouseDateToJs(session.created_at),
    endedAt: convertClickhouseDateToJs(session.ended_at),
    referrer: session.referrer,
    referrerName: session.referrer_name,
    referrerType: session.referrer_type,
    os: session.os,
    osVersion: session.os_version,
    browser: session.browser,
    browserVersion: session.browser_version,
    device: session.device,
    brand: session.brand,
    model: session.model,
    country: session.country,
    region: session.region,
    city: session.city,
    longitude: session.longitude,
    latitude: session.latitude,
    isBounce: session.is_bounce,
    projectId: session.project_id,
    deviceId: session.device_id,
    duration: session.duration,
    utmMedium: session.utm_medium,
    utmSource: session.utm_source,
    utmCampaign: session.utm_campaign,
    utmContent: session.utm_content,
    utmTerm: session.utm_term,
    revenue: session.revenue,
    profile: undefined,
    hasReplay: session.has_replay,
    groups: session.groups,
  };
}

/** An instant truncated to whole seconds (ClickHouse's DateTime text). */
function toSecond(date: Date): number {
  return Math.floor(date.getTime() / 1000) * 1000;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * `toDate(created_at) BETWEEN toDate(start) AND toDate(end)` with the UTC
 * days of the bounds, as an index-friendly range.
 */
function createdOnDays(startDate: Date, endDate: Date): Sql {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  return sql`created_at >= ${day(startDate)}::date::timestamp AT TIME ZONE 'UTC'
    AND created_at < (${day(endDate)}::date + 1)::timestamp AT TIME ZONE 'UTC'`;
}

/** The list search: entry/exit path and referrer, as typed (LIKE pattern). */
function sessionSearch(search: string): Sql {
  const like = sql`${`%${search}%`}::text`;
  return or([
    sql`entry_path ILIKE ${like}`,
    sql`exit_path ILIKE ${like}`,
    sql`referrer ILIKE ${like}`,
    sql`referrer_name ILIKE ${like}`,
  ]);
}

const LIST_COLUMNS = [
  'created_at',
  'ended_at',
  'id',
  'profile_id',
  'entry_path',
  'exit_path',
  'duration',
  'is_bounce',
  'referrer_name',
  'referrer',
  'country',
  'city',
  'os',
  'browser',
  'brand',
  'model',
  'device',
  'screen_view_count',
  'event_count',
  'revenue',
  'groups',
] as const;

export async function getSessionList(options: GetSessionListOptions) {
  const {
    cursor,
    take,
    projectId,
    profileId,
    filters,
    startDate,
    endDate,
    search,
    dateIntervalInDays = 0.5,
  } = options;

  // Deployment-tunable ceiling for the empty-result lookback (see lookback.ts).
  const MAX_DATE_INTERVAL_IN_DAYS = resolveMaxLookbackDays(
    'SESSION_LIST_MAX_LOOKBACK_DAYS',
    365,
  );
  // Cap the date interval to prevent infinity
  const safeDateIntervalInDays = Math.min(
    dateIntervalInDays,
    MAX_DATE_INTERVAL_IN_DAYS,
  );
  // ClickHouse truncated `INTERVAL 0.5 DAY` to 0 days: the first window is
  // empty, then 1, 2, 4, … days.
  const windowMs = Math.trunc(safeDateIntervalInDays) * DAY_MS;

  const where: (Sql | null)[] = [sql`project_id = ${projectId}`];
  let hasCursorWindow = false;

  if (cursor instanceof Date) {
    const at = toSecond(cursor);
    where.push(sql`created_at >= ${iso(at - windowMs)}::timestamptz`);
    where.push(sql`created_at < ${iso(at)}::timestamptz`);
    hasCursorWindow = true;
  }

  if (!(cursor || (startDate && endDate))) {
    where.push(sql`created_at >= ${iso(toSecond(new Date()) - windowMs)}::timestamptz`);
    hasCursorWindow = true;
  }

  if (startDate && endDate) {
    where.push(createdOnDays(startDate, endDate));
  }

  if (profileId) {
    where.push(sql`profile_id = ${profileId}`);
  }
  if (search) {
    where.push(sessionSearch(search));
  }
  if (filters?.length) {
    where.push(
      ...prefixedFilterClauses(filters, {
        ...UTC,
        projectId,
        table: 'sessions',
        startDate,
        endDate,
      }),
    );
  }

  // The ClickHouse query also joined the replay chunks for `hasReplay`, but
  // selected it under a name the transform never read: the list has never
  // returned it, so the join is gone.
  const data = await anQuery<IClickhouseSession>(sql`
    SELECT ${join(LIST_COLUMNS.map((column) => raw(column)))}
    FROM analytics.sessions
    WHERE ${and(where)}
    ORDER BY created_at DESC
    ${take ? sql`LIMIT ${take}` : sql``}
  `);

  // If no results and we haven't reached the max window, retry with a larger interval
  if (
    data.length === 0 &&
    hasCursorWindow &&
    safeDateIntervalInDays < MAX_DATE_INTERVAL_IN_DAYS
  ) {
    return getSessionList({
      ...options,
      dateIntervalInDays: dateIntervalInDays * 2,
    });
  }

  // `device_id` isn't selected, so every profile id is looked up (anonymous
  // devices have profile rows too).
  const profileIds = data
    .filter((e) => e.device_id !== e.profile_id)
    .map((e) => e.profile_id);
  const profiles = await getProfilesCached(profileIds, projectId);
  const map = new Map<string, IServiceProfile>(profiles.map((p) => [p.id, p]));

  const items = data.map(transformSession).map((item) => ({
    ...item,
    profile: map.get(item.profileId) ?? {
      id: item.profileId,
      email: '',
      avatar: '',
      firstName: '',
      lastName: '',
      createdAt: new Date(),
      lastSeenAt: new Date(),
      projectId,
      isExternal: false,
      properties: {},
      groups: [],
    },
  }));

  // Compute cursors from page edges
  const last = items.at(-1);

  const meta = {
    next: last ? last.createdAt.toISOString() : undefined,
  };

  return { items, meta };
}

export async function getSessionsCount({
  projectId,
  profileId,
  filters,
  startDate,
  endDate,
  search,
}: Omit<GetSessionListOptions, 'take' | 'cursor'>) {
  const where: (Sql | null)[] = [sql`project_id = ${projectId}`];

  if (profileId) {
    where.push(sql`profile_id = ${profileId}`);
  }

  if (startDate && endDate) {
    where.push(createdOnDays(startDate, endDate));
  }

  if (search) {
    where.push(sessionSearch(search));
  }

  if (filters && filters.length > 0) {
    where.push(
      ...prefixedFilterClauses(filters, {
        ...UTC,
        projectId,
        table: 'sessions',
        startDate,
        endDate,
      }),
    );
  }

  const result = await anQuery<{ count: number }>(sql`
    SELECT count(*) AS count FROM analytics.sessions WHERE ${and(where)}
  `);
  return result[0]?.count ?? 0;
}

export const getSessionsCountCached = cacheable(getSessionsCount, 60 * 10);

export interface ISessionReplayChunkMeta {
  chunk_index: number;
  started_at: string;
  ended_at: string;
  events_count: number;
  is_full_snapshot: boolean;
}

const REPLAY_CHUNKS_PAGE_SIZE = 40;

export async function getSessionReplayChunksFrom(
  sessionId: string,
  projectId: string,
  fromIndex: number,
) {
  const rows = await anQuery<{ chunk_index: number; payload: string }>(sql`
    SELECT chunk_index, payload
    FROM analytics.session_replay_chunks
    WHERE project_id = ${projectId} AND session_id = ${sessionId}
    ORDER BY started_at, ended_at, chunk_index
    LIMIT ${REPLAY_CHUNKS_PAGE_SIZE + 1}
    OFFSET ${Math.max(0, Math.trunc(fromIndex))}
  `);

  return {
    data: rows
      .slice(0, REPLAY_CHUNKS_PAGE_SIZE)
      .map((row, index) => {
        const events = getSafeJson<
          { type: number; data: unknown; timestamp: number }[]
        >(row.payload);
        if (!events) {
          return null;
        }
        return { chunkIndex: index + fromIndex, events };
      })
      .filter(Boolean),
    hasMore: rows.length > REPLAY_CHUNKS_PAGE_SIZE,
  };
}

export const SESSION_DISTINCT_FIELDS = [
  'referrer_name',
  'country',
  'os',
  'browser',
  'device',
] as const;

export type SessionDistinctField = (typeof SESSION_DISTINCT_FIELDS)[number];

export async function getSessionDistinctValues(
  projectId: string,
  field: SessionDistinctField,
  limit = 200,
): Promise<string[]> {
  if (!SESSION_DISTINCT_FIELDS.includes(field)) {
    throw new Error(`Unsupported session field: ${JSON.stringify(field)}`);
  }
  const column = raw(field);
  const since = new Date(toSecond(new Date()) - 90 * DAY_MS).toISOString();
  const results = await anQuery<{ value: string }>(sql`
    SELECT ${column} AS value, count(*) AS cnt
    FROM analytics.sessions
    WHERE project_id = ${projectId}
      AND ${column} <> ''
      AND created_at > ${since}::timestamptz
    GROUP BY ${column}
    ORDER BY cnt DESC
    LIMIT ${Math.trunc(limit)}
  `);
  return results.map((r) => r.value).filter(Boolean);
}

class SessionService {
  async byId(sessionId: string, projectId: string) {
    const [sessionRows, hasReplayRows] = await Promise.all([
      anQuery<IClickhouseSession>(sql`
        SELECT ${sessionRow()}
        FROM analytics.sessions
        WHERE project_id = ${projectId} AND id = ${sessionId}
      `),
      anQuery<{ n: number }>(sql`
        SELECT 1 AS n
        FROM analytics.session_replay_chunks
        WHERE project_id = ${projectId} AND session_id = ${sessionId}
        LIMIT 1
      `),
    ]);

    if (!sessionRows[0]) {
      throw new Error('Session not found');
    }

    const session = transformSession(sessionRows[0]);

    return {
      ...session,
      hasReplay: hasReplayRows.length > 0,
    };
  }
}

export const sessionService = new SessionService();

export interface QuerySessionsInput {
  projectId: string;
  startDate?: string;
  endDate?: string;
  country?: string;
  city?: string;
  device?: string;
  browser?: string;
  os?: string;
  referrer?: string;
  referrerName?: string;
  referrerType?: string;
  profileId?: string;
  filters?: IChartEventFilter[];
  limit?: number;
}

export async function querySessionsCore(
  input: QuerySessionsInput,
): Promise<IClickhouseSession[]> {
  const builder = clix(UTC.timezone)
    .select<IClickhouseSession>([sessionRow()])
    .from('analytics.sessions')
    .rawWhere(sql`project_id = ${input.projectId}`);

  const equals: [column: string, value: string | undefined][] = [
    ['profile_id', input.profileId],
    ['referrer', input.referrer],
    ['referrer_name', input.referrerName],
    ['referrer_type', input.referrerType],
    ['device', input.device],
    ['country', input.country],
    ['city', input.city],
    ['os', input.os],
    ['browser', input.browser],
  ];
  for (const [column, value] of equals) {
    if (value) {
      builder.rawWhere(sql`${raw(column)} = ${value}::text`);
    }
  }

  const { startDate: start, endDate: end } = resolveDateRange(
    input.startDate,
    input.endDate,
  );

  builder.where('created_at', 'BETWEEN', [
    clix.datetime(start),
    clix.datetime(end),
  ]);

  if (input.filters?.length) {
    for (const clause of prefixedFilterClauses(input.filters, {
      ...UTC,
      projectId: input.projectId,
      table: 'sessions',
      startDate: new Date(start),
      endDate: new Date(end),
    })) {
      builder.rawWhere(clause);
    }
  }

  return builder.limit(input.limit ?? 20).execute();
}
