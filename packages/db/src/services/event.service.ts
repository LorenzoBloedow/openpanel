import { cacheable, getCache } from '@openpanel/redis';
import type { IChartEventFilter } from '@openpanel/validation';
import { assocPath, last, mergeDeepRight, path } from 'ramda';
import { anQuery } from '../analytics/client';
import { convertClickhouseDateToJs } from '../analytics/dates';
import {
  type EventFilterScope,
  eventFilterClauses,
  prefixedFilterClauses,
  profileJoin,
} from '../analytics/filters';
import { type Query, clix } from '../analytics/query-builder';
import { HIDDEN_PROPERTY_KEYS } from '../analytics/rollups';
import { eventRow } from '../analytics/rows';
import { type Sql, and, empty, join, raw, sql } from '../analytics/sql';
import type { EventMeta, Prisma } from '../prisma-client';
import { db } from '../prisma-client';
import { resolveDateRange } from './date.service';
import { resolveMaxLookbackDays } from './lookback';
import type { IServiceProfile } from './profile.service';
import { getProfileById, getProfilesCached } from './profile.service';
import type { IClickhouseSession } from './session.service';

/**
 * The event queries ran in UTC (ClickHouse `clix(ch)` / no
 * session_timezone), so date filters use UTC days.
 */
const UTC = { timezone: 'UTC' } as const;

const DAY_MS = 86_400_000;

export type IImportedEvent = Omit<
  IClickhouseEvent,
  'properties' | 'profile' | 'meta' | 'imported_at'
> & {
  properties: Record<string, unknown>;
};

export interface IServicePage {
  path: string;
  count: number;
  project_id: string;
  first_seen: string;
  title: string;
  origin: string;
}

export interface IClickhouseBotEvent {
  id: string;
  name: string;
  type: string;
  project_id: string;
  path: string;
  created_at: string;
}

export interface IServiceBotEvent {
  id: string;
  name: string;
  type: string;
  projectId: string;
  path: string;
  createdAt: Date;
}

export type IServiceCreateBotEventPayload = Omit<IServiceBotEvent, 'id'>;

export interface IClickhouseEvent {
  id: string;
  name: string;
  device_id: string;
  profile_id: string;
  project_id: string;
  session_id: string;
  path: string;
  origin: string;
  referrer: string;
  referrer_name: string;
  referrer_type: string;
  duration: number;
  properties: Record<string, string | number | boolean | undefined | null>;
  created_at: string;
  country: string;
  city: string;
  region: string;
  longitude: number | null;
  latitude: number | null;
  os: string;
  os_version: string;
  browser: string;
  browser_version: string;
  device: string;
  brand: string;
  model: string;
  imported_at: string | null;
  // Ingestion (ClickHouse-insert) time. Set explicitly at insert time; the
  // column DEFAULTs to created_at for rows that omit it. Used as the cursor for
  // object-store exports. Optional here because most read queries don't select
  // it.
  inserted_at?: string;
  sdk_name: string;
  sdk_version: string;
  revenue?: number;
  groups: string[];

  // They do not exist here. Just make ts happy for now
  profile?: IServiceProfile;
  meta?: EventMeta;
}

export function transformSessionToEvent(
  session: IClickhouseSession
): IServiceEvent {
  return {
    id: '', // Not used
    name: 'screen_view',
    sessionId: session.id,
    profileId: session.profile_id,
    path: session.exit_path,
    origin: session.exit_origin,
    createdAt: convertClickhouseDateToJs(session.ended_at),
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
    projectId: session.project_id,
    deviceId: session.device_id,
    duration: 0,
    revenue: session.revenue,
    properties: {
      is_bounce: session.is_bounce,
      __query: {
        utm_medium: session.utm_medium,
        utm_source: session.utm_source,
        utm_campaign: session.utm_campaign,
        utm_content: session.utm_content,
        utm_term: session.utm_term,
      },
    },
    profile: undefined,
    meta: undefined,
    importedAt: undefined,
    sdkName: undefined,
    sdkVersion: undefined,
    groups: [],
  };
}

export function transformEvent(event: IClickhouseEvent): IServiceEvent {
  return {
    id: event.id,
    name: event.name,
    deviceId: event.device_id,
    profileId: event.profile_id,
    projectId: event.project_id,
    sessionId: event.session_id,
    properties: event.properties,
    createdAt: convertClickhouseDateToJs(event.created_at),
    country: event.country,
    city: event.city,
    region: event.region,
    longitude: event.longitude,
    latitude: event.latitude,
    os: event.os,
    osVersion: event.os_version,
    browser: event.browser,
    browserVersion: event.browser_version,
    device: event.device,
    brand: event.brand,
    model: event.model,
    path: event.path,
    origin: event.origin,
    referrer: event.referrer,
    referrerName: event.referrer_name,
    referrerType: event.referrer_type,
    meta: event.meta,
    importedAt: event.imported_at ? new Date(event.imported_at) : undefined,
    sdkName: event.sdk_name,
    sdkVersion: event.sdk_version,
    profile: event.profile,
    revenue: event.revenue,
    groups: event.groups ?? [],
  };
}

export type IServiceCreateEventPayload = Omit<
  IServiceEvent,
  'id' | 'importedAt' | 'profile' | 'meta'
>;
export type IServiceImportedEventPayload = Omit<
  IServiceEvent,
  'profile' | 'meta'
>;

export interface IServiceEvent {
  id: string;
  name: string;
  deviceId: string;
  profileId: string;
  projectId: string;
  sessionId: string;
  properties: Record<string, unknown> & {
    hash?: string;
    query?: Record<string, unknown>;
  };
  createdAt: Date;
  country?: string | undefined;
  city?: string | undefined;
  region?: string | undefined;
  longitude?: number | undefined | null;
  latitude?: number | undefined | null;
  os?: string | undefined;
  osVersion?: string | undefined;
  browser?: string | undefined;
  browserVersion?: string | undefined;
  device?: string | undefined;
  brand?: string | undefined;
  model?: string | undefined;
  duration?: number;
  path: string;
  origin: string;
  referrer: string | undefined;
  referrerName: string | undefined;
  referrerType: string | undefined;
  importedAt: Date | undefined;
  profile: IServiceProfile | undefined;
  meta: EventMeta | undefined;
  sdkName: string | undefined;
  sdkVersion: string | undefined;
  revenue?: number;
  groups: string[];
}

type SelectHelper<T> = {
  [K in keyof T]?: boolean;
};

export interface IServiceEventMinimal {
  id: string;
  name: string;
  projectId: string;
  sessionId: string;
  createdAt: Date;
  country?: string | undefined;
  longitude?: number | undefined | null;
  latitude?: number | undefined | null;
  os?: string | undefined;
  browser?: string | undefined;
  device?: string | undefined;
  brand?: string | undefined;
  duration?: number;
  path: string;
  origin: string;
  referrer: string | undefined;
  meta: EventMeta | undefined;
  minimal: boolean;
}

interface GetEventsOptions {
  profile?: boolean;
  meta?: boolean | Prisma.EventMetaSelect;
}

function maskString(str: string, mask = '*') {
  const allMasked = str.replace(/(\w)/g, mask);
  if (str.length < 8) {
    return allMasked;
  }

  return `${str.slice(0, 4)}${allMasked.slice(4)}`;
}

export function transformMinimalEvent(
  event: IServiceEvent
): IServiceEventMinimal {
  return {
    id: event.id,
    name: event.name,
    projectId: event.projectId,
    sessionId: event.sessionId,
    createdAt: event.createdAt,
    country: event.country,
    longitude: event.longitude,
    latitude: event.latitude,
    os: event.os,
    browser: event.browser,
    device: event.device,
    brand: event.brand,
    duration: event.duration,
    path: maskString(event.path),
    origin: event.origin,
    referrer: event.referrer,
    meta: event.meta,
    minimal: true,
  };
}

export function getEventMetas(projectId: string) {
  return db.eventMeta.findMany({
    where: {
      projectId,
    },
  });
}

export const getEventMetasCached = cacheable(getEventMetas, 60 * 5);

export async function getEvents(
  query: Sql,
  options: GetEventsOptions = {}
): Promise<IServiceEvent[]> {
  const events = await anQuery<IClickhouseEvent>(query);
  const projectId = events[0]?.project_id;
  if (options.profile && projectId) {
    const ids = events
      .filter((e) => e.device_id !== e.profile_id)
      .map((e) => e.profile_id);
    const profiles = await getProfilesCached(ids, projectId);

    const map = new Map<string, IServiceProfile>();
    for (const profile of profiles) {
      map.set(profile.id, profile);
    }

    for (const event of events) {
      event.profile = map.get(event.profile_id) ?? {
        id: event.profile_id,
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
      };
    }
  }

  if (options.meta && projectId) {
    const metas = await getEventMetasCached(projectId);
    const map = new Map<string, EventMeta>();
    for (const meta of metas) {
      map.set(meta.name, meta);
    }
    for (const event of events) {
      event.meta = map.get(event.name);
    }
  }
  return events.map(transformEvent);
}

/** Extra conditions a caller adds to the event list query (see `custom`). */
export interface EventListQuery {
  /** ANDed into the WHERE clause; the events table is aliased `e`. */
  where: Sql[];
}

export interface GetEventListOptions {
  projectId: string;
  profileId?: string;
  sessionId?: string;
  groupId?: string;
  cohortId?: string;
  take: number;
  cursor?: number | Date;
  events?: string[] | null;
  filters?: IChartEventFilter[];
  startDate?: Date;
  endDate?: Date;
  select?: SelectHelper<IServiceEvent>;
  custom?: (query: EventListQuery) => void;
  dateIntervalInDays?: number;
}

/** An instant truncated to whole seconds (ClickHouse's DateTime text). */
function toSecond(date: Date): number {
  return Math.floor(date.getTime() / 1000) * 1000;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Report filters on `analytics.events e`, and the joins they need. */
function eventListFilters(
  filters: IChartEventFilter[] | undefined,
  projectId: string,
): { where: Sql[]; joins: Sql[] } {
  if (!filters?.length) {
    return { where: [], joins: [] };
  }
  const scope: EventFilterScope = { ...UTC, projectId, alias: 'e' };
  // `profile.properties.*` reads the joined profile, as the ClickHouse
  // `LEFT ANY JOIN … AS profile` did. (Bare `profile.<column>` names are
  // not event filters and are dropped.) `group.*` filters are EXISTS over
  // the event's groups instead of an ARRAY JOIN, so an event in two
  // matching groups is listed and counted once.
  const joinsProfile = filters.some((filter) => filter.name.startsWith('profile.'));
  if (joinsProfile) {
    scope.profileAlias = 'profile';
  }
  return {
    where: eventFilterClauses(filters, scope),
    joins: joinsProfile ? [profileJoin(scope)] : [],
  };
}

/** Where clauses shared by the event list and its count. */
function eventScopeWhere({
  projectId,
  groupId,
  cohortId,
  startDate,
  endDate,
  events,
}: Pick<
  GetEventListOptions,
  'projectId' | 'groupId' | 'cohortId' | 'startDate' | 'endDate' | 'events'
>): Sql[] {
  const where: Sql[] = [];
  if (groupId) {
    where.push(sql`${groupId}::text = ANY(e.groups)`);
  }
  if (cohortId) {
    where.push(sql`e.profile_id IN (SELECT profile_id FROM analytics.cohort_members WHERE cohort_id = ${cohortId} AND project_id = ${projectId})`);
  }
  if (startDate) {
    where.push(sql`e.created_at >= ${startDate.toISOString()}::timestamptz`);
  }
  if (endDate) {
    where.push(sql`e.created_at <= ${endDate.toISOString()}::timestamptz`);
  }
  if (events && events.length > 0) {
    where.push(sql`e.name = ANY(${events}::text[])`);
  }
  return where;
}

const LIST_COLUMNS: Partial<Record<keyof IServiceEvent, string>> = {
  id: 'id',
  name: 'name',
  deviceId: 'device_id',
  profileId: 'profile_id',
  projectId: 'project_id',
  sessionId: 'session_id',
  properties: 'properties',
  country: 'country',
  city: 'city',
  region: 'region',
  longitude: 'longitude',
  latitude: 'latitude',
  os: 'os',
  osVersion: 'os_version',
  browser: 'browser',
  browserVersion: 'browser_version',
  device: 'device',
  brand: 'brand',
  model: 'model',
  path: 'path',
  origin: 'origin',
  referrer: 'referrer',
  referrerName: 'referrer_name',
  referrerType: 'referrer_type',
  importedAt: 'imported_at',
  sdkName: 'sdk_name',
  sdkVersion: 'sdk_version',
  revenue: 'revenue',
  groups: 'groups',
};

/**
 * Fetches a page of events matching the given filters/date range, ordered
 * newest first. Falls back to a default recent-days cursor window when no
 * cursor or explicit date bound is provided.
 */
export async function getEventList(options: GetEventListOptions) {
  const {
    cursor,
    take,
    projectId,
    profileId,
    sessionId,
    filters,
    startDate,
    endDate,
    custom,
    select: incomingSelect,
    dateIntervalInDays = 0.5,
  } = options;

  // Deployment-tunable ceiling for the empty-result lookback (see lookback.ts).
  const MAX_DATE_INTERVAL_IN_DAYS = resolveMaxLookbackDays(
    'EVENT_LIST_MAX_LOOKBACK_DAYS',
    365 * 5,
  );
  // Cap the date interval to prevent infinity
  const safeDateIntervalInDays = Math.min(
    dateIntervalInDays,
    MAX_DATE_INTERVAL_IN_DAYS
  );
  // ClickHouse truncated `INTERVAL 0.5 DAY` to 0 days: the first window is
  // empty, then 1, 2, 4, … days.
  const windowMs = Math.trunc(safeDateIntervalInDays) * DAY_MS;

  const query: EventListQuery = { where: [sql`e.project_id = ${projectId}`] };
  let offset = 0;
  let hasCursorWindow = false;

  if (typeof cursor === 'number') {
    offset = Math.max(0, (cursor ?? 0) * take);
  } else if (cursor instanceof Date) {
    const at = toSecond(cursor);
    query.where.push(sql`e.created_at >= ${iso(at - windowMs)}::timestamptz`);
    query.where.push(sql`e.created_at < ${iso(at)}::timestamptz`);
    hasCursorWindow = true;
  }

  if (cursor === undefined && !startDate && !endDate) {
    query.where.push(
      sql`e.created_at >= ${iso(toSecond(new Date()) - windowMs)}::timestamptz`,
    );
    hasCursorWindow = true;
  }

  const select = mergeDeepRight(
    {
      id: true,
      name: true,
      deviceId: true,
      profileId: true,
      sessionId: true,
      projectId: true,
      createdAt: true,
      path: true,
      duration: true,
      city: true,
      country: true,
      os: true,
      browser: true,
    },
    incomingSelect ?? {}
  );

  // created_at and project_id are always read; the rest follows `select`
  // (`duration` never was).
  const columns = new Set<string>(['created_at', 'project_id']);
  for (const [field, column] of Object.entries(LIST_COLUMNS)) {
    if (select[field as keyof typeof select]) {
      columns.add(column);
    }
  }

  if (profileId) {
    // Identity stitching: pull pre-identification anonymous events from devices
    // this profile has used, plus the profile's own identified events.
    // Anonymous events have profile_id = device_id; the guard prevents
    // leaking another user's identified events when a device_id collides
    // (NAT, shared UA, server-side senders).
    query.where.push(sql`((e.device_id IN (SELECT device_id FROM analytics.events WHERE project_id = ${projectId} AND device_id <> '' AND profile_id = ${profileId} GROUP BY device_id) AND e.profile_id = e.device_id) OR e.profile_id = ${profileId})`);
  }

  if (sessionId) {
    query.where.push(sql`e.session_id = ${sessionId}`);
  }

  query.where.push(...eventScopeWhere(options));

  const filterParts = eventListFilters(filters, projectId);
  query.where.push(...filterParts.where);

  if (custom) {
    custom(query);
  }

  const data = await getEvents(
    sql`
      SELECT ${join([...columns].map((column) => raw(`e.${column}`)))}
      FROM analytics.events e
      ${join(filterParts.joins, ' ')}
      WHERE ${and(query.where)}
      ORDER BY e.created_at DESC, e.id ASC
      ${take ? sql`LIMIT ${take}` : empty}
      ${offset ? sql`OFFSET ${offset}` : empty}
    `,
    {
      profile: select.profile ?? true,
      meta: select.meta ?? true,
    }
  );

  // If we dont get any events, try without the cursor window
  if (
    data.length === 0 &&
    hasCursorWindow &&
    safeDateIntervalInDays < MAX_DATE_INTERVAL_IN_DAYS
  ) {
    return getEventList({
      ...options,
      dateIntervalInDays: dateIntervalInDays * 2,
    });
  }

  return data;
}

/**
 * Counts events matching the given filters/date range, using the same
 * where-clause construction as getEventList (but a profileId counts the
 * profile's own events, without the anonymous-device stitching).
 */
export async function getEventsCount({
  projectId,
  profileId,
  groupId,
  cohortId,
  events,
  filters,
  startDate,
  endDate,
}: Omit<GetEventListOptions, 'cursor' | 'take'>) {
  const where: Sql[] = [sql`e.project_id = ${projectId}`];
  if (profileId) {
    where.push(sql`e.profile_id = ${profileId}`);
  }
  where.push(
    ...eventScopeWhere({ projectId, groupId, cohortId, startDate, endDate, events }),
  );
  const filterParts = eventListFilters(filters, projectId);
  where.push(...filterParts.where);

  const res = await anQuery<{ count: number }>(sql`
    SELECT count(*) AS count
    FROM analytics.events e
    ${join(filterParts.joins, ' ')}
    WHERE ${and(where)}
  `);

  return res[0]?.count ?? 0;
}

export function getConversionEventNames(projectId: string) {
  return db.eventMeta.findMany({
    where: {
      projectId,
      conversion: true,
    },
  });
}

/**
 * Most viewed paths of the last 30 days (unused by the dashboard). `search`
 * is a bound ILIKE pattern, as typed.
 */
export async function getTopPages({
  projectId,
  cursor,
  take,
  search,
}: {
  projectId: string;
  cursor?: number;
  take: number;
  search?: string;
}) {
  const since = new Date(toSecond(new Date()) - 30 * DAY_MS).toISOString();
  return anQuery<IServicePage>(sql`
    SELECT
      path,
      count(*) AS count,
      project_id,
      min(created_at) AS first_seen,
      (array_agg(COALESCE(properties ->> '__title', '') ORDER BY created_at DESC))[1] AS title,
      origin
    FROM analytics.events
    WHERE name = 'screen_view'
      AND project_id = ${projectId}
      AND created_at > ${since}::timestamptz
      ${search ? sql`AND path ILIKE ${`%${search}%`}::text` : empty}
    GROUP BY path, project_id, origin
    ORDER BY count DESC
    LIMIT ${take}
    OFFSET ${Math.max(0, (cursor ?? 0) * take)}
  `);
}

export interface IEventServiceGetList {
  projectId: string;
  profileId?: string;
  cursor?: Date;
  filters?: IChartEventFilter[];
}

/** A canonical, braced or unhyphenated UUID; anything else is no event id. */
const UUID = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;

class EventService {
  query<T>({
    projectId,
    profileId,
    where,
    select,
    limit,
    filters,
  }: {
    projectId: string;
    profileId?: string;
    where?: {
      profile?: (query: Query<T>) => void;
      event?: (query: Query<T>) => void;
      session?: (query: Query<T>) => void;
    };
    select: {
      profile?: Partial<SelectHelper<IServiceProfile>>;
      event: Partial<SelectHelper<IServiceEvent>>;
    };
    limit?: number;
    orderBy?: keyof IClickhouseEvent;
    filters?: IChartEventFilter[];
  }) {
    // `profile.*` filters read the profile joined as `profile` (see getList).
    const joinsProfile = !!filters?.some((f) => f.name.startsWith('profile.'));

    const events = clix(UTC.timezone)
      .select<T>([
        select.event.id && 'e.id AS id',
        select.event.deviceId && 'e.device_id AS device_id',
        select.event.name && 'e.name AS name',
        select.event.path && 'e.path AS path',
        select.event.country && 'e.country AS country',
        select.event.city && 'e.city AS city',
        select.event.os && 'e.os AS os',
        select.event.browser && 'e.browser AS browser',
        select.event.createdAt && 'e.created_at AS created_at',
        select.event.projectId && 'e.project_id AS project_id',
        'e.session_id AS session_id',
        'e.profile_id AS profile_id',
      ])
      .from('analytics.events e')
      .rawWhere(sql`e.project_id = ${projectId}`)
      .when(joinsProfile, (q) => {
        q.rawJoin(profileJoin({ projectId, alias: 'e' }));
      })
      .when(!!where?.event, where?.event)
      // Do not limit if profileId, we will limit later since we need the "correct" profileId
      .when(!!limit && !profileId, (q) => q.limit(limit!))
      .orderBy('e.created_at', 'DESC');

    const sessions = clix(UTC.timezone)
      .select<T>(['id AS session_id', 'profile_id'])
      .from('analytics.sessions')
      .rawWhere(sql`project_id = ${projectId}`)
      .when(!!where?.session, where?.session)
      .when(!!profileId, (q) => {
        q.rawWhere(sql`profile_id = ${profileId}`);
      });

    // One row per profile: names as NULL when empty, like the ClickHouse
    // any(nullIf(…)) aggregates.
    const profiles = clix(UTC.timezone)
      .select<T>([
        'id',
        'created_at',
        "NULLIF(first_name, '') AS first_name",
        "NULLIF(last_name, '') AS last_name",
        "NULLIF(email, '') AS email",
        "NULLIF(avatar, '') AS avatar",
        'is_external',
        'properties',
      ])
      .from('analytics.profiles')
      .rawWhere(sql`project_id = ${projectId}`)
      .rawWhere(
        'id IN (SELECT profile_id FROM cte_sessions UNION SELECT profile_id FROM cte_events)'
      )
      .when(!!where?.profile, where?.profile);

    // Unmatched LEFT JOIN rows read like ClickHouse's defaults: '' ids,
    // false flags, the epoch for dates, NULL for the nullable names.
    return clix(UTC.timezone)
      .with('cte_events', events)
      .with('cte_sessions', sessions)
      .with('cte_profiles', profiles)
      .select<
        Partial<IClickhouseEvent> & {
          // profile
          profileId: string;
          profile_firstName: string;
          profile_lastName: string;
          profile_avatar: string;
          profile_isExternal: boolean;
          profile_createdAt: string;
        }
      >([
        select.event.id && 'e.id AS id',
        select.event.deviceId && 'e.device_id AS device_id',
        select.event.name && 'e.name AS name',
        select.event.path && 'e.path AS path',
        select.event.country && 'e.country AS country',
        select.event.city && 'e.city AS city',
        select.event.os && 'e.os AS os',
        select.event.browser && 'e.browser AS browser',
        select.event.createdAt && 'e.created_at AS created_at',
        select.event.projectId && 'e.project_id AS project_id',
        select.event.sessionId && 'e.session_id AS session_id',
        select.event.profileId && 'e.profile_id AS event_profile_id',
        // Profile
        select.profile?.id && "COALESCE(p.id, '') AS profile_id",
        select.profile?.firstName && 'p.first_name AS profile_first_name',
        select.profile?.lastName && 'p.last_name AS profile_last_name',
        select.profile?.avatar && 'p.avatar AS profile_avatar',
        select.profile?.isExternal &&
          'COALESCE(p.is_external, false) AS profile_is_external',
        select.profile?.createdAt &&
          "COALESCE(p.created_at, 'epoch'::timestamptz) AS profile_created_at",
        select.profile?.email && 'p.email AS profile_email',
        select.profile?.properties && 'p.properties AS profile_properties',
      ])
      .from('cte_events e')
      .leftJoin('cte_sessions s', 'e.session_id = s.session_id')
      .leftJoin('cte_profiles p', 's.profile_id = p.id AND p.is_external = true')
      .when(!!profileId, (q) => {
        q.rawWhere(sql`s.profile_id = ${profileId}`);
        q.limit(limit!);
      });
  }

  transformFromQuery(res: any[]) {
    return res
      .map((item) => {
        return Object.entries(item).reduce(
          (acc, [prop, val]) => {
            if (prop === 'event_profile_id' && val && !item.profile_id) {
              return assocPath(['profile', 'id'], val, acc);
            }

            if (
              prop.startsWith('profile_') &&
              !path(['profile', prop.replace('profile_', '')], acc)
            ) {
              return assocPath(
                ['profile', prop.replace('profile_', '')],
                val,
                acc
              );
            }
            return assocPath([prop], val, acc);
          },
          {
            profile: {},
          } as IClickhouseEvent
        );
      })
      .map(transformEvent);
  }

  async getById({
    projectId,
    id,
    createdAt,
  }: {
    projectId: string;
    id: string;
    createdAt?: Date;
  }) {
    const findEvent = async () => {
      if (!UUID.test(id)) {
        return null;
      }
      const rows = await clix(UTC.timezone)
        .select<IClickhouseEvent>([eventRow()])
        .from('analytics.events')
        .rawWhere(sql`project_id = ${projectId}`)
        .when(!!createdAt, (q) => {
          if (createdAt) {
            // ±1 s around the given time, at the seconds ClickHouse compared.
            q.where('created_at', 'BETWEEN', [
              clix.datetime(new Date(createdAt.getTime() - 1000)),
              clix.datetime(new Date(createdAt.getTime() + 1000)),
            ]);
          }
        })
        .rawWhere(sql`id = ${id}::uuid`)
        .limit(1)
        .execute();
      return rows[0] ? transformEvent(rows[0]) : null;
    };

    const [event, metas] = await Promise.all([
      findEvent(),
      getEventMetasCached(projectId),
    ]);

    if (event?.profileId) {
      const profile = await getProfileById(event?.profileId, projectId);
      if (profile) {
        event.profile = profile;
      }
    }

    if (event) {
      event.meta = metas.find((meta) => meta.name === event.name);
    }

    return event;
  }

  async getList({
    projectId,
    profileId,
    cursor,
    filters,
    limit = 50,
    startDate,
    endDate,
  }: IEventServiceGetList & {
    limit?: number;
    startDate?: Date;
    endDate?: Date;
  }) {
    const date = cursor || new Date();
    // Date bounds at the seconds ClickHouse compared.
    const at = (value: Date) => clix.datetime(value);
    const query = this.query({
      projectId,
      profileId,
      limit,
      orderBy: 'created_at',
      filters,
      select: {
        event: {
          deviceId: true,
          profileId: true,
          id: true,
          name: true,
          createdAt: true,
          country: true,
          city: true,
          os: true,
          browser: true,
          path: true,
          sessionId: true,
        },
        profile: {
          id: true,
          firstName: true,
          lastName: true,
          avatar: true,
          isExternal: true,
        },
      },
      where: {
        event: (q) => {
          if (startDate && endDate) {
            q.where('e.created_at', 'BETWEEN', [
              at(startDate),
              at(cursor ?? endDate),
            ]);
          } else {
            q.where('e.created_at', '<', at(date));
          }
          if (filters) {
            const scope: EventFilterScope = { ...UTC, projectId, alias: 'e' };
            if (filters.some((f) => f.name.startsWith('profile.'))) {
              scope.profileAlias = 'profile';
            }
            q.rawWhere(and(eventFilterClauses(filters, scope)));
          }
        },
        session: (q) => {
          if (startDate && endDate) {
            q.where('created_at', 'BETWEEN', [at(startDate), at(endDate ?? date)]);
          } else {
            q.where('created_at', '<', at(date));
          }
        },
      },
    }).orderBy('e.created_at', 'DESC');

    const results = await query.execute();

    // Current page items (middle chunk)
    const items = results.slice(0, limit);

    // Check if there's a next page
    const hasNext = results.length >= limit;

    return {
      items: this.transformFromQuery(items).map((item) => ({
        ...item,
        projectId,
      })),
      meta: {
        next: hasNext ? last(items)?.created_at : null,
      },
    };
  }
}

export const eventService = new EventService();

/**
 * The event names a project sends (at most 50, most sent first), from the
 * analytics.event_names rollup.
 */
export async function getTopEventNames(projectId: string): Promise<string[]> {
  return getCache(`mcp:event-names:${projectId}`, 60 * 10, async () => {
    const rows = await anQuery<{ name: string }>(sql`
      SELECT name
      FROM analytics.event_names
      WHERE project_id = ${projectId}
      ORDER BY event_count DESC, name
      LIMIT 50
    `);
    return rows.map((r) => r.name);
  });
}

export const listEventNamesCore = (projectId: string): Promise<string[]> =>
  getTopEventNames(projectId);

/**
 * Top-level filterable columns on the `events` table. These apply to
 * every event regardless of name and can be passed straight to the event
 * filters as filter / breakdown `name` values.
 *
 * Kept as a whitelist for the AI / MCP discovery surface.
 */
export const EVENT_COLUMNS = [
  'path',
  'origin',
  'referrer',
  'referrer_name',
  'referrer_type',
  'duration',
  'country',
  'city',
  'region',
  'os',
  'os_version',
  'browser',
  'browser_version',
  'device',
  'brand',
  'model',
  'sdk_name',
  'sdk_version',
  'profile_id',
  'session_id',
  'device_id',
  'revenue',
] as const;

export type IEventColumn = (typeof EVENT_COLUMNS)[number];

/**
 * The (property key, event name) pairs a project's events carry, from the
 * analytics.event_property_keys rollup. Ordered bytewise, as ClickHouse
 * sorted them.
 */
export async function listEventPropertiesCore(input: {
  projectId: string;
  eventName?: string;
}): Promise<{
  columns: readonly string[];
  properties: Array<{ property_key: string; event_name: string }>;
}> {
  const rows = await anQuery<{ property_key: string; event_name: string }>(sql`
    SELECT property_key, name AS event_name
    FROM analytics.event_property_keys
    WHERE project_id = ${input.projectId}
      ${input.eventName ? sql`AND name = ${input.eventName}::text` : empty}
    ORDER BY property_key COLLATE "C", name COLLATE "C"
    LIMIT 500
  `);
  return { columns: EVENT_COLUMNS, properties: rows };
}

/**
 * The distinct non-empty values of one property of one event name, most
 * recently seen first (at most 200) — what event_property_values_mv held.
 */
export async function getEventPropertyValuesCore(input: {
  projectId: string;
  eventName: string;
  propertyKey: string;
}): Promise<{ event: string; property: string; values: string[] }> {
  const hidden =
    input.propertyKey === '' || HIDDEN_PROPERTY_KEYS.includes(input.propertyKey);
  const rows = hidden
    ? []
    : await anQuery<{ value: string }>(sql`
        SELECT properties ->> ${input.propertyKey}::text AS value
        FROM analytics.events
        WHERE project_id = ${input.projectId}
          AND name = ${input.eventName}::text
          AND properties ->> ${input.propertyKey}::text <> ''
        GROUP BY 1
        ORDER BY max(created_at) DESC, 1
        LIMIT 200
      `);

  return {
    event: input.eventName,
    property: input.propertyKey,
    values: rows.map((r) => r.value),
  };
}

export interface QueryEventsInput {
  projectId: string;
  startDate?: string;
  endDate?: string;
  eventNames?: string[];
  path?: string;
  country?: string;
  city?: string;
  device?: string;
  browser?: string;
  os?: string;
  referrer?: string;
  referrerName?: string;
  referrerType?: string;
  sessionId?: string;
  profileId?: string;
  profileIds?: string[];
  properties?: Record<string, string>;
  filters?: IChartEventFilter[];
  limit?: number;
}

export function buildQueryEventsQuery(input: QueryEventsInput) {
  const builder = clix(UTC.timezone)
    .select<IClickhouseEvent>([eventRow()])
    .from('analytics.events')
    .rawWhere(sql`project_id = ${input.projectId}`);

  if (input.sessionId) {
    builder.rawWhere(sql`session_id = ${input.sessionId}::text`);
  }

  if (input.profileId) {
    builder.rawWhere(sql`profile_id = ${input.profileId}::text`);
  }

  if (input.profileIds?.length) {
    builder.rawWhere(sql`profile_id = ANY(${input.profileIds}::text[])`);
  }

  if (input.eventNames?.length) {
    builder.rawWhere(sql`name = ANY(${input.eventNames}::text[])`);
  }

  const equals: [column: string, value: string | undefined][] = [
    ['path', input.path],
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

  if (input.properties) {
    for (const [key, value] of Object.entries(input.properties)) {
      builder.rawWhere(
        sql`COALESCE(properties ->> ${key}::text, '') = ${value}::text`
      );
    }
  }

  // Skip the default 30-day date filter when sessionId is set — a
  // session id is unique and narrow enough to query directly. Without
  // this, an older session's events would be silently excluded.
  if (!input.sessionId || input.startDate || input.endDate) {
    // The default window ends at today 00:00 UTC, as it always did.
    const { startDate: start, endDate: end } = resolveDateRange(
      input.startDate,
      input.endDate
    );
    builder.where('created_at', 'BETWEEN', [
      clix.datetime(start),
      clix.datetime(end),
    ]);
  }

  if (input.filters?.length) {
    // Only cohort / group.* / profile.* / session.* names apply here.
    for (const clause of prefixedFilterClauses(input.filters, {
      ...UTC,
      projectId: input.projectId,
      table: 'events',
    })) {
      builder.rawWhere(clause);
    }
  }

  // Without an explicit order a bare LIMIT hands back an arbitrary slice of
  // the window, not the newest.
  return builder.orderBy('created_at', 'DESC').limit(input.limit ?? 20);
}

export async function queryEventsCore(
  input: QueryEventsInput
): Promise<IClickhouseEvent[]> {
  return buildQueryEventsQuery(input).execute();
}
