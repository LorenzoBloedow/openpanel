import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import { anQuery } from './client';
import { raw, sql } from './sql';
import {
  type TimeCtx,
  formatDate,
  formatDateTime,
  fromLocal,
  interval,
  parseTimestamp,
  startOf,
  toLocal,
  toLocalDate,
} from './time';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

function query<T extends Record<string, unknown>>(fragment: ReturnType<typeof sql>) {
  return runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, () =>
    anQuery<T>(fragment),
  );
}

async function evaluate(expression: ReturnType<typeof sql>): Promise<string> {
  const [row] = await query<{ value: string }>(sql`SELECT ${expression} AS value`);
  return row!.value;
}

const instant = (iso: string) => sql`${iso}::timestamptz`;

// Zones with DST, non-hour offsets and odd DST rules (see the plan's matrix).
const ZONES = [
  'America/New_York',
  'Europe/London',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'America/Havana',
  'Pacific/Chatham',
];

describe('time helpers', () => {
  it.each(ZONES)('buckets instants by local day in %s', async (timezone) => {
    const ctx: TimeCtx = { timezone };
    const at = '2024-03-10T12:34:56.789Z';
    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(at));
    expect(await evaluate(formatDate(startOf(instant(at), 'day', ctx)))).toBe(expected);
    expect(await evaluate(formatDateTime(startOf(instant(at), 'day', ctx)))).toBe(
      `${expected} 00:00:00`,
    );
  });

  it('converts wall-clock bounds across a DST change', async () => {
    const ctx: TimeCtx = { timezone: 'America/New_York' };
    // 2024-03-10: clocks jump from 02:00 EST to 03:00 EDT.
    const [row] = await query<{ before: string; after: string }>(sql`
      SELECT ${fromLocal('2024-03-10 00:00:00', ctx)} AS before,
             ${fromLocal('2024-03-10 12:00:00', ctx)} AS after
    `);
    expect(row).toEqual({
      before: '2024-03-10 05:00:00.000',
      after: '2024-03-10 16:00:00.000',
    });
  });

  it('starts weeks on Monday like toStartOfWeek(x, 1)', async () => {
    const ctx: TimeCtx = { timezone: 'UTC' };
    // Sunday 2024-03-17 → Monday 2024-03-11.
    expect(
      await evaluate(formatDate(startOf(instant('2024-03-17T10:00:00Z'), 'week', ctx))),
    ).toBe('2024-03-11');
  });

  it('keeps the local wall clock of an instant', async () => {
    const ctx: TimeCtx = { timezone: 'Asia/Kathmandu' };
    expect(
      await evaluate(formatDateTime(toLocal(instant('2024-01-01T00:00:00Z'), ctx))),
    ).toBe('2024-01-01 05:45:00');
  });

  it('builds interval literals', async () => {
    expect(await evaluate(sql`(${raw("'2024-01-31'::date")} + ${interval(1, 'month')})::date::text`)).toBe(
      '2024-02-29',
    );
    expect(() => interval(1.5, 'day')).toThrow();
  });

  it('parses date text like parseDateTimeBestEffortOrNull under a session zone', async () => {
    const ctx: TimeCtx = { timezone: 'Europe/Stockholm' };
    const parse = async (text: string | null) => {
      const [row] = await query<{ value: string | null }>(
        sql`SELECT ${parseTimestamp(sql`${text}::text`, ctx)} AS value`,
      );
      return row!.value;
    };
    // An explicit zone is that instant; without one it's Stockholm time.
    expect(await parse('2026-07-28T13:22:00.000Z')).toBe('2026-07-28 13:22:00.000');
    expect(await parse('2026-07-28T13:22:00+02:00')).toBe('2026-07-28 11:22:00.000');
    expect(await parse('2026-07-28 13:22')).toBe('2026-07-28 11:22:00.000');
    expect(await parse('2026-07-28')).toBe('2026-07-27 22:00:00.000');
    expect(await parse(' 2026-07-28 ')).toBe('2026-07-27 22:00:00.000');
    // Day first, and unix seconds.
    expect(await parse('28/07/2026')).toBe('2026-07-27 22:00:00.000');
    expect(await parse('1700000000')).toBe('2023-11-14 22:13:20.000');
    // Anything else is NULL, never an error.
    for (const text of ['abc', '', '34', '31/02/2026', null]) {
      expect(await parse(text), String(text)).toBeNull();
    }
  });

  it('reads the calendar date of an instant in a zone', async () => {
    const at = instant('2024-03-10T23:30:00Z');
    expect(await evaluate(sql`${toLocalDate(at, { timezone: 'UTC' })}::text`)).toBe('2024-03-10');
    expect(await evaluate(sql`${toLocalDate(at, { timezone: 'Europe/Stockholm' })}::text`)).toBe('2024-03-11');
  });
});
