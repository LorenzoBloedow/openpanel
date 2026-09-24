import { fileURLToPath } from 'node:url';
import type { IChartEventFilter, IChartRange, IInterval } from '@openpanel/validation';

import { toChDateTime } from '../../fixtures/analytics-dataset';
import type { GoldenCase, GoldenContext, GoldenProjectKey } from '../harness';
import { FILTERS } from './common';
import { pid, ranked } from './pages.cases';

/**
 * Analytics queries written inline in the tRPC routers, called through
 * appRouter.createCaller like the dashboard does.
 *
 * @openpanel/db does not depend on @openpanel/trpc, so the router is loaded
 * at run time from its path (a literal import would pull the trpc sources
 * into this package's typecheck).
 */
const TRPC_ROOT = fileURLToPath(new URL('../../../../trpc/src/root.ts', import.meta.url));

const GOLDEN_USER_ID = 'golden-user';

type Procedure = (input: unknown) => Promise<unknown>;
type RouterCaller = Record<string, Record<string, Procedure>>;

let appRouterPromise: Promise<{ createCaller: (ctx: unknown) => RouterCaller }> | undefined;

async function loadRouter() {
  appRouterPromise ??= import(/* @vite-ignore */ TRPC_ROOT).then(
    (module: { appRouter: { createCaller: (ctx: unknown) => RouterCaller } }) => module.appRouter,
  );
  return appRouterPromise;
}

/**
 * Calls `procedure` ('router.name') as a signed-in member of the project.
 *
 * No user/member rows exist for the golden organizations, so read access is
 * granted through the access check's own per-process memo
 * (getProjectAccess.set), right before each call since memo entries live 60s.
 */
async function call<T = unknown>(
  project: GoldenProjectKey,
  procedure: string,
  input: Record<string, unknown>,
): Promise<T> {
  const [appRouter, { getProjectAccess }] = await Promise.all([
    loadRouter(),
    import('../../../src/services/access.service'),
  ]);
  await getProjectAccess.set({ userId: GOLDEN_USER_ID, projectId: pid(project) })({
    level: 'read',
  });
  const caller = appRouter.createCaller({
    session: { userId: GOLDEN_USER_ID, session: { id: 'golden-session' } },
    req: { log: { info: () => undefined } },
    res: {},
    cookies: {},
    setCookie: () => undefined,
  });
  const [routerName, procedureName] = procedure.split('.') as [string, string];
  const fn = caller[routerName]?.[procedureName];
  if (!fn) {
    throw new Error(`no procedure ${procedure}`);
  }
  return (await fn(input)) as T;
}

const MINUTE = 60_000;

interface Row {
  [key: string]: unknown;
}

const text = (...values: unknown[]) => values.map((value) => String(value ?? '')).join('|');
const byCount = (row: Row) => row.count;

/**
 * The places of the events in the realtime window (the last 30 minutes), as
 * the dashboard's map sends them to mapBadgeDetails.
 */
function recentLocations(ctx: GoldenContext, project: GoldenProjectKey) {
  const since = toChDateTime(ctx.anchor.getTime() - 30 * MINUTE);
  const places = new Map<string, Record<string, unknown>>();
  for (const event of ctx.datasets[project].events) {
    if (event.created_at >= since) {
      places.set(text(event.country, event.city), {
        country: event.country,
        city: event.city,
        ...(event.latitude === null ? {} : { lat: event.latitude }),
        ...(event.longitude === null ? {} : { long: event.longitude }),
      });
    }
  }
  return [...places.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, place]) => place);
}

interface BadgeDetails {
  summary: Row;
  topReferrers: Row[];
  topPaths: Row[];
  topEvents: Row[];
  recentProfiles: Row[];
}

function mapBadgeCase(
  project: GoldenProjectKey,
  detailScope: 'country' | 'city' | 'coordinate' | 'merged',
): GoldenCase {
  return {
    name: `realtime.mapBadgeDetails ${project} ${detailScope}`,
    run: async (ctx) => {
      const locations = recentLocations(ctx, project);
      const result = await call<BadgeDetails>(project, 'realtime.mapBadgeDetails', {
        projectId: pid(project),
        detailScope,
        locations,
      });
      return {
        locations,
        summary: result.summary,
        topReferrers: ranked(result.topReferrers, byCount, (row) => text(row.referrerName), 3),
        topPaths: ranked(result.topPaths, byCount, (row) => text(row.origin, row.path), 3),
        topEvents: ranked(result.topEvents, byCount, (row) => text(row.name), 3),
        recentProfiles: ranked(
          result.recentProfiles,
          (row) => row.createdAt,
          (row) => text(row.sessionId),
          8,
        ),
      };
    },
  };
}

function realtimeListCase(
  project: GoldenProjectKey,
  name: 'paths' | 'referrals' | 'geo',
  tieBreak: (row: Row) => string,
): GoldenCase {
  return {
    name: `realtime.${name} ${project}`,
    run: async () =>
      ranked(
        await call<Row[]>(project, `realtime.${name}`, { projectId: pid(project) }),
        byCount,
        tieBreak,
        50,
      ),
  };
}

function statsCase(
  project: GoldenProjectKey,
  range: IChartRange,
  interval: IInterval,
  filters: IChartEventFilter[] = [],
  label = '',
): GoldenCase {
  return {
    name: `overview.stats ${project} ${range} ${interval}${label ? ` ${label}` : ''}`,
    run: () =>
      call(project, 'overview.stats', { projectId: pid(project), range, interval, filters }),
    // Internal alias of the metrics query (see harness.ts).
    ignoreKeys: ['_avg_session_duration'],
  };
}

function overviewTopPagesCase(
  project: GoldenProjectKey,
  range: IChartRange,
  mode: 'page' | 'entry' | 'exit' | 'bot',
): GoldenCase {
  return {
    name: `overview.topPages ${project} ${range} ${mode}`,
    run: async () =>
      ranked(
        await call<Row[]>(project, 'overview.topPages', {
          projectId: pid(project),
          range,
          mode,
          filters: [],
        }),
        (row) => row.sessions,
        (row) => text(row.origin, row.path),
        1000,
      ),
  };
}

function referrerSpikesCase(
  project: GoldenProjectKey,
  range: IChartRange,
  interval: IInterval,
): GoldenCase {
  return {
    name: `overview.getReferrerSpikes ${project} ${range} ${interval}`,
    run: () =>
      call(project, 'overview.getReferrerSpikes', {
        projectId: pid(project),
        range,
        interval,
        filters: [],
      }),
  };
}

/** The first session in which an identified user logs in part-way. */
function midSessionLogin(ctx: GoldenContext, project: GoldenProjectKey) {
  const profilesBySession = new Map<string, Set<string>>();
  for (const event of ctx.datasets[project].events) {
    if (event.name === 'session_start' || event.name === 'session_end') {
      continue;
    }
    const profiles = profilesBySession.get(event.session_id) ?? new Set<string>();
    profiles.add(event.profile_id === event.device_id ? 'device' : 'user');
    profilesBySession.set(event.session_id, profiles);
  }
  const session = ctx.datasets[project].sessions.find(
    (candidate) => profilesBySession.get(candidate.id)?.size === 2,
  );
  if (!session) {
    throw new Error('the dataset has no session with a mid-session login');
  }
  return session;
}

function chDate(value: string) {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

const profileTie = (row: Row) => text(row.id);

export const group = 'routers';

export const cases: GoldenCase[] = [
  // --- realtime: windows from the (frozen) JS clock, 30 minutes back -------
  realtimeListCase('sthlm', 'paths', (row) => text(row.origin, row.path)),
  realtimeListCase('utc', 'paths', (row) => text(row.origin, row.path)),
  realtimeListCase('sthlm', 'referrals', (row) => text(row.referrer_name)),
  realtimeListCase('sthlm', 'geo', (row) => text(row.country, row.city)),
  {
    name: 'realtime.activeSessions sthlm',
    run: async () =>
      ranked(
        await call<Row[]>('sthlm', 'realtime.activeSessions', { projectId: pid('sthlm') }),
        (row) => row.createdAt,
        (row) => text(row.sessionId, row.name, row.path),
        50,
      ),
  },
  // Coordinate scope matches on toDecimal64(Float32 coordinate, 4), which
  // truncates: Bengaluru's 77.5946 becomes 77.5945 and no longer matches.
  mapBadgeCase('sthlm', 'coordinate'),
  mapBadgeCase('sthlm', 'country'),
  mapBadgeCase('ny', 'city'),
  mapBadgeCase('utc', 'merged'),

  // --- overview: router logic around the overview service -----------------
  statsCase('sthlm', '7d', 'day'),
  statsCase('ny', '30d', 'day', FILTERS.countrySE, 'countrySE'),
  statsCase('utc', 'today', 'hour'),
  referrerSpikesCase('sthlm', '3m', 'week'),
  overviewTopPagesCase('sthlm', '30d', 'page'),
  overviewTopPagesCase('sthlm', '30d', 'entry'),
  overviewTopPagesCase('utc', '30d', 'bot'),

  // --- event ------------------------------------------------------------------
  {
    name: 'event.bots sthlm first page',
    run: () => call('sthlm', 'event.bots', { projectId: pid('sthlm') }),
  },
  {
    name: 'event.bots ny page 2 of 2',
    run: () => call('ny', 'event.bots', { projectId: pid('ny'), cursor: 1, limit: 2 }),
  },
  ...(['sthlm', 'ny'] as const).map((project) => ({
    name: `event.origin ${project}`,
    run: async () =>
      ranked(
        await call<Row[]>(project, 'event.origin', { projectId: pid(project) }),
        byCount,
        (row) => text(row.origin),
        3,
      ),
  })),
  {
    name: 'event.pages ny 30d search docs take 2',
    run: async () => {
      const input = { projectId: pid('ny'), range: '30d', interval: 'day', search: 'docs' };
      return ranked(
        await call<Row[]>('ny', 'event.pages', { ...input, take: 2 }),
        (row) => row.sessions,
        (row) => text(row.origin, row.path),
        2,
        await call<Row[]>('ny', 'event.pages', input),
      );
    },
  },
  {
    name: 'event.previousPages sthlm 7d',
    run: async () =>
      ranked(
        await call<Row[]>('sthlm', 'event.previousPages', {
          projectId: pid('sthlm'),
          range: '7d',
          interval: 'day',
        }),
        (row) => row.sessions,
        (row) => text(row.origin, row.path),
      ),
  },
  {
    name: 'event.pageTimeseries ny 30d day /pricing',
    run: () =>
      call('ny', 'event.pageTimeseries', {
        projectId: pid('ny'),
        range: '30d',
        interval: 'day',
        origin: 'https://example.com',
        path: '/pricing',
      }),
  },
  {
    // The router copies the identified profile onto the session's anonymous
    // events ("* First name").
    name: 'event.events sthlm session with a mid-session login',
    run: async (ctx) => {
      const session = midSessionLogin(ctx, 'sthlm');
      return call('sthlm', 'event.events', {
        projectId: pid('sthlm'),
        sessionId: session.id,
        startDate: new Date(chDate(session.created_at).getTime() - MINUTE),
        endDate: new Date(chDate(session.ended_at).getTime() + MINUTE),
      });
    },
  },

  // --- profile ----------------------------------------------------------------
  {
    name: 'profile.activity sthlm user-alice',
    run: () =>
      call('sthlm', 'profile.activity', { projectId: pid('sthlm'), profileId: 'user-alice' }),
  },
  ...(
    [
      ['sthlm', 'user-alice'],
      ['ny', 'dev-gold-010'],
    ] as const
  ).map(([project, profileId]) => ({
    name: `profile.popularRoutes ${project} ${profileId}`,
    run: async () =>
      ranked(
        await call<Row[]>(project, 'profile.popularRoutes', { projectId: pid(project), profileId }),
        byCount,
        (row) => text(row.path),
        10,
      ),
  })),
  {
    name: 'profile.mostEvents utc user-bob',
    run: async () =>
      ranked(
        await call<Row[]>('utc', 'profile.mostEvents', {
          projectId: pid('utc'),
          profileId: 'user-bob',
        }),
        byCount,
        (row) => text(row.name),
      ),
  },
  {
    // Sorted by length in JS; equal lengths keep the (arbitrary) SQL order.
    name: 'profile.properties sthlm',
    run: async () =>
      ranked(
        await call<string[]>('sthlm', 'profile.properties', { projectId: pid('sthlm') }),
        (key) => key.length,
        (key) => key,
      ),
  },
  ...(
    [
      ['sthlm', 'properties.plan'],
      ['ny', 'properties.company.name'],
      ['utc', 'email'],
    ] as const
  ).map(([project, property]) => ({
    name: `profile.values ${project} ${property}`,
    run: async () => {
      const { values } = await call<{ values: string[] }>(project, 'profile.values', {
        projectId: pid(project),
        property,
      });
      return ranked(values, (value) => value.length, (value) => value);
    },
  })),
  {
    name: 'profile.powerUsers sthlm',
    run: async () => {
      const result = await call<{ data: Row[]; meta: Row }>('sthlm', 'profile.powerUsers', {
        projectId: pid('sthlm'),
      });
      return { meta: result.meta, data: ranked(result.data, byCount, profileTie, 50) };
    },
  },
  {
    name: 'profile.powerUsers ny take 5',
    run: async () => {
      const powerUsers = (take: number) =>
        call<{ data: Row[]; meta: Row }>('ny', 'profile.powerUsers', { projectId: pid('ny'), take });
      const [result, uncut] = await Promise.all([powerUsers(5), powerUsers(1000)]);
      return { meta: result.meta, data: ranked(result.data, byCount, profileTie, 5, uncut.data) };
    },
  },

  // --- group ------------------------------------------------------------------
  ...(
    [
      ['sthlm', 'acme'],
      ['utc', 'team-growth'],
    ] as const
  ).map(([project, id]) => ({
    name: `group.metrics ${project} ${id}`,
    run: () => call(project, 'group.metrics', { projectId: pid(project), id }),
  })),
  {
    name: 'group.activity sthlm globex',
    run: () => call('sthlm', 'group.activity', { projectId: pid('sthlm'), id: 'globex' }),
  },
  {
    // Window and fill from ClickHouse's now(), by day.
    name: 'group.memberGrowth sthlm acme',
    run: () => call('sthlm', 'group.memberGrowth', { projectId: pid('sthlm'), id: 'acme' }),
  },
  {
    name: 'group.mostEvents utc globex',
    run: async () =>
      ranked(
        await call<Row[]>('utc', 'group.mostEvents', { projectId: pid('utc'), id: 'globex' }),
        byCount,
        (row) => text(row.name),
        10,
      ),
  },
  {
    name: 'group.popularRoutes ny globex',
    run: async () =>
      ranked(
        await call<Row[]>('ny', 'group.popularRoutes', { projectId: pid('ny'), id: 'globex' }),
        byCount,
        (row) => text(row.path),
        10,
      ),
  },

  // --- gsc: search/AI engines from sessions, and the stored GSC rows ----------
  ...(
    [
      ['sthlm', '30d'],
      ['utc', '3m'],
    ] as const
  ).map(([project, range]) => ({
    name: `gsc.getSearchEngines ${project} ${range}`,
    run: async () => {
      const result = await call<{ engines: Row[] }>(project, 'gsc.getSearchEngines', {
        projectId: pid(project),
        range,
      });
      return {
        ...result,
        engines: ranked(result.engines, (row) => row.sessions, (row) => text(row.name), 10),
      };
    },
  })),
  {
    name: 'gsc.getAiEngines sthlm 30d',
    run: () => call('sthlm', 'gsc.getAiEngines', { projectId: pid('sthlm'), range: '30d' }),
  },
  {
    name: 'gsc.getOverview ny 30d week',
    run: () =>
      call('ny', 'gsc.getOverview', { projectId: pid('ny'), range: '30d', interval: 'week' }),
  },
  {
    name: 'gsc.getPreviousOverview sthlm 7d day',
    run: () =>
      call('sthlm', 'gsc.getPreviousOverview', {
        projectId: pid('sthlm'),
        range: '7d',
        interval: 'day',
      }),
  },
  {
    name: 'gsc.getPreviousOverview utc 30d week',
    run: () =>
      call('utc', 'gsc.getPreviousOverview', {
        projectId: pid('utc'),
        range: '30d',
        interval: 'week',
      }),
  },
  {
    name: 'gsc.getPages ny 30d',
    run: async () =>
      ranked(
        await call<Row[]>('ny', 'gsc.getPages', { projectId: pid('ny'), range: '30d' }),
        (row) => row.clicks,
        (row) => text(row.page),
        100,
      ),
  },
  {
    name: 'gsc.getQueries utc 30d limit 2',
    run: async () => {
      const queries = (limit: number) =>
        call<Row[]>('utc', 'gsc.getQueries', { projectId: pid('utc'), range: '30d', limit });
      return ranked(
        await queries(2),
        (row) => row.clicks,
        (row) => text(row.query),
        2,
        await queries(1000),
      );
    },
  },

  // --- chart: inline queries outside the chart engine ------------------------
  {
    // Windows from ClickHouse's now() (days and months back from the capture).
    name: 'chart.projectCard sthlm',
    run: () => call('sthlm', 'chart.projectCard', { projectId: pid('sthlm') }),
  },
  {
    // `count` is count(name) over distinct_event_names_mv rows (one row per
    // project/name/insert block), not an event count.
    name: 'chart.events utc',
    run: () => call('utc', 'chart.events', { projectId: pid('utc') }),
  },
  ...(
    [
      ['sthlm', '*'],
      ['ny', 'button_click'],
    ] as const
  ).map(([project, event]) => ({
    // Sorted by length in JS; equal lengths keep the SQL order.
    name: `chart.properties ${project} ${event}`,
    run: async () =>
      ranked(
        await call<string[]>(project, 'chart.properties', { projectId: pid(project), event }),
        (key) => key.length,
        (key) => key,
      ),
  })),
  ...(
    [
      // Event properties: ordered by recency (then value) in SQL.
      ['sthlm', 'button_click', 'properties.button', false],
      ['ny', '*', 'properties.__query.utm_source', false],
      // Everything else is sorted by length in JS.
      ['sthlm', '*', 'profile.properties.plan', true],
      ['ny', '*', 'group.name', true],
      ['utc', '*', 'country', true],
      ['utc', 'screen_view', 'path', true],
      ['sthlm', 'screen_view', 'referrer_name', true],
    ] as const
  ).map(([project, event, property, byLength]) => ({
    name: `chart.values ${project} ${event} ${property}`,
    run: async () => {
      const { values } = await call<{ values: string[] }>(project, 'chart.values', {
        projectId: pid(project),
        event,
        property,
      });
      return byLength ? ranked(values, (value) => value.length, (value) => value) : values;
    },
  })),
  ...(
    [
      [1, false],
      [0, true],
    ] as const
  ).map(([stepIndex, showDropoffs]) => ({
    // The router's own query over the funnel builder's CTE (levels, LIMIT
    // 1000), then the profiles.
    name: `chart.getFunnelProfiles sthlm 30d screen_view>button_click step ${stepIndex}${showDropoffs ? ' dropoffs' : ''}`,
    run: () =>
      call('sthlm', 'chart.getFunnelProfiles', {
        projectId: pid('sthlm'),
        range: '30d',
        series: [
          { type: 'event', name: 'screen_view', segment: 'event', filters: [] },
          { type: 'event', name: 'button_click', segment: 'event', filters: [] },
        ],
        stepIndex,
        showDropoffs,
      }),
    unordered: [''],
  })),
  {
    name: 'chart.getProfiles sthlm screen_view day 5 days ago',
    run: async (ctx) =>
      call('sthlm', 'chart.getProfiles', {
        projectId: pid('sthlm'),
        date: new Date(
          Date.UTC(
            ctx.anchor.getUTCFullYear(),
            ctx.anchor.getUTCMonth(),
            ctx.anchor.getUTCDate() - 5,
          ),
        ).toISOString(),
        interval: 'day',
        series: [{ type: 'event', name: 'screen_view', segment: 'event', filters: [] }],
      }),
    unordered: [''],
  },
  {
    name: 'chart.getProfiles ny button_click week breakdown variant',
    run: async (ctx) => {
      // A week bucket as the chart returns it: the Sunday (toStartOfWeek).
      const tenDaysAgo = new Date(
        Date.UTC(ctx.anchor.getUTCFullYear(), ctx.anchor.getUTCMonth(), ctx.anchor.getUTCDate() - 10),
      );
      const weekStart = new Date(tenDaysAgo.getTime() - tenDaysAgo.getUTCDay() * 86_400_000);
      return call('ny', 'chart.getProfiles', {
        projectId: pid('ny'),
        date: weekStart.toISOString(),
        interval: 'week',
        series: [
          {
            type: 'event',
            name: 'button_click',
            segment: 'event',
            filters: [{ id: 'r1', name: 'properties.button', operator: 'is', value: ['cta'] }],
          },
        ],
        breakdowns: { 'properties.variant': 'a' },
      });
    },
    unordered: [''],
  },
];
