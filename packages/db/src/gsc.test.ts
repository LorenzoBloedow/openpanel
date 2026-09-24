/**
 * Search Console storage on Postgres: syncGscData upserts what the API
 * returns (a re-sync replaces a day), and the reads bucket and bound the
 * stored days. (The reads are compared with ClickHouse in
 * test/golden/gsc.golden.test.ts.)
 */
import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { anQuery } from './analytics/client';
import { upsertGscRows } from './analytics/writers';
import { encrypt } from './encryption';
import { getGscOverview, getGscPages, getGscQueries, syncGscData } from './gsc';
import { db } from './prisma-client';
import { type TestDatabase, createTestDatabase } from './testing/database';

let testDb: TestDatabase;
const SYNCED = 'gsc-sync';
const READS = 'gsc-reads';

const inDb = <T>(fn: () => Promise<T>) =>
  runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, fn);

interface ApiRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

const apiRow = (keys: string[], clicks: number, impressions = 100): ApiRow => ({
  keys,
  clicks,
  impressions,
  ctr: clicks / impressions,
  position: 4.5,
});

/** A Search Analytics API that answers by the requested dimensions. */
function stubSearchAnalytics(byDimensions: Record<string, ApiRow[]>) {
  const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { dimensions: string[] };
    const rows = byDimensions[body.dimensions.join(',')] ?? [];
    return new Response(JSON.stringify({ rows }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeAll(async () => {
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  testDb = await createTestDatabase();
  await inDb(async () => {
    await db.organization.create({ data: { id: 'gsc-org', name: 'GSC' } });
    for (const id of [SYNCED, READS]) {
      await db.project.create({ data: { id, name: id, organizationId: 'gsc-org' } });
    }
    await db.gscConnection.create({
      data: {
        projectId: SYNCED,
        siteUrl: 'sc-domain:example.com',
        accessToken: encrypt('access-token'),
        refreshToken: encrypt('refresh-token'),
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await testDb?.drop();
});

describe('syncGscData', () => {
  it('upserts the three tables; a re-sync replaces the days it returns', async () => {
    const fetchMock = stubSearchAnalytics({
      date: [apiRow(['2026-09-18'], 10), apiRow(['2026-09-19'], 20)],
      'date,page': [
        apiRow(['2026-09-18', 'https://example.com/'], 4),
        // The same key twice in one response: the last row is kept.
        apiRow(['2026-09-18', 'https://example.com/'], 5),
        apiRow(['2026-09-18', 'https://example.com/docs'], 6),
      ],
      'date,query': [apiRow(['2026-09-19', "o'reilly analytics"], 7)],
    });

    await inDb(() =>
      syncGscData(SYNCED, new Date('2026-09-18T00:00:00Z'), new Date('2026-09-19T00:00:00Z')),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const request = JSON.parse(fetchMock.mock.calls[0]![1]!.body!) as Record<string, unknown>;
    expect(request).toMatchObject({ startDate: '2026-09-18', endDate: '2026-09-19' });

    const read = (table: string) =>
      inDb(() =>
        anQuery(
          `SELECT to_char(date, 'YYYY-MM-DD') AS date, page, clicks FROM analytics.${table}
           WHERE project_id = $1 ORDER BY date, page`,
          [SYNCED],
        ),
      );
    const readDaily = () =>
      inDb(() =>
        anQuery(
          `SELECT to_char(date, 'YYYY-MM-DD') AS date, clicks FROM analytics.gsc_daily
           WHERE project_id = $1 ORDER BY date`,
          [SYNCED],
        ),
      );

    expect(await readDaily()).toEqual([
      { date: '2026-09-18', clicks: 10 },
      { date: '2026-09-19', clicks: 20 },
    ]);
    expect(await read('gsc_pages_daily')).toEqual([
      { date: '2026-09-18', page: 'https://example.com/', clicks: 5 },
      { date: '2026-09-18', page: 'https://example.com/docs', clicks: 6 },
    ]);
    expect(
      await inDb(() =>
        anQuery('SELECT query, clicks FROM analytics.gsc_queries_daily WHERE project_id = $1', [
          SYNCED,
        ]),
      ),
    ).toEqual([{ query: "o'reilly analytics", clicks: 7 }]);

    stubSearchAnalytics({ date: [apiRow(['2026-09-19'], 25)] });
    await inDb(() =>
      syncGscData(SYNCED, new Date('2026-09-19T00:00:00Z'), new Date('2026-09-19T00:00:00Z')),
    );
    expect(await readDaily()).toEqual([
      { date: '2026-09-18', clicks: 10 },
      { date: '2026-09-19', clicks: 25 },
    ]);
  });
});

describe('GSC reads', () => {
  beforeAll(async () => {
    // Two Sunday-to-Saturday weeks: 2026-09-06..12 and 2026-09-13..19.
    const days = Array.from({ length: 14 }, (_, i) => `2026-09-${String(6 + i).padStart(2, '0')}`);
    await inDb(async () => {
      await upsertGscRows(
        'gsc_daily',
        days.map((date) => ({ project_id: READS, date, clicks: 1, impressions: 10, ctr: 0.1, position: 2 })),
      );
      await upsertGscRows(
        'gsc_queries_daily',
        days.map((date, i) => ({
          project_id: READS,
          date,
          query: i % 2 === 0 ? 'even' : 'odd',
          clicks: i,
          impressions: 10,
          ctr: 0.1,
          position: 2,
        })),
      );
    });
  });

  it('buckets weeks from Sunday and keeps a bucket only when it starts in range', async () => {
    // 2026-09-08 is a Tuesday: its week (from 09-06) starts before the range.
    const weeks = await inDb(() => getGscOverview(READS, '2026-09-08', '2026-09-19', 'week'));
    expect(weeks.map((row) => [row.date, row.clicks])).toEqual([['2026-09-13', 7]]);

    const months = await inDb(() => getGscOverview(READS, '2026-09-01', '2026-09-30', 'month'));
    expect(months).toEqual([
      { date: '2026-09-01', clicks: 14, impressions: 140, ctr: expect.closeTo(0.1, 6), position: 2 },
    ]);

    const days = await inDb(() => getGscOverview(READS, '2026-9-18', '2026-09-19'));
    expect(days.map((row) => row.date)).toEqual(['2026-09-18', '2026-09-19']);
  });

  it('orders by clicks and applies the limit', async () => {
    const queries = await inDb(() => getGscQueries(READS, '2026-09-06', '2026-09-19', 1));
    expect(queries.map((row) => [row.query, row.clicks])).toEqual([['odd', 49]]);
    expect(await inDb(() => getGscQueries(READS, '2026-09-06', '2026-09-19', 0))).toEqual([]);
  });

  it('matches nothing for bounds ClickHouse rejected, instead of failing', async () => {
    for (const [start, end] of [
      ['garbage', '2026-09-19'],
      ['2026-09-06 00:00:00', '2026-09-19'],
      ['2026-09-06', '2026-02-30'],
      ["2026-09-06' OR '1'='1", '2026-09-19'],
    ] as const) {
      expect(await inDb(() => getGscOverview(READS, start, end, 'week'))).toEqual([]);
      expect(await inDb(() => getGscPages(READS, start, end))).toEqual([]);
      expect(await inDb(() => getGscQueries(READS, start, end))).toEqual([]);
    }
  });
});
