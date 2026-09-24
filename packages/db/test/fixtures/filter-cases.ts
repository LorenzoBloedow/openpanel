/**
 * A small dataset with the awkward values report filters meet (missing
 * keys, non-numeric numbers, dates in several formats, wildcard keys,
 * events in several groups or in a group without a row, profiles without a
 * row) and filter cases whose expected matches were recorded from the
 * ClickHouse builders (getEventFiltersWhereClause / buildFilterWhere) under
 * `session_timezone = Europe/Stockholm` — see src/analytics/filters.pg.test.ts.
 *
 * Ids are short names: e1…e6 (events), s1…s4 (sessions), u1…u3, d1, d2
 * (profiles).
 */
import type { IChartEventFilter } from '@openpanel/validation';

export const FILTER_PROJECT = 'filter-cases';
export const FILTER_TIMEZONE = 'Europe/Stockholm';
export const COHORT_1 = 'c1-0000';
export const COHORT_2 = 'c2-0000';

/** e3 → a UUID; the other way round for results. */
export const eventUuid = (short: string) =>
  `00000000-0000-4000-8000-${short.slice(1).padStart(12, '0')}`;
export const shortEventId = (uuid: string) => `e${Number(uuid.slice(-12))}`;

const eventBase = {
  project_id: FILTER_PROJECT,
  sdk_name: 'web',
  sdk_version: '1',
  origin: 'https://x.com',
  referrer_name: '',
  referrer_type: '',
  region: '',
  os: 'iOS',
  os_version: '17',
  browser: 'Chrome',
  browser_version: '1',
  device: 'mobile',
  brand: '',
  model: '',
  imported_at: null,
};

export const FILTER_EVENTS = [
  { id: 'e1', name: 'screen_view', device_id: 'd1', profile_id: 'd1', session_id: 's1', groups: [], path: '/docs/intro', referrer: '', country: 'SE', city: 'Stockholm', duration: 60_001, revenue: 0, longitude: 18.0686, latitude: null, properties: { __title: 'Docs', price: '9.99', 'item.0.sku': 'sku-1', 'item.1.sku': ' sku-2 ' }, created_at: '2024-03-10 23:30:00.250' },
  { id: 'e2', name: 'button_click', device_id: 'd1', profile_id: 'u1', session_id: 's2', groups: ['g1'], path: '/pricing', referrer: 'https://google.com', referrer_name: 'Google', country: 'US', city: 'New York', duration: 0, revenue: 999, longitude: -74.006, latitude: 40.7128, properties: { price: 'free', button: 'cta', '__query.utm_source': 'reddit' }, created_at: '2024-03-11 00:30:00.000' },
  { id: 'e3', name: 'purchase', device_id: 'd2', profile_id: 'u2', session_id: 's3', groups: ['g2', 'g3'], path: '/Checkout', referrer: '', country: '', city: '', duration: 5, revenue: 0, longitude: null, latitude: null, properties: { price: '19', 'item.0.sku': 'SKU-3', qty: '2', when: '2024-03-01 10:00:00', flag: 'yes' }, created_at: '2024-03-12 12:00:00.000' },
  { id: 'e4', name: 'link_out', device_id: 'd5', profile_id: 'u5', session_id: 's4', groups: ['g9'], path: '', referrer: 'https://t.co/', country: 'DE', city: 'Berlin', duration: 1000, revenue: 0, longitude: 13.405, latitude: 52.52, properties: { href: 'https://github.com/x', price: 'abc', when: '2024-03-02', flag: 'false' }, created_at: '2024-03-13 00:00:00.000' },
  { id: 'e5', name: 'screen_view', device_id: 'd3', profile_id: 'u3', session_id: 's3', groups: ['g1', 'g2'], path: '/docs', referrer: '', country: 'GB', city: 'London', duration: 30, revenue: 0, longitude: -0.1276, latitude: 51.5, properties: { __title: "It's — here", price: '0', when: '2024-03-02T23:30:00Z', flag: 'TRUE' }, created_at: '2024-03-14 08:00:00.000' },
  { id: 'e6', name: 'session_start', device_id: 'd1', profile_id: 'd1', session_id: 's1', groups: [], path: '/docs/intro', referrer: '', country: 'SE', city: 'Göteborg', duration: 0, revenue: 0, longitude: null, latitude: null, properties: { '__query.utm_source': 'newsletter', price: '100' }, created_at: '2024-03-31 01:30:00.000' },
].map((row) => ({ ...eventBase, ...row, id: eventUuid(row.id) }));

export const FILTER_PROFILES = [
  { id: 'u1', is_external: true, first_name: 'Ann', last_name: 'Öberg', email: 'ann@x.se', avatar: '', properties: { plan: 'pro', age: '34', 'company.name': 'acme', signup: '2024-03-01', vip: 'true', score: '5' }, groups: ['g1'], created_at: '2024-01-10 12:00:00.500', last_seen_at: '2024-05-01 00:00:00.000' },
  { id: 'u2', is_external: true, first_name: 'Bob', last_name: "O'Neil", email: 'bob@y.com', avatar: '', properties: { plan: 'free', age: '4', signup: '2024-03-01T23:30:00Z', vip: '1' }, groups: ['g2', 'g3'], created_at: '2024-02-01 00:00:00.000', last_seen_at: '2024-05-02 00:00:00.000' },
  { id: 'u3', is_external: true, first_name: '', last_name: '', email: '', avatar: '', properties: { plan: 'Pro', age: 'free', signup: 'garbage', vip: 'yes' }, groups: [], created_at: '2024-03-15 08:00:00.000', last_seen_at: '2024-05-03 00:00:00.000' },
  { id: 'd1', is_external: false, first_name: '', last_name: '', email: '', avatar: '', properties: {}, groups: [], created_at: '2024-04-01 00:00:00.000', last_seen_at: '2024-05-04 00:00:00.000' },
  { id: 'd2', is_external: false, first_name: '', last_name: '', email: '', avatar: '', properties: { plan: '' }, groups: ['g9'], created_at: '2024-04-02 00:00:00.000', last_seen_at: '2024-05-04 00:00:00.000' },
].map((row) => ({ ...row, project_id: FILTER_PROJECT }));

export const FILTER_GROUPS = [
  { id: 'g1', type: 'company', name: 'Acme Inc', properties: { plan: 'enterprise', seats: '50' } },
  { id: 'g2', type: 'company', name: 'Globex', properties: { plan: 'pro', seats: '12' } },
  { id: 'g3', type: 'team', name: 'Growth', properties: { lead: 'u1' } },
].map((row) => ({ ...row, project_id: FILTER_PROJECT, created_at: '2024-01-01 00:00:00', version: 1 }));

const sessionBase = {
  project_id: FILTER_PROJECT,
  entry_origin: '',
  exit_origin: '',
  region: '',
  city: '',
  longitude: null,
  latitude: null,
  device: '',
  brand: '',
  model: '',
  browser: '',
  browser_version: '',
  os: '',
  os_version: '',
  utm_medium: '',
  utm_source: '',
  utm_campaign: '',
  utm_content: '',
  utm_term: '',
  referrer_type: '',
  sign: 1,
  version: 1,
};

export const FILTER_SESSIONS = [
  { id: 's1', profile_id: 'd1', device_id: 'd1', groups: [], created_at: '2024-03-10 23:29:00.000', ended_at: '2024-03-10 23:31:00.000', is_bounce: true, screen_view_count: 1, event_count: 0, duration: 0, revenue: 0, country: 'SE', entry_path: '/docs/intro', exit_path: '/docs/intro', referrer: '', referrer_name: '' },
  { id: 's2', profile_id: 'u1', device_id: 'd1', groups: ['g1'], created_at: '2024-03-11 00:29:00.000', ended_at: '2024-03-11 00:40:00.000', is_bounce: false, screen_view_count: 5, event_count: 3, duration: 600_000, revenue: 999, country: 'US', entry_path: '/pricing', exit_path: '/', referrer: 'https://google.com', referrer_name: 'Google' },
  { id: 's3', profile_id: 'u2', device_id: 'd2', groups: ['g2', 'g3'], created_at: '2024-03-12 11:59:00.000', ended_at: '2024-03-12 12:10:00.000', is_bounce: false, screen_view_count: 4, event_count: 4, duration: 120_000, revenue: 0, country: '', entry_path: '/Checkout', exit_path: '/docs', referrer: '', referrer_name: '' },
  { id: 's4', profile_id: 'u5', device_id: 'd5', groups: ['g9'], created_at: '2024-03-13 00:00:00.000', ended_at: '2024-03-13 00:00:00.000', is_bounce: true, screen_view_count: 0, event_count: 1, duration: 0, revenue: 0, country: 'DE', entry_path: '', exit_path: '', referrer: 'https://t.co/', referrer_name: 'Twitter' },
].map((row) => ({ ...sessionBase, ...row }));

export const FILTER_COHORT_MEMBERS = [
  { cohort_id: COHORT_1, profile_id: 'u1' },
  { cohort_id: COHORT_1, profile_id: 'u3' },
  { cohort_id: COHORT_2, profile_id: 'u2' },
].map((row) => ({
  ...row,
  project_id: FILTER_PROJECT,
  matched_at: '2024-01-01 00:00:00',
  matching_properties: {},
  version: 1,
}));

/** The `session.performed_event` date scope of the prefixed cases. */
export const FILTER_DATE_SCOPE = {
  startDate: new Date('2024-03-11T00:00:00Z'),
  endDate: new Date('2024-03-12T00:00:00Z'),
};

export interface FilterCase {
  filter: IChartEventFilter;
  /** Matching ids, sorted. */
  expected: string[];
}

let seq = 0;
function f(
  name: string,
  operator: IChartEventFilter['operator'],
  value: IChartEventFilter['value'],
  extra: Partial<IChartEventFilter> = {},
): IChartEventFilter {
  seq++;
  return { id: `fc${seq}`, name, operator, value, ...extra };
}

const ALL_EVENTS = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
const GROUPED_EVENTS = ['e2', 'e3', 'e4', 'e5'];

/** Report filters on events (eventFilterClauses / getEventFiltersWhereClause). */
export const EVENT_FILTER_CASES: FilterCase[] = [
  // columns
  { filter: f('country', 'is', ['SE']), expected: ['e1', 'e6'] },
  { filter: f('country', 'isNot', ['SE', 'US']), expected: ['e3', 'e4', 'e5'] },
  { filter: f('country', 'contains', ['E']), expected: ['e1', 'e4', 'e6'] },
  { filter: f('country', 'isNull', []), expected: ['e3'] },
  { filter: f('country', 'isNotNull', []), expected: ['e1', 'e2', 'e4', 'e5', 'e6'] },
  { filter: f('country', 'is', []), expected: ALL_EVENTS },
  { filter: f('path', 'contains', ['DOCS']), expected: [] },
  { filter: f('path', 'doesNotContain', ['docs', 'pricing']), expected: ALL_EVENTS },
  { filter: f('path', 'startsWith', ['/docs']), expected: ['e1', 'e5', 'e6'] },
  { filter: f('path', 'endsWith', ['intro']), expected: ['e1', 'e6'] },
  { filter: f('path', 'regex', ['/^\\/docs/']), expected: ['e1', 'e5', 'e6'] },
  { filter: f('path', 'gt', ['/Checkout']), expected: ['e1', 'e2', 'e5', 'e6'] },
  { filter: f('referrerName', 'is', ['Google']), expected: ['e2'] },
  { filter: f('duration', 'gt', ['1000']), expected: ['e1'] },
  { filter: f('duration', 'is', ['5', '30']), expected: ['e3', 'e5'] },
  { filter: f('duration', 'lte', ['30'], { type: 'number' }), expected: ['e2', 'e3', 'e5', 'e6'] },
  { filter: f('longitude', 'gte', ['0']), expected: ['e1', 'e4'] },
  { filter: f('created_at', 'gt', ['2024-03-12 12:00:00']), expected: ['e4', 'e5', 'e6'] },
  { filter: f('created_at', 'is', ['2024-03-12 12:00:00']), expected: ['e3'] },
  { filter: f('created_at', 'gte', ['2024-03-11T00:00:00Z'], { type: 'date' }), expected: ['e2', 'e3', 'e4', 'e5', 'e6'] },
  { filter: f('created_at', 'lt', ['2024-03-11T00:00:00Z'], { type: 'datetime' }), expected: ['e1', 'e2'] },
  { filter: f('name', 'is', ['screen_view', 'purchase']), expected: ['e1', 'e3', 'e5'] },
  { filter: f('name', 'gt', ['purchase']), expected: ['e1', 'e5', 'e6'] },
  { filter: f('utm_source', 'is', ['reddit']), expected: ['e2'] },
  { filter: f('temple_name', 'is', ['x']), expected: ALL_EVENTS },
  // properties
  { filter: f('properties.price', 'is', ['9.99']), expected: ['e1'] },
  { filter: f('properties.price', 'isNot', ['19', '0']), expected: ['e1', 'e2', 'e4', 'e6'] },
  { filter: f('properties.price', 'gt', ['5']), expected: ['e1', 'e3', 'e6'] },
  { filter: f('properties.price', 'lte', ['0']), expected: ['e2', 'e4', 'e5'] },
  { filter: f('properties.price', 'gte', ['5'], { type: 'number' }), expected: ['e1', 'e3', 'e6'] },
  { filter: f('properties.price', 'regex', ['^\\d+$']), expected: ['e3', 'e5', 'e6'] },
  { filter: f('properties.price', 'regex', ['/9/']), expected: [] },
  { filter: f('properties.price', 'contains', ['9'], { type: 'number' }), expected: ['e1', 'e3'] },
  { filter: f('properties.missing', 'isNull', []), expected: ALL_EVENTS },
  { filter: f('properties.missing', 'isNotNull', []), expected: [] },
  { filter: f('properties.missing', 'isNot', ['x']), expected: ALL_EVENTS },
  { filter: f('properties.flag', 'is', ['true'], { type: 'boolean' }), expected: ['e3', 'e5'] },
  { filter: f('properties.flag', 'isNot', ['1'], { type: 'boolean' }), expected: ['e1', 'e2', 'e4', 'e6'] },
  { filter: f('properties.when', 'gte', ['2024-03-02'], { type: 'datetime' }), expected: ['e4', 'e5'] },
  { filter: f('properties.when', 'is', ['2024-03-03'], { type: 'date' }), expected: ['e5'] },
  { filter: f('properties.__title', 'is', ["It's — here"]), expected: ['e5'] },
  { filter: f('properties.item[*].sku', 'is', ['sku-2']), expected: ['e1'] },
  { filter: f('properties.item[*].sku', 'contains', ['sku']), expected: ['e1'] },
  { filter: f('properties.item[*].sku', 'isNot', ['sku-1']), expected: ['e1', 'e3'] },
  { filter: f('properties.item[*].sku', 'isNull', []), expected: [] },
  { filter: f('properties.item[*].sku', 'startsWith', ['SKU'], { type: 'string' }), expected: ['e3'] },
  { filter: f('properties.item[*].sku', 'gt', ['0'], { type: 'number' }), expected: [] },
  { filter: f('properties.item.*.sku', 'is', ['sku-1']), expected: ['e1'] },
  // profiles
  { filter: f('profile.properties.plan', 'is', ['pro']), expected: ['e2'] },
  { filter: f('profile.properties.plan', 'isNot', ['pro']), expected: ['e1', 'e3', 'e4', 'e5', 'e6'] },
  { filter: f('profile.properties.plan', 'contains', ['PRO']), expected: [] },
  { filter: f('profile.properties.plan', 'isNull', []), expected: ['e1', 'e4', 'e6'] },
  { filter: f('profile.properties.age', 'gt', ['30']), expected: ['e2'] },
  { filter: f('profile.properties.age', 'lte', ['30'], { type: 'number' }), expected: ['e3'] },
  { filter: f('profile.properties.company.name', 'is', ['acme']), expected: ['e2'] },
  { filter: f('profile.properties.signup', 'is', ['2024-03-02'], { type: 'date' }), expected: ['e3'] },
  { filter: f('profile.email', 'endsWith', ['.se']), expected: ALL_EVENTS },
  // groups
  { filter: f('group.name', 'is', ['Acme Inc']), expected: ['e2', 'e5'] },
  { filter: f('group.name', 'isNot', ['Acme Inc']), expected: ['e3', 'e4', 'e5'] },
  { filter: f('group.name', 'contains', ['acme']), expected: [] },
  { filter: f('group.name', 'isNull', []), expected: ['e4'] },
  { filter: f('group.name', 'doesNotContain', ['Acme', 'Glo']), expected: GROUPED_EVENTS },
  { filter: f('group.type', 'is', ['team']), expected: ['e3'] },
  { filter: f('group.properties.seats', 'gt', ['20'], { type: 'number' }), expected: ['e2', 'e5'] },
  { filter: f('group.properties.seats', 'gt', ['20']), expected: GROUPED_EVENTS },
  { filter: f('group.properties.plan', 'regex', ['^pro$']), expected: ['e3', 'e5'] },
  { filter: f('group.id', 'is', ['g9']), expected: ['e4'] },
  { filter: f('group.foo', 'is', ['g2']), expected: ['e3', 'e5'] },
  { filter: f('group.name', 'is', []), expected: GROUPED_EVENTS },
  // profile flags and cohorts
  { filter: f('has_profile', 'is', ['true']), expected: ['e2', 'e3', 'e4', 'e5'] },
  { filter: f('has_profile', 'is', [true]), expected: ['e1', 'e6'] },
  { filter: f('cohort', 'inCohort', [], { cohortId: COHORT_1 }), expected: ['e2', 'e5'] },
  { filter: f('cohort', 'notInCohort', [], { cohortId: COHORT_1 }), expected: ['e1', 'e3', 'e4', 'e6'] },
  { filter: f('cohort', 'inCohort', [], { cohortIds: [COHORT_1, COHORT_2] }), expected: ['e2', 'e3', 'e5'] },
  { filter: f('cohort', 'inCohort', []), expected: ALL_EVENTS },
  { filter: f(`cohort:${COHORT_1}`, 'is', ['x']), expected: ALL_EVENTS },
];

export interface PrefixedFilterCase extends FilterCase {
  table: 'events' | 'sessions' | 'profiles';
}

const prefixed = (
  table: PrefixedFilterCase['table'],
  cases: [IChartEventFilter, string[]][],
): PrefixedFilterCase[] => cases.map(([filter, expected]) => ({ table, filter, expected }));

/** List filters (prefixedFilterClauses / buildFilterWhere). */
export const PREFIXED_FILTER_CASES: PrefixedFilterCase[] = [
  ...prefixed('profiles', [
    [f('profile.email', 'contains', ['X.SE']), ['u1']],
    [f('profile.first_name', 'isNull', []), ['d1', 'd2', 'u3']],
    [f('profile.last_name', 'startsWith', ['ö']), ['u1']],
    [f('profile.properties.plan', 'isNot', ['pro', 'free']), ['d1', 'd2', 'u3']],
    [f('profile.properties.plan', 'doesNotContain', ['p', 'f']), ['d1', 'd2']],
    [f('profile.properties.age', 'gt', ['30']), ['u1', 'u2', 'u3']],
    [f('profile.properties.age', 'gt', ['30'], { type: 'number' }), ['u1']],
    [f('profile.created_at', 'gt', ['1706745600']), ['d1', 'd2', 'u3']],
    [f('profile.created_at', 'gte', ['2024-02-01'], { type: 'datetime' }), ['d1', 'd2', 'u2', 'u3']],
    [f('profile.properties.signup', 'is', ['2024-03-02'], { type: 'date' }), ['u2']],
    [f('profile.properties.vip', 'is', ['true'], { type: 'boolean' }), ['u1', 'u2', 'u3']],
    [f('profile.foo', 'is', ['x']), ['d1', 'd2', 'u1', 'u2', 'u3']],
    [f('group.name', 'contains', ['acme']), ['u1']],
    [f('group.properties.seats', 'gt', ['20'], { type: 'number' }), ['u1']],
    [f('group.properties.seats', 'gt', ['20']), ['u1']],
    [f('group.type', 'isNot', ['team']), ['u1', 'u2']],
    [f('cohort', 'inCohort', [], { cohortId: COHORT_1 }), ['u1', 'u3']],
    [f('cohort', 'notInCohort', [], { cohortId: COHORT_1 }), ['d1', 'd2', 'u2']],
    [f(`cohort:${COHORT_2}`, 'is', []), ['u2']],
    [f('country', 'is', ['SE']), ['d1', 'd2', 'u1', 'u2', 'u3']],
    [f('properties.plan', 'is', ['pro']), ['d1', 'd2', 'u1', 'u2', 'u3']],
  ]),
  ...prefixed('sessions', [
    [f('session.is_bounce', 'is', ['true']), ['s1', 's4']],
    [f('session.is_bounce', 'isNot', ['true']), ['s2', 's3']],
    [f('session.screen_view_count', 'is', ['4', '5']), ['s2', 's3']],
    [f('session.screen_view_count', 'isNot', ['4', '5']), ['s1', 's2', 's3', 's4']],
    [f('session.duration', 'gte', ['120000']), ['s2', 's3']],
    [f('session.revenue', 'gt', ['0'], { type: 'number' }), ['s2']],
    [f('session.performed_event', 'is', ['purchase']), ['s3']],
    [f('session.performed_event', 'is', ['screen_view']), []],
    [f('session.performed_event', 'isNot', ['purchase', 'link_out']), ['s1', 's2', 's4']],
    [f('session.foo', 'is', ['x']), ['s1', 's2', 's3', 's4']],
    [f('profile.email', 'endsWith', ['.COM']), ['s3']],
    [f('profile.properties.plan', 'is', ['pro', 'free']), ['s2', 's3']],
    [f('group.name', 'is', ['Growth']), ['s3']],
    [f('cohort', 'notInCohort', [], { cohortIds: [COHORT_1, COHORT_2] }), ['s1', 's4']],
  ]),
  ...prefixed('events', [
    [f('profile.properties.plan', 'isNot', ['pro']), ['e1', 'e3', 'e5', 'e6']],
    [f('group.properties.plan', 'is', ['pro']), ['e3', 'e5']],
    [f('session.is_bounce', 'is', ['true']), ALL_EVENTS],
    [f('country', 'is', ['XX']), ALL_EVENTS],
  ]),
];
