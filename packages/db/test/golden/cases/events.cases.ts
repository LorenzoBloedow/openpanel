import type { IChartEventFilter } from '@openpanel/validation';

import { DATASET_COHORTS, type EventRow } from '../../fixtures/analytics-dataset';
import {
  eventService,
  getEventList,
  getEventPropertyValuesCore,
  getEventsCount,
  getTopEventNames,
  getTopPages,
  listEventNamesCore,
  listEventPropertiesCore,
  queryEventsCore,
  type GetEventListOptions,
  type IClickhouseEvent,
  type IServiceEvent,
} from '../../../src/services/event.service';
import { GOLDEN_PROJECTS, type GoldenCase, type GoldenContext, type GoldenProjectKey } from '../harness';

// --- helpers shared by the entity groups (events, sessions, profiles, groups, cohorts)

export const DAY = 86_400_000;

export function daysAgo(ctx: GoldenContext, days: number) {
  return new Date(ctx.anchor.getTime() - days * DAY);
}

/** 'YYYY-MM-DD' (UTC) of `days` before the anchor. */
export function dayString(ctx: GoldenContext, days: number) {
  return daysAgo(ctx, days).toISOString().slice(0, 10);
}

/** The dataset's 'YYYY-MM-DD HH:MM:SS.mmm' UTC text as a Date. */
export function chDate(value: string) {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

export function pid(project: GoldenProjectKey) {
  return GOLDEN_PROJECTS[project].id;
}

let filterSeq = 0;
/** A report filter as the dashboard sends it. */
export function filter(
  name: string,
  operator: IChartEventFilter['operator'],
  value: IChartEventFilter['value'],
  extra: Partial<IChartEventFilter> = {},
): IChartEventFilter {
  filterSeq++;
  return { id: `e${filterSeq}`, name, operator, value, ...extra };
}

export function cohortFilter(
  operator: 'inCohort' | 'notInCohort',
  cohortId: string,
): IChartEventFilter {
  return filter('cohort', operator, [], { cohortId });
}

/** Run `run` for every labelled input; one case covers a family of inputs. */
export async function each<T>(
  inputs: readonly (readonly [string, T])[],
  run: (input: T) => Promise<unknown>,
) {
  const out: Record<string, unknown> = {};
  for (const [label, input] of inputs) {
    out[label] = await run(input);
  }
  return out;
}

function keyText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : JSON.stringify(value ?? null);
}

function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rows that tie on the ORDER BY key come back in whatever order the engine
 * reads them. Sort each run of equal keys by `tieBreak` but keep the runs in
 * the order returned, so a wrong ORDER BY still fails while tie order doesn't.
 */
export function orderTies<T>(
  rows: T[],
  key: (row: T) => unknown,
  tieBreak: (row: T) => string,
): T[] {
  const out: T[] = [];
  let run: T[] = [];
  const flush = () => {
    out.push(...run.sort((a, b) => compareText(tieBreak(a), tieBreak(b))));
    run = [];
  };
  for (const row of rows) {
    if (run.length > 0 && keyText(key(run[0]!)) !== keyText(key(row))) {
      flush();
    }
    run.push(row);
  }
  flush();
  return out;
}

/**
 * A LIMIT/OFFSET page of a list ordered by `key`. Rows whose key equals the
 * key of the row just before the page (`before`) or just after it (`after`)
 * belong to a tie that crosses the page edge: which of the tied rows land on
 * this page is up to the engine, so they are reduced to their key.
 */
export function stablePage<T>(
  rows: T[],
  key: (row: T) => unknown,
  tieBreak: (row: T) => string,
  edges: { before?: unknown; after?: unknown },
  view: (row: T) => unknown = (row) => row,
): unknown[] {
  const before = edges.before === undefined ? undefined : keyText(edges.before);
  const after = edges.after === undefined ? undefined : keyText(edges.after);
  return orderTies(rows, key, tieBreak).map((row) => {
    const text = keyText(key(row));
    return text === before || text === after ? { tiedAtPageEdge: key(row) } : view(row);
  });
}

/**
 * `fetch(limit)` returns the first `limit` rows ordered by `key`; the extra
 * row of `fetch(limit + 1)` tells whether a tie crosses the limit.
 */
export async function stableLimit<T>(
  fetch: (limit: number) => Promise<T[]>,
  limit: number,
  key: (row: T) => unknown,
  tieBreak: (row: T) => string,
  view?: (row: T) => unknown,
) {
  const [rows, extended] = await Promise.all([fetch(limit), fetch(limit + 1)]);
  const next = extended[limit];
  return stablePage(rows, key, tieBreak, { after: next === undefined ? undefined : key(next) }, view);
}

// --- events -------------------------------------------------------------------

/** The select the dashboard's event list (trpc event.events) sends. */
const TRPC_EVENTS_SELECT = {
  city: true,
  path: true,
  duration: true,
  projectId: false,
  revenue: true,
} as const;

/** The public export API: no profile/meta hydration. */
const EXPORT_SELECT = { profile: false, meta: false } as const;

const COHORT = DATASET_COHORTS;

type ListFilter = readonly [string, { filters: IChartEventFilter[]; select?: GetEventListOptions['select'] }];

const COLUMN_FILTERS: ListFilter[] = [
  ['country is SE', { filters: [filter('country', 'is', ['SE'])] }],
  ['path contains docs', { filters: [filter('path', 'contains', ['docs'])] }],
  ['os isNot iOS,Android', { filters: [filter('os', 'isNot', ['iOS', 'Android'])] }],
  ['browser startsWith Chrome', { filters: [filter('browser', 'startsWith', ['Chrome'])] }],
  ['city endsWith holm', { filters: [filter('city', 'endsWith', ['holm'])] }],
  ['path regex ^/docs/', { filters: [filter('path', 'regex', ['^/docs/'])] }],
  ['referrer isNull', { filters: [filter('referrer', 'isNull', [])], select: { referrer: true } }],
  ['region isNotNull', { filters: [filter('region', 'isNotNull', [])], select: { region: true } }],
  ['referrerName alias is Google', { filters: [filter('referrerName', 'is', ['Google'])], select: { referrerName: true } }],
  ['duration gt 60000 and name is screen_view', { filters: [filter('duration', 'gt', ['60000']), filter('name', 'is', ['screen_view'])] }],
  ['country is SE and device is mobile', { filters: [filter('country', 'is', ['SE']), filter('device', 'is', ['mobile'])], select: { device: true } }],
];

const withProperties = (label: string, filters: IChartEventFilter[]): ListFilter => [
  label,
  { filters, select: { properties: true } },
];

const PROPERTY_FILTERS: ListFilter[] = [
  withProperties('bare utm_source is reddit', [filter('utm_source', 'is', ['reddit'])]),
  withProperties('utm_campaign is spring_launch', [filter('properties.__query.utm_campaign', 'is', ['spring_launch'])]),
  withProperties('button is cta,nav', [filter('properties.button', 'is', ['cta', 'nav'])]),
  withProperties('price gt 5 (text to number)', [filter('properties.price', 'gt', ['5'])]),
  withProperties('price gte 19 (typed number)', [filter('properties.price', 'gte', [19], { type: 'number' })]),
  withProperties('title with quote and unicode', [filter('properties.__title', 'is', ["Hello, world — it's here"])]),
  withProperties('href doesNotContain github on link_out', [
    filter('properties.href', 'doesNotContain', ['github']),
    filter('name', 'is', ['link_out']),
  ]),
  withProperties('item.sku startsWith sku and qty lte 2', [
    filter('properties.item.sku', 'startsWith', ['sku']),
    filter('properties.item.qty', 'lte', ['2']),
  ]),
];

const PROFILE_FILTERS: ListFilter[] = [
  ['has_profile true', { filters: [filter('has_profile', 'is', ['true'])] }],
  ['profile plan is pro', { filters: [filter('profile.properties.plan', 'is', ['pro'])] }],
  ['profile company.name is acme', { filters: [filter('profile.properties.company.name', 'is', ['acme'])] }],
  ['profile age gt 30', { filters: [filter('profile.properties.age', 'gt', ['30'])] }],
  // Bare profile columns are not event columns: the filter is dropped.
  ['profile email endsWith .se (dropped)', { filters: [filter('profile.email', 'endsWith', ['.se'])] }],
];

const GROUP_AND_COHORT_FILTERS: ListFilter[] = [
  ['group name is Acme Inc', { filters: [filter('group.name', 'is', ['Acme Inc'])], select: { groups: true } }],
  ['group plan is pro', { filters: [filter('group.properties.plan', 'is', ['pro'])], select: { groups: true } }],
  ['inCohort powerUsers', { filters: [cohortFilter('inCohort', COHORT.powerUsers.id)] }],
  ['notInCohort freePlan and has_profile', { filters: [cohortFilter('notInCohort', COHORT.freePlan.id), filter('has_profile', 'is', ['true'])] }],
];

/**
 * getEventList orders by created_at DESC, id ASC. ClickHouse compares UUIDs by
 * their second half, so the id tie-break is engine-specific: ties are sorted
 * by the id text instead, and ties crossing the page edge are masked.
 */
async function stableEventList(options: GetEventListOptions) {
  const rows = await getEventList(options);
  const key = (event: IServiceEvent) => event.createdAt;
  const tieBreak = (event: IServiceEvent) => event.id;
  if (typeof options.cursor === 'number') {
    const offset = options.cursor * options.take;
    const neighbour = async (at: number) =>
      at < 0 ? undefined : (await getEventList({ ...options, take: 1, cursor: at }))[0]?.createdAt;
    return stablePage(rows, key, tieBreak, {
      before: await neighbour(offset - 1),
      after: await neighbour(offset + options.take),
    });
  }
  const extended = await getEventList({ ...options, take: options.take + 1 });
  return stablePage(rows, key, tieBreak, { after: extended[options.take]?.createdAt });
}

/** Count and newest rows of the last 14 days for each filter (the export shape). */
function filteredLists(ctx: GoldenContext, inputs: ListFilter[]) {
  return each(inputs, async ({ filters, select }) => {
    const scope = { projectId: pid('sthlm'), startDate: daysAgo(ctx, 14), endDate: ctx.anchor, filters };
    return {
      count: await getEventsCount(scope),
      items: await stableEventList({ ...scope, take: 8, select: { ...EXPORT_SELECT, ...select } }),
    };
  });
}

function latestEvent(ctx: GoldenContext, project: GoldenProjectKey, match: (event: EventRow) => boolean) {
  const event = ctx.datasets[project].events.findLast(match);
  if (!event) {
    throw new Error(`no matching event in ${project}`);
  }
  return event;
}

function isIdentified(event: { profile_id: string; device_id: string }) {
  return event.profile_id !== event.device_id;
}

const compactRow = (row: IClickhouseEvent) => ({
  id: row.id,
  name: row.name,
  created_at: row.created_at,
  profile_id: row.profile_id,
  session_id: row.session_id,
  groups: row.groups,
});

/** queryEventsCore rows: ORDER BY created_at DESC LIMIT n, ties broken by id. */
function queryEvents(
  input: Parameters<typeof queryEventsCore>[0] & { limit: number },
  view?: (row: IClickhouseEvent) => unknown,
) {
  return stableLimit(
    (limit) => queryEventsCore({ ...input, limit }),
    input.limit,
    (row) => row.created_at,
    (row) => row.id,
    view,
  );
}

/** eventService.getList orders by created_at only (ties broken by id here). */
async function serviceList(input: Parameters<typeof eventService.getList>[0] & { limit: number }) {
  const result = await eventService.getList(input);
  const items = await stableLimit(
    async (limit) => (await eventService.getList({ ...input, limit })).items,
    input.limit,
    (item) => item.createdAt,
    (item) => item.id,
  );
  return { items, meta: result.meta };
}

export const group = 'events';

export const cases: GoldenCase[] = [
  // --- getEventList: windows and cursors (trpc event.events, export API) -------------
  {
    name: 'getEventList sthlm default window (trpc select)',
    run: () => stableEventList({ projectId: pid('sthlm'), take: 30, filters: [], select: TRPC_EVENTS_SELECT }),
  },
  {
    name: 'getEventList ny default window take 10',
    run: () => stableEventList({ projectId: pid('ny'), take: 10, select: TRPC_EVENTS_SELECT }),
  },
  {
    name: 'getEventList sthlm date cursor 3 days ago',
    run: (ctx) =>
      stableEventList({ projectId: pid('sthlm'), take: 30, cursor: daysAgo(ctx, 3), select: EXPORT_SELECT }),
  },
  {
    name: 'getEventList utc second page from meta.next cursor',
    run: async () => {
      const options = { projectId: pid('utc'), take: 15, select: EXPORT_SELECT };
      // The dashboard passes meta.next (the last row's createdAt as an ISO
      // string) back as the cursor; the last key is the same on any engine.
      const next = (await getEventList(options)).at(-1)?.createdAt;
      return {
        first: await stableEventList(options),
        second: next ? await stableEventList({ ...options, cursor: new Date(next.toISOString()) }) : null,
      };
    },
  },
  {
    name: 'getEventList sthlm date cursor expands the window when empty',
    // 100 days back there are no events: the window doubles until it reaches
    // the DST clusters in March.
    run: (ctx) =>
      stableEventList({ projectId: pid('sthlm'), take: 10, cursor: daysAgo(ctx, 100), select: EXPORT_SELECT }),
  },
  {
    name: 'getEventList sthlm explicit range 7d revenue+purchase (trpc select)',
    run: (ctx) =>
      stableEventList({
        projectId: pid('sthlm'),
        take: 50,
        startDate: daysAgo(ctx, 7),
        endDate: ctx.anchor,
        events: ['revenue', 'purchase'],
        filters: [],
        select: { ...TRPC_EVENTS_SELECT, properties: true },
      }),
  },
  {
    name: 'getEventList ny explicit DST range',
    run: () =>
      stableEventList({
        projectId: pid('ny'),
        take: 40,
        startDate: new Date('2026-03-08T05:00:00Z'),
        endDate: new Date('2026-03-08T10:00:00Z'),
        select: EXPORT_SELECT,
      }),
  },
  {
    name: 'getEventList sthlm export page 1',
    run: () =>
      stableEventList({ projectId: pid('sthlm'), take: 25, cursor: 0, events: [], select: EXPORT_SELECT }),
  },
  {
    name: 'getEventList sthlm export page 4 with includes',
    run: () =>
      stableEventList({
        projectId: pid('sthlm'),
        take: 25,
        cursor: 3,
        events: ['screen_view', 'button_click'],
        select: {
          ...EXPORT_SELECT,
          properties: true,
          region: true,
          longitude: true,
          latitude: true,
          osVersion: true,
          browserVersion: true,
          model: true,
          brand: true,
          origin: true,
          referrer: true,
          referrerName: true,
          referrerType: true,
          sdkName: true,
          sdkVersion: true,
          revenue: true,
          groups: true,
          importedAt: true,
        },
      }),
  },
  {
    name: 'getEventList empty results',
    run: async () => ({
      // The window doubles up to the 5-year ceiling before giving up.
      unknownSession: await stableEventList({
        projectId: pid('utc'),
        sessionId: 'sess-does-not-exist',
        take: 10,
        select: EXPORT_SELECT,
      }),
      pastTheEnd: await stableEventList({ projectId: pid('ny'), take: 1000, cursor: 5, select: EXPORT_SELECT }),
    }),
  },

  // --- getEventList: scoping --------------------------------------------------------
  {
    name: 'getEventList sthlm profile user-alice (identity stitching)',
    run: () =>
      stableEventList({ projectId: pid('sthlm'), profileId: 'user-alice', take: 30, select: TRPC_EVENTS_SELECT }),
  },
  {
    name: 'getEventList ny profile user-bob 30d export',
    run: (ctx) =>
      stableEventList({
        projectId: pid('ny'),
        profileId: 'user-bob',
        startDate: daysAgo(ctx, 30),
        endDate: ctx.anchor,
        take: 50,
        cursor: 0,
        select: { ...EXPORT_SELECT, groups: true },
      }),
  },
  {
    name: 'getEventList sthlm anonymous device profile',
    run: () =>
      stableEventList({ projectId: pid('sthlm'), profileId: 'dev-gold-001', take: 30, select: EXPORT_SELECT }),
  },
  {
    name: 'getEventList sthlm replay session',
    run: (ctx) =>
      stableEventList({
        projectId: pid('sthlm'),
        sessionId: ctx.datasets.sthlm.replayChunks[0]!.session_id,
        take: 50,
        select: { ...TRPC_EVENTS_SELECT, properties: true },
      }),
  },
  {
    name: 'getEventList ny oldest session (window expands to March)',
    run: (ctx) =>
      stableEventList({
        projectId: pid('ny'),
        sessionId: ctx.datasets.ny.sessions[0]!.id,
        take: 50,
        select: { ...EXPORT_SELECT, properties: true },
      }),
  },
  {
    name: 'getEventList sthlm group acme 7d',
    run: (ctx) =>
      stableEventList({
        projectId: pid('sthlm'),
        groupId: 'acme',
        startDate: daysAgo(ctx, 7),
        endDate: ctx.anchor,
        take: 30,
        select: { ...EXPORT_SELECT, groups: true },
      }),
  },
  {
    name: 'getEventList sthlm cohort powerUsers 7d',
    run: (ctx) =>
      stableEventList({
        projectId: pid('sthlm'),
        cohortId: COHORT.powerUsers.id,
        startDate: daysAgo(ctx, 7),
        endDate: ctx.anchor,
        take: 30,
        select: EXPORT_SELECT,
      }),
  },

  // --- getEventList + getEventsCount: filters -----------------------------------------
  {
    name: 'getEventList sthlm 14d column filters',
    run: (ctx) => filteredLists(ctx, COLUMN_FILTERS),
  },
  {
    name: 'getEventList sthlm 14d property filters',
    run: (ctx) => filteredLists(ctx, PROPERTY_FILTERS),
  },
  {
    name: 'getEventList sthlm 14d profile filters',
    run: (ctx) => filteredLists(ctx, PROFILE_FILTERS),
  },
  {
    name: 'getEventList sthlm 14d group and cohort filters',
    run: (ctx) => filteredLists(ctx, GROUP_AND_COHORT_FILTERS),
  },

  // --- getEventsCount ---------------------------------------------------------------
  {
    name: 'getEventsCount all projects all time',
    run: async () => ({
      sthlm: await getEventsCount({ projectId: pid('sthlm') }),
      ny: await getEventsCount({ projectId: pid('ny') }),
      utc: await getEventsCount({ projectId: pid('utc') }),
    }),
  },
  {
    name: 'getEventsCount sthlm by event name 30d',
    run: (ctx) =>
      each(
        ['session_start', 'screen_view', 'button_click', 'link_out', 'revenue', 'purchase', 'signup', 'session_end', 'nope'].map(
          (name) => [name, name] as const,
        ),
        (name) =>
          getEventsCount({ projectId: pid('sthlm'), events: [name], startDate: daysAgo(ctx, 30), endDate: ctx.anchor }),
      ),
  },
  {
    name: 'getEventsCount ny scopes',
    run: async (ctx) => ({
      // profileId counts the profile's own events only (no stitching).
      profileAlice: await getEventsCount({ projectId: pid('ny'), profileId: 'user-alice' }),
      profileDevice: await getEventsCount({ projectId: pid('ny'), profileId: 'dev-gold-010' }),
      groupGlobex: await getEventsCount({ projectId: pid('ny'), groupId: 'globex' }),
      groupTeam: await getEventsCount({ projectId: pid('ny'), groupId: 'team-growth' }),
      cohortFree: await getEventsCount({ projectId: pid('ny'), cohortId: COHORT.freePlan.id }),
      last24h: await getEventsCount({ projectId: pid('ny'), startDate: daysAgo(ctx, 1), endDate: ctx.anchor }),
      untilWeekAgo: await getEventsCount({ projectId: pid('ny'), endDate: daysAgo(ctx, 7) }),
      sinceWeekAgoClicks: await getEventsCount({
        projectId: pid('ny'),
        startDate: daysAgo(ctx, 7),
        events: ['button_click', 'link_out'],
      }),
    }),
  },

  // --- event names and properties --------------------------------------------------------
  {
    name: 'getTopEventNames / listEventNamesCore',
    run: async () => ({
      sthlm: await getTopEventNames(pid('sthlm')),
      utc: await listEventNamesCore(pid('utc')),
      unknown: await getTopEventNames('golden-none'),
    }),
    // The MV holds one row per name, so count() ties everywhere.
    unordered: ['sthlm', 'utc'],
  },
  {
    name: 'listEventPropertiesCore sthlm',
    run: () => listEventPropertiesCore({ projectId: pid('sthlm') }),
  },
  {
    name: 'listEventPropertiesCore by event',
    run: async () => ({
      nyButtonClick: await listEventPropertiesCore({ projectId: pid('ny'), eventName: 'button_click' }),
      utcPurchase: await listEventPropertiesCore({ projectId: pid('utc'), eventName: 'purchase' }),
      utcUnknown: await listEventPropertiesCore({ projectId: pid('utc'), eventName: 'nope' }),
    }),
  },
  {
    name: 'getEventPropertyValuesCore sthlm',
    run: () =>
      each(
        (
          [
            ['screen_view', '__title'],
            ['button_click', 'price'],
            ['purchase', 'item.sku'],
            ['session_start', '__query.utm_source'],
            ['session_end', '__bounce'],
            ['link_out', 'href'],
            ['revenue', 'order_id'],
            ['screen_view', 'missing'],
          ] as const
        ).map(([eventName, propertyKey]) => [`${eventName} ${propertyKey}`, { eventName, propertyKey }] as const),
        (input) => getEventPropertyValuesCore({ projectId: pid('sthlm'), ...input }),
      ),
  },

  // --- queryEventsCore (insights API / MCP) ---------------------------------------------
  {
    name: 'queryEventsCore sthlm defaults',
    run: () => queryEvents({ projectId: pid('sthlm'), limit: 20 }),
  },
  {
    name: 'queryEventsCore sthlm revenue 7d',
    run: (ctx) =>
      queryEvents({
        projectId: pid('sthlm'),
        eventNames: ['revenue'],
        startDate: dayString(ctx, 7),
        endDate: ctx.anchor.toISOString(),
        limit: 50,
      }),
  },
  {
    name: 'queryEventsCore column filters',
    run: async (ctx) => ({
      nyPricingDesktopSearch: await queryEvents(
        { projectId: pid('ny'), path: '/pricing', device: 'desktop', referrerType: 'search', limit: 30 },
        compactRow,
      ),
      utcGoteborgLinuxFirefox: await queryEvents(
        {
          projectId: pid('utc'),
          country: 'SE',
          city: 'Göteborg',
          os: 'Linux',
          browser: 'Firefox',
          startDate: dayString(ctx, 45),
          limit: 30,
        },
        compactRow,
      ),
      sthlmTwitterSessionEdges: await queryEvents(
        {
          projectId: pid('sthlm'),
          referrer: 'https://t.co/',
          referrerName: 'Twitter',
          eventNames: ['session_start', 'session_end'],
          limit: 25,
        },
        compactRow,
      ),
    }),
  },
  {
    name: 'queryEventsCore sthlm properties',
    run: (ctx) =>
      queryEvents({
        projectId: pid('sthlm'),
        properties: { button: 'cta', variant: 'b', '__query.utm_source': 'reddit' },
        startDate: dayString(ctx, 60),
        limit: 40,
      }),
  },
  {
    name: 'queryEventsCore ny session date scope',
    run: async (ctx) => {
      // A session from a few days back: the default date scope is skipped for
      // a session id, and an explicit one still applies.
      const sessionId = ctx.datasets.ny.sessions.findLast(
        (session) => chDate(session.created_at).getTime() < daysAgo(ctx, 3).getTime(),
      )!.id;
      return {
        unscoped: await queryEvents({ projectId: pid('ny'), sessionId, limit: 100 }),
        inScope: await queryEvents({ projectId: pid('ny'), sessionId, startDate: dayString(ctx, 30), limit: 100 }, compactRow),
        outOfScope: await queryEvents({ projectId: pid('ny'), sessionId, endDate: dayString(ctx, 20), limit: 100 }),
        oldSession: await queryEvents({ projectId: pid('ny'), sessionId: ctx.datasets.ny.sessions[1]!.id, limit: 100 }, compactRow),
      };
    },
  },
  {
    name: 'queryEventsCore utc profiles',
    run: async () => ({
      profileId: await queryEvents({ projectId: pid('utc'), profileId: 'user-hana', limit: 15 }),
      profileIds: await queryEvents(
        { projectId: pid('utc'), profileIds: ['user-alice', 'user-chloe'], eventNames: ['screen_view'], limit: 25 },
        compactRow,
      ),
    }),
  },
  {
    name: 'queryEventsCore prefixed filters',
    run: async (ctx) => ({
      sthlmProfileAndGroup: await queryEvents(
        {
          projectId: pid('sthlm'),
          filters: [
            filter('profile.properties.plan', 'is', ['enterprise']),
            filter('group.properties.seats', 'is', ['50']),
          ],
          startDate: dayString(ctx, 14),
          limit: 30,
        },
        compactRow,
      ),
      nyCohort: await queryEvents(
        { projectId: pid('ny'), filters: [cohortFilter('inCohort', COHORT.freePlan.id)], limit: 30 },
        compactRow,
      ),
      // buildFilterWhere only handles cohort/group/profile/session filters.
      sthlmPlainColumnDropped: await queryEvents(
        { projectId: pid('sthlm'), filters: [filter('country', 'is', ['XX'])], limit: 10 },
        compactRow,
      ),
    }),
  },

  // --- getTopPages (event.service) -----------------------------------------------------
  {
    name: 'getTopPages sthlm',
    run: () => getTopPages({ projectId: pid('sthlm'), take: 50 }),
    unordered: [''],
    // first_value() over an unordered read: engine-dependent.
    ignoreKeys: ['first_seen'],
  },
  {
    name: 'getTopPages ny search docs',
    run: () => getTopPages({ projectId: pid('ny'), take: 50, search: 'docs' }),
    unordered: [''],
    ignoreKeys: ['first_seen'],
  },

  // --- eventService.getById (trpc event.byId / details) ------------------------------------
  {
    name: 'eventService.getById sthlm identified revenue event',
    run: (ctx) => {
      const event = latestEvent(ctx, 'sthlm', (row) => row.name === 'revenue' && isIdentified(row));
      return eventService.getById({ projectId: pid('sthlm'), id: event.id });
    },
  },
  {
    name: 'eventService.getById ny anonymous click with createdAt',
    run: (ctx) => {
      const event = latestEvent(ctx, 'ny', (row) => row.name === 'button_click' && !isIdentified(row));
      return eventService.getById({ projectId: pid('ny'), id: event.id, createdAt: chDate(event.created_at) });
    },
  },
  {
    name: 'eventService.getById misses',
    run: async (ctx) => {
      const event = latestEvent(ctx, 'utc', (row) => row.name === 'screen_view');
      return {
        outsideSlack: await eventService.getById({
          projectId: pid('utc'),
          id: event.id,
          createdAt: new Date(chDate(event.created_at).getTime() + 5000),
        }),
        wrongProject: await eventService.getById({ projectId: pid('ny'), id: event.id }),
        unknown: await eventService.getById({ projectId: pid('utc'), id: '00000000-0000-4000-8000-000000000000' }),
      };
    },
  },

  // --- eventService.getList -------------------------------------------------------------
  {
    name: 'eventService.getList sthlm latest',
    run: () => serviceList({ projectId: pid('sthlm'), limit: 30 }),
  },
  {
    name: 'eventService.getList ny range with cursor',
    run: (ctx) =>
      serviceList({
        projectId: pid('ny'),
        limit: 25,
        startDate: daysAgo(ctx, 10),
        endDate: daysAgo(ctx, 5),
        cursor: daysAgo(ctx, 6),
      }),
  },
  {
    name: 'eventService.getList utc profile user-alice',
    run: () => serviceList({ projectId: pid('utc'), profileId: 'user-alice', limit: 20 }),
  },
  {
    name: 'eventService.getList sthlm filters',
    run: async (ctx) => ({
      columns: await serviceList({
        projectId: pid('sthlm'),
        limit: 15,
        startDate: daysAgo(ctx, 14),
        endDate: ctx.anchor,
        filters: [filter('country', 'is', ['SE']), filter('name', 'is', ['screen_view'])],
      }),
      group: await serviceList({
        projectId: pid('sthlm'),
        limit: 15,
        filters: [filter('group.name', 'is', ['Globex Corporation'])],
      }),
    }),
  },
];
