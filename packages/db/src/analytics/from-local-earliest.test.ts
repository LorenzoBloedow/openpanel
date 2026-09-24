import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import { anQuery } from './client';
import { sql } from './sql';
import { fromLocal, fromLocalEarliest } from './time';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

async function utc(instant: ReturnType<typeof sql>): Promise<string> {
  const [row] = await runWithScope(
    { env: { DATABASE_URL: testDb.url }, route: 'direct' },
    () =>
      anQuery<{ value: string }>(
        sql`SELECT to_char(${instant} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS value`,
      ),
  );
  return row!.value;
}

// `toString(toDateTime(wallClock), 'UTC')` under session_timezone = zone,
// from ClickHouse 26.1.
const CLICKHOUSE_READINGS: [wallClock: string, zone: string, utc: string][] = [
  // Skipped by the spring-forward change.
  ['2026-03-29 02:30:00', 'Europe/Stockholm', '2026-03-29 00:30:00'],
  ['2026-03-29 02:00:00', 'Europe/Stockholm', '2026-03-29 00:00:00'],
  ['2026-03-08 02:30:00', 'America/New_York', '2026-03-08 06:30:00'],
  ['2026-10-04 02:15:00', 'Australia/Lord_Howe', '2026-10-03 15:15:00'],
  ['2026-03-08 00:30:00', 'America/Havana', '2026-03-08 04:30:00'],
  ['2026-09-27 03:00:00', 'Pacific/Chatham', '2026-09-26 13:15:00'],
  // Repeated by the fall-back change.
  ['2026-10-25 02:30:00', 'Europe/Stockholm', '2026-10-25 00:30:00'],
  ['2026-11-01 01:30:00', 'America/New_York', '2026-11-01 05:30:00'],
  ['2026-04-05 01:45:00', 'Australia/Lord_Howe', '2026-04-04 14:45:00'],
  ['2026-11-01 00:30:00', 'America/Havana', '2026-11-01 04:30:00'],
  ['2026-04-05 03:00:00', 'Pacific/Chatham', '2026-04-04 13:15:00'],
  // Ordinary times, including right after a change.
  ['2026-03-29 03:00:00', 'Europe/Stockholm', '2026-03-29 01:00:00'],
  ['2026-10-25 03:30:00', 'Europe/Stockholm', '2026-10-25 02:30:00'],
  ['2026-10-04 02:30:00', 'Australia/Lord_Howe', '2026-10-03 15:30:00'],
  ['2026-06-01 12:00:00', 'Asia/Kathmandu', '2026-06-01 06:15:00'],
  ['2026-09-24 12:00:00', 'UTC', '2026-09-24 12:00:00'],
];

describe('fromLocalEarliest', () => {
  it.each(CLICKHOUSE_READINGS)('reads %s in %s as ClickHouse did', async (wallClock, timezone, expected) => {
    expect(await utc(fromLocalEarliest(wallClock, { timezone }))).toBe(expected);
  });

  it('only differs from fromLocal at DST changes', async () => {
    const ctx = { timezone: 'Europe/Stockholm' };
    expect(await utc(fromLocal('2026-03-29 02:30:00', ctx))).toBe('2026-03-29 01:30:00');
    expect(await utc(fromLocal('2026-10-25 02:30:00', ctx))).toBe('2026-10-25 01:30:00');
    for (const wallClock of ['2026-03-29 01:59:59', '2026-03-29 03:00:00', '2026-10-25 03:00:00', '2026-07-01 00:00:00']) {
      expect(await utc(fromLocalEarliest(wallClock, ctx))).toBe(await utc(fromLocal(wallClock, ctx)));
    }
  });
});
