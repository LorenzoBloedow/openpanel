/**
 * The overview, pages and referrer-spike queries on Postgres: the filter
 * mapping, the time buckets and WITH FILL emulation (overview-buckets.ts),
 * and behaviour the goldens (test/golden/{overview,pages}) don't reach —
 * the repeated hour of a DST fall-back, zones east and west of UTC, and the
 * inputs ClickHouse failed on.
 */
import { runWithScope } from '@openpanel/runtime';
import type { IChartEventFilter, IInterval } from '@openpanel/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { anQuery } from '../analytics/client';
import { type Sql, compile, raw, sql } from '../analytics/sql';
import {
  type EventWriteRow,
  type SessionWriteRow,
  insertEvents,
  upsertSessions,
} from '../analytics/writers';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import {
  bucketKey,
  bucketLabel,
  bucketOf,
  fillBuckets,
  rollupSentinelMatches,
  withFill,
} from './overview-buckets';
import { OverviewService } from './overview.service';
import { PagesService, getPageConversionsCore } from './pages.service';

let filterId = 0;
const filter = (
  name: string,
  operator: IChartEventFilter['operator'],
  value: IChartEventFilter['value'],
): IChartEventFilter => ({ id: `f${filterId++}`, name, operator, value });

const overview = new OverviewService();

describe('getRawWhereClause', () => {
  it('reads bare utm_* from the events properties', () => {
    const { text, values } = compile(
      overview.getRawWhereClause('events', [filter('utm_source', 'is', ['awn'])]),
    );
    expect(text).toContain('properties ->>');
    expect(values).toContain('__query.utm_source');
    expect(values).toContain('awn');
    expect(text).not.toMatch(/(?<![._\w])utm_source\s*=/);
  });

  it('keeps utm_* a column of the sessions table', () => {
    const { text } = compile(
      overview.getRawWhereClause('sessions', [filter('utm_source', 'is', ['awn'])]),
    );
    expect(text).toMatch(/^utm_source = \$1::text$/);
  });

  it('filters sessions on their entry page, qualified with the alias', () => {
    const { text, values } = compile(
      overview.getRawWhereClause(
        'sessions',
        [filter('path', 'contains', ['docs']), filter('origin', 'is', ['https://a.com'])],
        { alias: 's' },
      ),
    );
    expect(text).toContain('s.entry_path LIKE $1::text');
    expect(text).toContain('s.entry_origin = $2::text');
    expect(values).toEqual(['%docs%', 'https://a.com']);
  });

  it('drops names outside the whitelist and cohort operators', () => {
    const where = overview.getRawWhereClause('events', [
      filter('malicious_column', 'is', ['x']),
      filter('properties.__query.utm_source', 'is', ['x']),
      filter('profile.email', 'is', ['x']),
      { ...filter('country', 'inCohort', []), cohortId: 'c1' } as IChartEventFilter,
    ]);
    expect(where.isEmpty).toBe(true);
  });

  it('binds the values', () => {
    const hostile = "x' OR 1 = 1 --";
    const { text, values } = compile(
      overview.getRawWhereClause('events', [filter('referrer_name', 'is', [hostile])]),
    );
    expect(text).not.toContain(hostile);
    expect(values).toEqual([hostile]);
  });
});

describe('fillBuckets', () => {
  const labels = (interval: IInterval, start: string, end: string, zone: string) =>
    fillBuckets(interval, start, end, zone).map((bucket) => bucket.label);

  it('starts weeks on Sunday, from the week of the start date', () => {
    const weeks = labels('week', '2026-06-24 00:00:00', '2026-09-25 00:00:00', 'Europe/Stockholm');
    expect(weeks[0]).toBe('2026-06-21');
    expect(weeks.at(-1)).toBe('2026-09-20');
    expect(weeks).toHaveLength(14);
    expect(weeks.every((week) => new Date(`${week}T00:00:00Z`).getUTCDay() === 0)).toBe(true);
  });

  it('fills months up to the one before the end date', () => {
    const months = labels('month', '2025-09-01 00:00:00', '2026-10-01 00:00:00', 'UTC');
    expect(months).toHaveLength(13);
    expect(months[0]).toBe('2025-09-01');
    expect(months.at(-1)).toBe('2026-09-01');
  });

  it('steps hours in absolute time across DST', () => {
    // 02:00 does not exist on 2026-03-29 in Stockholm…
    expect(labels('hour', '2026-03-29 00:00:00', '2026-03-29 04:00:00', 'Europe/Stockholm')).toEqual([
      '2026-03-29 00:00:00',
      '2026-03-29 01:00:00',
      '2026-03-29 03:00:00',
    ]);
    // …and happens twice on 2026-10-25: two buckets, one label.
    const fallBack = fillBuckets('hour', '2026-10-25 01:00:00', '2026-10-25 04:00:00', 'Europe/Stockholm');
    expect(fallBack).toEqual([
      { key: '2026-10-24 23:00:00', label: '2026-10-25 01:00:00' },
      { key: '2026-10-25 00:00:00', label: '2026-10-25 02:00:00' },
      { key: '2026-10-25 01:00:00', label: '2026-10-25 02:00:00' },
      { key: '2026-10-25 02:00:00', label: '2026-10-25 03:00:00' },
    ]);
  });

  it('steps days in the local calendar', () => {
    const days = labels('day', '2026-03-07 00:00:00', '2026-03-10 00:00:00', 'America/New_York');
    expect(days).toEqual(['2026-03-07 00:00:00', '2026-03-08 00:00:00', '2026-03-09 00:00:00']);
  });

  it('starts from the bucket of the start and stops before the end', () => {
    expect(labels('minute', '2026-09-24 02:19:30', '2026-09-24 02:21:59', 'UTC')).toEqual([
      '2026-09-24 02:19:00',
      '2026-09-24 02:20:00',
      '2026-09-24 02:21:00',
    ]);
    expect(labels('hour', '2026-09-24 00:00:00', '2026-09-24 02:00:00', 'Asia/Kolkata')).toEqual([
      '2026-09-24 00:00:00',
      '2026-09-24 01:00:00',
    ]);
  });
});

describe('withFill', () => {
  it('adds the missing buckets in order and keeps rows outside the range', () => {
    const rows = [
      { key: '2026-01-02', v: 1 },
      { key: '2026-01-02', v: 2 },
      { key: '2027-01-01', v: 3 },
    ];
    const buckets = ['2026-01-01', '2026-01-02', '2026-01-03'].map((key) => ({ key, label: key }));
    expect(withFill(rows, (row) => row.key, buckets, (bucket) => ({ key: bucket.key, v: 0 }))).toEqual([
      { key: '2026-01-01', v: 0 },
      { key: '2026-01-02', v: 1 },
      { key: '2026-01-02', v: 2 },
      { key: '2026-01-03', v: 0 },
      { key: '2027-01-01', v: 3 },
    ]);
  });
});

describe('rollupSentinelMatches', () => {
  it('finds the ROLLUP row at or east of UTC, and always for date buckets', () => {
    expect(rollupSentinelMatches('day', 'UTC')).toBe(true);
    expect(rollupSentinelMatches('hour', 'Europe/Stockholm')).toBe(true);
    expect(rollupSentinelMatches('minute', 'Asia/Tokyo')).toBe(true);
    expect(rollupSentinelMatches('day', 'America/New_York')).toBe(false);
    expect(rollupSentinelMatches('week', 'America/New_York')).toBe(true);
    expect(rollupSentinelMatches('month', 'Pacific/Honolulu')).toBe(true);
  });
});

// --- on Postgres ---------------------------------------------------------------------

const PROJECT = 'overview-sql-test';
let testDb: TestDatabase;

function inDb<T>(fn: () => Promise<T>): Promise<T> {
  return runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, fn);
}

let eventSeq = 0;
function event(row: Partial<EventWriteRow> & { created_at: string; session_id: string }): EventWriteRow {
  eventSeq++;
  return {
    id: `00000000-0000-4000-8000-${String(eventSeq).padStart(12, '0')}`,
    name: 'screen_view',
    device_id: row.session_id,
    profile_id: row.session_id,
    project_id: PROJECT,
    origin: 'https://example.com',
    properties: {},
    ...row,
  };
}

function session(row: Partial<SessionWriteRow> & { id: string; created_at: string }): SessionWriteRow {
  return {
    project_id: PROJECT,
    profile_id: row.id,
    device_id: row.id,
    ended_at: row.created_at,
    is_bounce: false,
    entry_origin: 'https://example.com',
    entry_path: '/',
    exit_origin: 'https://example.com',
    exit_path: '/',
    screen_view_count: 1,
    revenue: 0,
    event_count: 1,
    duration: 0,
    country: 'SE',
    region: '',
    city: '',
    longitude: null,
    latitude: null,
    device: 'desktop',
    brand: '',
    model: '',
    browser: 'Chrome',
    browser_version: '',
    os: '',
    os_version: '',
    utm_medium: '',
    utm_source: '',
    utm_campaign: '',
    utm_content: '',
    utm_term: '',
    referrer: '',
    referrer_name: '',
    referrer_type: '',
    version: 1,
    ...row,
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await inDb(async () => {
    await upsertSessions([
      // The repeated 02:00 of the Stockholm fall-back: CEST, then CET.
      session({ id: 's-cest', created_at: '2026-10-25 00:30:00', duration: 60_000, entry_path: '/docs' }),
      session({ id: 's-cet', created_at: '2026-10-25 01:30:00', is_bounce: true, entry_path: '/docs' }),
      session({ id: 's-rev', created_at: '2026-09-10 10:00:00', revenue: 25, referrer_name: 'Google', entry_path: '/docs' }),
      session({ id: 's-direct', created_at: '2026-09-11 10:00:00', is_bounce: true, entry_path: '/docs' }),
    ]);
    await insertEvents([
      event({ session_id: 's-cest', created_at: '2026-10-25 00:30:00', path: '/docs' }),
      event({ session_id: 's-cest', created_at: '2026-10-25 00:31:00', path: '/pricing' }),
      event({ session_id: 's-cet', created_at: '2026-10-25 01:30:00', path: '/docs' }),
      event({ session_id: 's-rev', created_at: '2026-09-10 10:00:00', path: '/docs' }),
      event({ session_id: 's-rev', created_at: '2026-09-10 10:01:00', path: '/a' }),
      event({ session_id: 's-rev', created_at: '2026-09-10 10:02:00', path: '/b' }),
      event({ session_id: 's-rev', name: 'purchase', created_at: '2026-09-10 10:03:00', revenue: 25 }),
      event({ session_id: 's-direct', created_at: '2026-09-11 10:00:00', path: '/docs' }),
    ]);
  });
}, 120_000);

afterAll(async () => {
  await testDb?.drop();
});

describe('buckets on Postgres', () => {
  it('agree with the JS fill (keys and labels) across zones and DST', async () => {
    const zones = ['Europe/Stockholm', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'UTC'];
    // Minutes can't disagree: every zone offset is whole minutes.
    const intervals: IInterval[] = ['hour', 'day', 'week', 'month'];
    // Every 37 minutes over both 2026 DST changes of the northern zones.
    const instants = (from: string, to: string) =>
      sql`generate_series(${from}::timestamptz, ${to}::timestamptz, interval '37 minutes')`;
    for (const [from, to] of [
      ['2026-03-27T00:00:00Z', '2026-04-07T00:00:00Z'],
      ['2026-10-23T00:00:00Z', '2026-11-03T00:00:00Z'],
    ]) {
      for (const timezone of zones) {
        for (const interval of intervals) {
          if (timezone === 'Australia/Lord_Howe' && interval === 'hour') {
            // After its 30-minute DST shift, stepping whole hours (WITH FILL,
            // and fillBuckets after it) lands on :30 while the data sits on
            // local hours — in ClickHouse too.
            continue;
          }
          const ctx = { timezone };
          const bucket: Sql = raw('b.bucket');
          const rows = await inDb(() =>
            anQuery<{ key: string; label: string }>(sql`
              SELECT DISTINCT ${bucketKey(bucket, interval)} AS key, ${bucketLabel(bucket, interval, ctx)} AS label
              FROM (SELECT ${bucketOf(raw('t.at'), interval, ctx)} AS bucket FROM ${instants(from!, to!)} AS t(at)) b
              ORDER BY 1
            `),
          );
          // A window a little wider than the instants, in the zone's wall-clock time.
          const wall = (iso: string, shiftDays: number) =>
            new Date(new Date(iso).getTime() + shiftDays * 86_400_000)
              .toLocaleString('sv-SE', { timeZone: timezone })
              .slice(0, 19);
          const fill = new Map(
            fillBuckets(interval, wall(from!, -2), wall(to!, 2), timezone).map((b) => [b.key, b.label]),
          );
          for (const row of rows) {
            expect(fill.get(row.key), `${timezone} ${interval} ${row.key}`).toBe(row.label);
          }
        }
      }
    }
  }, 120_000);
});

describe('overview queries on Postgres', () => {
  const fallBack = {
    projectId: PROJECT,
    timezone: 'Europe/Stockholm',
    startDate: '2026-10-25 01:00:00',
    endDate: '2026-10-25 03:59:59',
    filters: [] as IChartEventFilter[],
  };

  it('keeps the two 02:00 hours of a DST fall-back apart', async () => {
    const result = await inDb(() => overview.getMetrics({ ...fallBack, interval: 'hour' }));
    expect(result.series.map((row) => [row.date, row.total_sessions])).toEqual([
      ['2026-10-25T01:00:00.000Z', 0],
      ['2026-10-25T02:00:00.000Z', 1],
      ['2026-10-25T02:00:00.000Z', 1],
      ['2026-10-25T03:00:00.000Z', 0],
    ]);
    expect(result.metrics.total_sessions).toBe(2);
    expect(result.metrics.bounce_rate).toBe(50);
    expect(result.metrics.avg_session_duration).toBe(60);
  });

  it('reports no overall bounce rate with a page filter west of UTC', async () => {
    const input = { ...fallBack, interval: 'day' as const, filters: [filter('path', 'is', ['/docs'])] };
    const east = await inDb(() => overview.getMetrics(input));
    const west = await inDb(() => overview.getMetrics({ ...input, timezone: 'America/New_York', startDate: '2026-10-24 00:00:00', endDate: '2026-10-25 23:59:59' }));
    expect(east.metrics.bounce_rate).toBe(50);
    expect(west.metrics.bounce_rate).toBe(0);
    expect(west.metrics.total_sessions).toBe(2);
  });

  const september = {
    projectId: PROJECT,
    timezone: 'UTC',
    startDate: '2026-09-01 00:00:00',
    endDate: '2026-09-30 23:59:59',
  };

  it('applies a revenue filter to the top lists (ClickHouse failed on it)', async () => {
    const filters = [filter('revenue', 'gt', ['0'])];
    const [pages, entries, referrers] = await inDb(() =>
      Promise.all([
        overview.getTopPages({ ...september, filters }),
        overview.getTopEntryExit({ ...september, filters, mode: 'entry' }),
        overview.getTopGeneric({ ...september, filters, column: 'referrer_name' }),
      ]),
    );
    // Screen views carry no revenue; the session does.
    expect(pages).toEqual([]);
    expect(entries).toEqual([{ origin: 'https://example.com', path: '/docs', sessions: 1, pageviews: 1, revenue: 25 }]);
    expect(referrers).toEqual([{ name: 'Google', sessions: 1, pageviews: 1, revenue: 25 }]);
  });

  it('fills the series and returns ISO dates with a page filter too', async () => {
    const { items } = await inDb(() =>
      overview.getTopGenericSeries({
        ...september,
        startDate: '2026-09-09 00:00:00',
        endDate: '2026-09-12 00:00:00',
        filters: [filter('path', 'is', ['/docs'])],
        column: 'referrer_name',
        interval: 'day',
      }),
    );
    const byName = new Map(items.map((item) => [item.name, item.data]));
    expect(byName.get('Google')).toEqual([
      { date: '2026-09-10T00:00:00.000Z', sessions: 1, pageviews: 1, revenue: 25 },
    ]);
    // The empty value (direct) also collects the filled days, as it did.
    expect(byName.get(null as unknown as string)).toEqual([
      { date: '2026-09-09T00:00:00.000Z', sessions: 0, pageviews: 0, revenue: 0 },
      { date: '2026-09-11T00:00:00.000Z', sessions: 1, pageviews: 1, revenue: 0 },
    ]);
  });

  it('orders tied journey transitions by URL', async () => {
    const journey = await inDb(() =>
      overview.getUserJourney({ ...fallBack, filters: [], startDate: '2026-09-01 00:00:00', endDate: '2026-10-31 00:00:00', steps: 5 }),
    );
    expect(journey.links.map((link) => `${link.source} -> ${link.target} ${link.value}`)).toEqual([
      'https://example.com/docs::step1 -> https://example.com/a::step2 1',
      'https://example.com/docs::step1 -> https://example.com/pricing::step2 1',
      'https://example.com/a::step2 -> https://example.com/b::step3 1',
    ]);
    expect(journey.nodes.map((node) => [node.id, node.value])).toEqual([
      ['https://example.com/docs::step1', 2],
      ['https://example.com/a::step2', 1],
      ['https://example.com/pricing::step2', 1],
      ['https://example.com/b::step3', 1],
    ]);
  });

  it('matches nothing for inputs ClickHouse rejected', async () => {
    const base = { projectId: PROJECT, startDate: '2026-09-01', endDate: '2026-09-30', conversionEvent: 'purchase' };
    const [valid, badWindow, badDate, badMode] = await inDb(() =>
      Promise.all([
        getPageConversionsCore(base),
        getPageConversionsCore({ ...base, windowHours: Number.NaN }),
        getPageConversionsCore({ ...base, startDate: 'not a date' }),
        overview.getTopEntryExit({ ...september, filters: [], mode: 'middle' as never }),
      ]),
    );
    expect(valid.map((row) => [row.path, row.unique_converters, row.total_visitors, row.conversion_rate])).toEqual([
      ['/a', 1, 1, 100],
      ['/b', 1, 1, 100],
      ['/docs', 1, 2, 50],
    ]);
    expect(badWindow).toEqual([]);
    expect(badDate).toEqual([]);
    expect(badMode).toEqual([]);
  });

  it('reports page durations and bounce rates, with a bound search', async () => {
    const pages = new PagesService();
    const [docs, hostile] = await inDb(() =>
      Promise.all([
        pages.getTopPages({ ...september, search: 'docs' }),
        pages.getTopPages({ ...september, search: "%' OR '1'='1" }),
      ]),
    );
    // /docs: 60 s before the next view in one session, 0 in the other.
    expect(docs).toEqual([
      {
        origin: 'https://example.com',
        path: '/docs',
        title: '',
        sessions: 2,
        pageviews: 2,
        avg_duration: 0.5,
        bounce_rate: 50,
      },
    ]);
    expect(hostile).toEqual([]);
  });
});
