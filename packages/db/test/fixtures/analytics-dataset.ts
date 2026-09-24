/**
 * Deterministic analytics dataset for tests and for the golden comparison
 * between the ClickHouse services and their Postgres ports.
 *
 * Rows use the ClickHouse insert shapes (snake_case, UTC
 * 'YYYY-MM-DD HH:MM:SS.mmm' timestamps, flattened string property maps) so
 * the same rows load into ClickHouse and into the Postgres analytics schema.
 * Sessions are derived from their events with the session-buffer rules, so
 * event-based and session-based queries agree.
 */

export interface DatasetOptions {
  projectId: string;
  /** "Now" for the dataset; history is generated backwards from it. */
  anchor: Date;
  seed?: number;
  /** Days of history before the anchor. */
  days?: number;
}

export interface EventRow {
  id: string;
  name: string;
  sdk_name: string;
  sdk_version: string;
  device_id: string;
  profile_id: string;
  project_id: string;
  session_id: string;
  groups: string[];
  path: string;
  origin: string;
  referrer: string;
  referrer_name: string;
  referrer_type: string;
  revenue: number;
  duration: number;
  properties: Record<string, string>;
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
  inserted_at: string;
}

export interface SessionRow {
  id: string;
  project_id: string;
  profile_id: string;
  device_id: string;
  groups: string[];
  created_at: string;
  ended_at: string;
  is_bounce: boolean;
  entry_origin: string;
  entry_path: string;
  exit_origin: string;
  exit_path: string;
  screen_view_count: number;
  revenue: number;
  event_count: number;
  duration: number;
  country: string;
  region: string;
  city: string;
  longitude: number | null;
  latitude: number | null;
  device: string;
  brand: string;
  model: string;
  browser: string;
  browser_version: string;
  os: string;
  os_version: string;
  utm_medium: string;
  utm_source: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  referrer: string;
  referrer_name: string;
  referrer_type: string;
  sign: 1;
  version: number;
}

export interface ProfileRow {
  id: string;
  project_id: string;
  is_external: boolean;
  first_name: string;
  last_name: string;
  email: string;
  avatar: string;
  properties: Record<string, string>;
  groups: string[];
  created_at: string;
  last_seen_at: string;
}

export interface GroupRow {
  id: string;
  project_id: string;
  type: string;
  name: string;
  properties: Record<string, string>;
  created_at: string;
  version: number;
}

export interface BotRow {
  id: string;
  project_id: string;
  name: string;
  type: string;
  path: string;
  created_at: string;
}

export interface ReplayChunkRow {
  project_id: string;
  session_id: string;
  chunk_index: number;
  started_at: string;
  ended_at: string;
  events_count: number;
  is_full_snapshot: boolean;
  payload: string;
}

export interface GscRow {
  project_id: string;
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  synced_at: string;
}

export interface CohortMemberRow {
  project_id: string;
  cohort_id: string;
  profile_id: string;
  matched_at: string;
  matching_properties: Record<string, string>;
  version: number;
}

export interface Dataset {
  projectId: string;
  anchor: Date;
  events: EventRow[];
  sessions: SessionRow[];
  profiles: ProfileRow[];
  groups: GroupRow[];
  bots: BotRow[];
  replayChunks: ReplayChunkRow[];
  gscDaily: GscRow[];
  gscPages: (GscRow & { page: string })[];
  gscQueries: (GscRow & { query: string })[];
  cohortMembers: CohortMemberRow[];
}

/** Cohorts the dataset assigns members to (ids are UUIDs, like Prisma's). */
export const DATASET_COHORTS = {
  powerUsers: {
    id: '0b4c6f1e-2f0a-4f4e-9d8a-6e2f7c1a9b01',
    name: 'Power users',
  },
  freePlan: {
    id: '0b4c6f1e-2f0a-4f4e-9d8a-6e2f7c1a9b02',
    name: 'Free plan',
  },
} as const;

// --- deterministic randomness ------------------------------------------------

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Random {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float() {
    return this.next();
  }
  int(min: number, max: number) {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  chance(probability: number) {
    return this.next() < probability;
  }
  /** A deterministic UUID-shaped id (v4 layout). */
  uuid() {
    const hex = Array.from({ length: 32 }, () =>
      Math.floor(this.next() * 16).toString(16),
    );
    hex[12] = '4';
    hex[16] = ['8', '9', 'a', 'b'][Math.floor(this.next() * 4)]!;
    const s = hex.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
}

// --- helpers ------------------------------------------------------------------

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** UTC 'YYYY-MM-DD HH:MM:SS.mmm', the ClickHouse DateTime64(3) text. */
export function toChDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

function toChDate(ms: number): string {
  return toChDateTime(ms).slice(0, 10);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// --- vocabularies --------------------------------------------------------------

interface Place {
  country: string;
  region: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
}

const PLACES: Place[] = [
  { country: 'SE', region: 'Stockholm County', city: 'Stockholm', latitude: 59.3293, longitude: 18.0686 },
  { country: 'SE', region: 'Västra Götaland', city: 'Göteborg', latitude: 57.7089, longitude: 11.9746 },
  { country: 'US', region: 'California', city: 'San Francisco', latitude: 37.7749, longitude: -122.4194 },
  { country: 'US', region: 'New York', city: 'New York', latitude: 40.7128, longitude: -74.006 },
  { country: 'DE', region: 'Berlin', city: 'Berlin', latitude: 52.52, longitude: 13.405 },
  { country: 'GB', region: 'England', city: 'London', latitude: 51.5072, longitude: -0.1276 },
  { country: 'IN', region: 'Karnataka', city: 'Bengaluru', latitude: 12.9716, longitude: 77.5946 },
  { country: '', region: '', city: '', latitude: null, longitude: null },
];

interface Agent {
  os: string;
  os_version: string;
  browser: string;
  browser_version: string;
  device: string;
  brand: string;
  model: string;
}

const AGENTS: Agent[] = [
  { os: 'Mac OS', os_version: '14.5', browser: 'Chrome', browser_version: '126.0.0.0', device: 'desktop', brand: 'Apple', model: 'Macintosh' },
  { os: 'Windows', os_version: '10', browser: 'Chrome', browser_version: '125.0.0.0', device: 'desktop', brand: '', model: '' },
  { os: 'Windows', os_version: '11', browser: 'Edge', browser_version: '126.0.0.0', device: 'desktop', brand: '', model: '' },
  { os: 'Linux', os_version: '', browser: 'Firefox', browser_version: '127.0', device: 'desktop', brand: '', model: '' },
  { os: 'iOS', os_version: '17.5', browser: 'Mobile Safari', browser_version: '17.5', device: 'mobile', brand: 'Apple', model: 'iPhone' },
  { os: 'Android', os_version: '14', browser: 'Chrome Mobile', browser_version: '126.0.0.0', device: 'mobile', brand: 'Samsung', model: 'SM-S918B' },
  { os: 'iOS', os_version: '17.4', browser: 'Mobile Safari', browser_version: '17.4', device: 'tablet', brand: 'Apple', model: 'iPad' },
];

interface Source {
  referrer: string;
  referrer_name: string;
  referrer_type: string;
  utm: Partial<Record<'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content' | 'utm_term', string>>;
}

const SOURCES: Source[] = [
  { referrer: '', referrer_name: '', referrer_type: '', utm: {} },
  { referrer: '', referrer_name: '', referrer_type: '', utm: {} },
  { referrer: 'https://www.google.com/', referrer_name: 'Google', referrer_type: 'search', utm: {} },
  { referrer: 'https://www.google.com/', referrer_name: 'Google', referrer_type: 'search', utm: {} },
  { referrer: 'https://duckduckgo.com/', referrer_name: 'DuckDuckGo', referrer_type: 'search', utm: {} },
  { referrer: 'https://t.co/', referrer_name: 'Twitter', referrer_type: 'social', utm: {} },
  { referrer: 'https://github.com/openpanel-dev/openpanel', referrer_name: 'GitHub', referrer_type: 'social', utm: {} },
  {
    referrer: '',
    referrer_name: 'Newsletter',
    referrer_type: 'email',
    utm: { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'spring_launch' },
  },
  {
    referrer: 'https://www.reddit.com/',
    referrer_name: 'Reddit',
    referrer_type: 'social',
    utm: { utm_source: 'reddit', utm_medium: 'social', utm_campaign: 'launch_week', utm_content: 'post_1', utm_term: 'analytics' },
  },
];

const SITE_PAGES = [
  { origin: 'https://example.com', path: '/', title: 'Example — Home' },
  { origin: 'https://example.com', path: '/pricing', title: 'Pricing' },
  { origin: 'https://example.com', path: '/docs', title: 'Docs' },
  { origin: 'https://example.com', path: '/docs/getting-started', title: 'Getting started' },
  { origin: 'https://example.com', path: '/blog/hello-world', title: "Hello, world — it's here" },
  { origin: 'https://example.com', path: '/checkout', title: 'Checkout' },
  { origin: 'https://app.example.com', path: '/dashboard', title: 'Dashboard' },
  { origin: 'https://app.example.com', path: '/settings/profile', title: 'Settings' },
];

const IDENTIFIED_PROFILES = [
  { id: 'user-alice', first_name: 'Alice', last_name: 'Andersson', email: 'alice@example.com', plan: 'pro', company: 'acme', age: '34' },
  { id: 'user-bob', first_name: 'Bob', last_name: "O'Brien", email: 'bob@example.com', plan: 'free', company: 'globex', age: '28' },
  { id: 'user-chloe', first_name: 'Chloé', last_name: 'Dupont', email: 'chloe@example.fr', plan: 'enterprise', company: 'acme', age: '41' },
  { id: 'user-dmitri', first_name: 'Dmitri', last_name: 'Ivanov', email: 'dmitri@example.com', plan: 'free', company: 'initech', age: '22' },
  { id: 'user-eve', first_name: 'Eve', last_name: 'Smith', email: 'eve@example.com', plan: 'pro', company: 'globex', age: '37' },
  { id: 'user-farah', first_name: 'Farah', last_name: 'Khan', email: 'farah@example.com', plan: 'free', company: '', age: '30' },
  { id: 'user-gustav', first_name: 'Gustav', last_name: 'Öberg', email: 'gustav@example.se', plan: 'pro', company: 'initech', age: '45' },
  { id: 'user-hana', first_name: 'Hana', last_name: 'Sato', email: 'hana@example.jp', plan: 'enterprise', company: 'acme', age: '' },
] as const;

const GROUPS = [
  { id: 'acme', type: 'company', name: 'Acme Inc', properties: { plan: 'enterprise', seats: '50', 'billing.country': 'US' } },
  { id: 'globex', type: 'company', name: 'Globex Corporation', properties: { plan: 'pro', seats: '12' } },
  { id: 'initech', type: 'company', name: 'Initech', properties: { plan: 'free', seats: '3' } },
  { id: 'team-growth', type: 'team', name: 'Growth', properties: { lead: 'user-alice' } },
] as const;

// --- generation ---------------------------------------------------------------

interface Visitor {
  deviceId: string;
  agent: Agent;
  place: Place;
  profile?: (typeof IDENTIFIED_PROFILES)[number];
}

interface DraftEvent {
  name: string;
  at: number;
  page: (typeof SITE_PAGES)[number];
  properties: Record<string, string>;
  revenue: number;
  identified: boolean;
}

export function generateDataset(options: DatasetOptions): Dataset {
  const { projectId } = options;
  const days = options.days ?? 60;
  const random = new Random(options.seed ?? 42);
  // Whole minutes keep the text renderings free of odd milliseconds.
  const anchorMs = Math.floor(options.anchor.getTime() / MINUTE) * MINUTE;

  const visitors: Visitor[] = [];
  for (let i = 0; i < 40; i++) {
    visitors.push({
      deviceId: `dev-${projectId.slice(0, 4)}-${pad(i, 3)}`,
      agent: random.pick(AGENTS),
      place: random.pick(PLACES),
      // The first eight devices belong to identified users.
      profile: i < IDENTIFIED_PROFILES.length ? IDENTIFIED_PROFILES[i] : undefined,
    });
  }

  const events: EventRow[] = [];
  const sessions: SessionRow[] = [];
  const profileSeen = new Map<string, { first: number; last: number; row: Omit<ProfileRow, 'created_at' | 'last_seen_at'> }>();

  const sessionStarts: { at: number; visitor: Visitor }[] = [];
  for (let day = days; day >= 0; day--) {
    const midnight = Math.floor((anchorMs - day * DAY) / DAY) * DAY;
    const count = random.int(4, 12);
    for (let s = 0; s < count; s++) {
      // Mostly daytime (UTC), some late-night sessions that cross midnight
      // in UTC and in the project zones.
      const offset = random.chance(0.15)
        ? random.int(22 * 60, 23 * 60 + 55) * MINUTE
        : random.int(6 * 60, 21 * 60) * MINUTE;
      const at = midnight + offset;
      if (at < anchorMs - 35 * MINUTE) {
        sessionStarts.push({ at, visitor: random.pick(visitors) });
      }
    }
  }
  // Recent activity for the realtime views: sessions in the last half hour.
  for (let i = 0; i < 5; i++) {
    sessionStarts.push({
      at: anchorMs - random.int(3, 28) * MINUTE,
      visitor: visitors[20 + i]!,
    });
  }
  // DST edges (Europe/Stockholm 2026-03-29, America/New_York 2026-03-08).
  for (const edge of [Date.UTC(2026, 2, 29, 0, 30), Date.UTC(2026, 2, 8, 6, 30)]) {
    for (let i = 0; i < 4; i++) {
      sessionStarts.push({ at: edge + i * 40 * MINUTE, visitor: visitors[30 + i]! });
    }
  }
  sessionStarts.sort((a, b) => a.at - b.at);

  // A device can't run two sessions at once: skip overlapping starts.
  const busyUntil = new Map<string, number>();

  for (const { at, visitor } of sessionStarts) {
    if ((busyUntil.get(visitor.deviceId) ?? 0) + 30 * MINUTE > at) {
      continue;
    }
    const source = random.pick(SOURCES);
    const drafts: DraftEvent[] = [];
    const landing = random.pick(SITE_PAGES);
    const pageviews = random.chance(0.3) ? 1 : random.int(2, 6);
    let cursor = at;
    // Identified users sometimes log in part-way through the session.
    const identifyAt = visitor.profile
      ? random.chance(0.25)
        ? random.int(1, Math.max(1, pageviews - 1))
        : 0
      : Number.POSITIVE_INFINITY;

    for (let p = 0; p < pageviews; p++) {
      const page = p === 0 ? landing : random.pick(SITE_PAGES);
      drafts.push({
        name: 'screen_view',
        at: cursor,
        page,
        properties: { __title: page.title },
        revenue: 0,
        identified: p >= identifyAt,
      });
      if (random.chance(0.35)) {
        drafts.push({
          name: 'button_click',
          at: cursor + random.int(5, 50) * 1000,
          page,
          properties: {
            button: random.pick(['cta', 'nav', 'footer']),
            variant: random.pick(['a', 'b']),
            price: random.pick(['9.99', '19', '0', 'free']),
          },
          revenue: 0,
          identified: p >= identifyAt,
        });
      }
      if (random.chance(0.1)) {
        drafts.push({
          name: 'link_out',
          at: cursor + random.int(2, 20) * 1000,
          page,
          properties: {
            href: random.pick([
              'https://github.com/openpanel-dev/openpanel',
              'https://twitter.com/openpaneldev',
              'https://docs.example.org/guide?ref=site',
            ]),
          },
          revenue: 0,
          identified: p >= identifyAt,
        });
      }
      if (page.path === '/checkout' && random.chance(0.6)) {
        const amount = random.pick([999, 1999, 4900]);
        drafts.push({
          name: 'revenue',
          at: cursor + 60 * 1000,
          page,
          properties: { currency: 'USD', order_id: random.uuid().slice(0, 8) },
          revenue: amount,
          identified: p >= identifyAt,
        });
        drafts.push({
          name: 'purchase',
          at: cursor + 61 * 1000,
          page,
          properties: { 'item.sku': random.pick(['sku-1', 'sku-2']), 'item.qty': String(random.int(1, 3)) },
          revenue: 0,
          identified: p >= identifyAt,
        });
      }
      if (p === 0 && visitor.profile && random.chance(0.05)) {
        drafts.push({
          name: 'signup',
          at: cursor + 30 * 1000,
          page,
          properties: { method: random.pick(['email', 'google']) },
          revenue: 0,
          identified: true,
        });
      }
      cursor += random.int(20, 240) * 1000;
    }
    drafts.sort((a, b) => a.at - b.at);

    const sessionId = `sess-${random.uuid().slice(0, 13)}`;
    const firstIdentified = drafts.find((draft) => draft.identified);
    const groups =
      visitor.profile && visitor.profile.company !== ''
        ? [visitor.profile.company]
        : [];
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(source.utm)) {
      if (value) {
        query[`__query.${key}`] = value;
      }
    }

    // --- the session, built like SessionBuffer.newSession/extendSession ----
    const first = drafts[0]!;
    const last = drafts[drafts.length - 1]!;
    let screenViews = 0;
    let otherEvents = 0;
    let revenue = 0;
    for (const draft of drafts) {
      if (draft.name === 'screen_view' && draft.page.path) {
        screenViews++;
      } else {
        otherEvents++;
      }
      if (draft.name === 'revenue') {
        revenue += draft.revenue;
      }
    }
    const profileId =
      firstIdentified && visitor.profile ? visitor.profile.id : visitor.deviceId;
    const session: SessionRow = {
      id: sessionId,
      project_id: projectId,
      profile_id: profileId,
      device_id: visitor.deviceId,
      groups: firstIdentified ? groups : [],
      created_at: toChDateTime(first.at),
      ended_at: toChDateTime(last.at),
      is_bounce: screenViews <= 1,
      entry_origin: first.page.origin,
      entry_path: first.page.path,
      exit_origin: last.page.origin,
      exit_path: last.page.path,
      screen_view_count: screenViews,
      revenue,
      event_count: otherEvents,
      duration: last.at - first.at,
      country: visitor.place.country,
      region: visitor.place.region,
      city: visitor.place.city,
      longitude: visitor.place.longitude,
      latitude: visitor.place.latitude,
      device: visitor.agent.device,
      brand: visitor.agent.brand,
      model: visitor.agent.model,
      browser: visitor.agent.browser,
      browser_version: visitor.agent.browser_version,
      os: visitor.agent.os,
      os_version: visitor.agent.os_version,
      utm_medium: source.utm.utm_medium ?? '',
      utm_source: source.utm.utm_source ?? '',
      utm_campaign: source.utm.utm_campaign ?? '',
      utm_content: source.utm.utm_content ?? '',
      utm_term: source.utm.utm_term ?? '',
      referrer: source.referrer,
      referrer_name: source.referrer_name,
      referrer_type: source.referrer_type,
      sign: 1,
      version: drafts.length,
    };
    sessions.push(session);
    busyUntil.set(visitor.deviceId, last.at);

    const base = (draft: DraftEvent | undefined, name: string, at: number) => ({
      id: random.uuid(),
      name,
      sdk_name: visitor.agent.device === 'desktop' ? 'web' : 'react-native',
      sdk_version: '1.4.0',
      device_id: visitor.deviceId,
      profile_id:
        draft?.identified && visitor.profile ? visitor.profile.id : visitor.deviceId,
      project_id: projectId,
      session_id: sessionId,
      groups: draft?.identified ? groups : [],
      path: draft?.page.path ?? last.page.path,
      origin: draft?.page.origin ?? last.page.origin,
      referrer: source.referrer,
      referrer_name: source.referrer_name,
      referrer_type: source.referrer_type,
      revenue: draft?.revenue ?? 0,
      duration: 0,
      created_at: toChDateTime(at),
      country: visitor.place.country,
      city: visitor.place.city,
      region: visitor.place.region,
      longitude: visitor.place.longitude,
      latitude: visitor.place.latitude,
      ...visitor.agent,
      imported_at: null,
      inserted_at: toChDateTime(at),
    });

    events.push({
      ...base(first, 'session_start', first.at - 100),
      revenue: 0,
      properties: { ...query, ...first.properties },
    });
    drafts.forEach((draft, index) => {
      const next = drafts[index + 1];
      events.push({
        ...base(draft, draft.name, draft.at),
        properties: { ...query, ...draft.properties },
        // Screen views carry the time until the next one, like the SDK.
        duration:
          draft.name === 'screen_view' && next ? next.at - draft.at : 0,
      });
    });
    // The newest sessions are still live; older ones have ended.
    if (last.at < anchorMs - 30 * MINUTE) {
      events.push({
        ...base(last, 'session_end', last.at + 1000),
        revenue: 0,
        path: last.page.path,
        profile_id: profileId,
        duration: session.duration,
        properties: { ...query, __bounce: String(session.is_bounce) },
      });
    }

    // Profiles: identified users, and anonymous devices (profile = device).
    const touch = (id: string, row: Omit<ProfileRow, 'created_at' | 'last_seen_at'>) => {
      const seen = profileSeen.get(id);
      if (seen) {
        seen.first = Math.min(seen.first, first.at);
        seen.last = Math.max(seen.last, last.at);
        seen.row = row;
      } else {
        profileSeen.set(id, { first: first.at, last: last.at, row });
      }
    };
    const geoProperties = {
      country: visitor.place.country,
      city: visitor.place.city,
      region: visitor.place.region,
      os: visitor.agent.os,
      browser: visitor.agent.browser,
      device: visitor.agent.device,
    };
    const cleanProperties = (properties: Record<string, string>) =>
      Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== ''));
    touch(visitor.deviceId, {
      id: visitor.deviceId,
      project_id: projectId,
      is_external: false,
      first_name: '',
      last_name: '',
      email: '',
      avatar: '',
      properties: cleanProperties({ ...geoProperties, path: first.page.path, referrer: source.referrer }),
      groups: [],
    });
    if (visitor.profile && firstIdentified) {
      touch(visitor.profile.id, {
        id: visitor.profile.id,
        project_id: projectId,
        is_external: true,
        first_name: visitor.profile.first_name,
        last_name: visitor.profile.last_name,
        email: visitor.profile.email,
        avatar: '',
        properties: cleanProperties({
          ...geoProperties,
          plan: visitor.profile.plan,
          age: visitor.profile.age,
          'company.name': visitor.profile.company,
        }),
        groups,
      });
    }
  }

  const profiles: ProfileRow[] = [...profileSeen.values()].map(({ first, last, row }) => ({
    ...row,
    created_at: toChDateTime(first),
    last_seen_at: toChDateTime(last),
  }));

  const groups: GroupRow[] = GROUPS.map((group, index) => ({
    id: group.id,
    project_id: projectId,
    type: group.type,
    name: group.name,
    properties: { ...group.properties },
    created_at: toChDateTime(anchorMs - (days - index) * DAY).slice(0, 19),
    version: anchorMs - (days - index) * DAY,
  }));

  const bots: BotRow[] = Array.from({ length: 6 }, (_, index) => ({
    id: random.uuid(),
    project_id: projectId,
    name: random.pick(['Googlebot', 'Bingbot', 'AhrefsBot']),
    type: random.pick(['search', 'seo']),
    path: random.pick(SITE_PAGES).path,
    created_at: toChDateTime(anchorMs - index * 7 * HOUR),
  }));

  const replaySessions = sessions
    .filter((session) => session.screen_view_count > 2)
    .slice(-2);
  const replayChunks: ReplayChunkRow[] = replaySessions.flatMap((session) => {
    const start = new Date(`${session.created_at.replace(' ', 'T')}Z`).getTime();
    return [0, 1, 2].map((chunk) => ({
      project_id: projectId,
      session_id: session.id,
      chunk_index: chunk,
      started_at: toChDateTime(start + chunk * 10_000),
      ended_at: toChDateTime(start + chunk * 10_000 + 9_000),
      events_count: 10 + chunk,
      is_full_snapshot: chunk === 0,
      payload: JSON.stringify([{ type: chunk === 0 ? 2 : 3, timestamp: start + chunk * 10_000 }]),
    }));
  });

  const gscDaily: GscRow[] = [];
  const gscPages: (GscRow & { page: string })[] = [];
  const gscQueries: (GscRow & { query: string })[] = [];
  for (let day = 30; day >= 3; day--) {
    const date = toChDate(anchorMs - day * DAY);
    const synced = toChDateTime(anchorMs - 2 * DAY).slice(0, 19);
    const metrics = () => {
      const impressions = random.int(50, 400);
      const clicks = random.int(0, Math.floor(impressions / 5));
      return {
        clicks,
        impressions,
        ctr: Math.round((clicks / impressions) * 10_000) / 10_000,
        position: Math.round((1 + random.float() * 20) * 100) / 100,
      };
    };
    gscDaily.push({ project_id: projectId, date, ...metrics(), synced_at: synced });
    for (const page of ['https://example.com/', 'https://example.com/pricing', 'https://example.com/docs']) {
      gscPages.push({ project_id: projectId, date, page, ...metrics(), synced_at: synced });
    }
    for (const query of ['open source analytics', 'mixpanel alternative', 'example pricing']) {
      gscQueries.push({ project_id: projectId, date, query, ...metrics(), synced_at: synced });
    }
  }

  const matchedAt = toChDateTime(anchorMs - 1 * HOUR).slice(0, 19);
  const cohortMembers: CohortMemberRow[] = [
    ...['user-alice', 'user-chloe', 'user-hana'].map((profileId) => ({
      project_id: projectId,
      cohort_id: DATASET_COHORTS.powerUsers.id,
      profile_id: profileId,
      matched_at: matchedAt,
      matching_properties: {},
      version: anchorMs,
    })),
    ...['user-bob', 'user-dmitri', 'user-farah'].map((profileId) => ({
      project_id: projectId,
      cohort_id: DATASET_COHORTS.freePlan.id,
      profile_id: profileId,
      matched_at: matchedAt,
      matching_properties: {},
      version: anchorMs,
    })),
  ];

  events.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  return {
    projectId,
    anchor: new Date(anchorMs),
    events,
    sessions,
    profiles,
    groups,
    bots,
    replayChunks,
    gscDaily,
    gscPages,
    gscQueries,
    cohortMembers,
  };
}
