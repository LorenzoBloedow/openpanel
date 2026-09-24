/**
 * The windowFunnel CTEs on Postgres against a literal JS replay of
 * ClickHouse's algorithm (test/fixtures/window-funnel-reference.ts): the
 * cases ClickHouse answered by hand, then random groups built to hit the
 * edges — timestamp ties, rows matching several steps, repeated steps,
 * zero and tiny windows, both modes.
 */
import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FUNNEL_CLICKHOUSE_CASES,
  type FunnelEvent,
  seededRandom,
  windowFunnelReference,
} from '../../test/fixtures/window-funnel-reference';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import { anQuery } from './client';
import { join, raw, sql } from './sql';
import { millisecondsInterval, windowFunnelCtes } from './window-funnel';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

interface Group {
  /** Partition key; `variant` may be null to cover NULL partition columns. */
  key: string;
  variant: string | null;
  events: FunnelEvent[];
}

/** Levels per `key|variant` from the Postgres CTEs. */
async function postgresLevels(
  groups: readonly Group[],
  stepCount: number,
  windowMs: number,
  strictIncrease: boolean,
): Promise<Map<string, number>> {
  const rows = groups.flatMap((group) =>
    group.events.map((event) => ({ ...event, key: group.key, variant: group.variant })),
  );
  const steps = Array.from({ length: stepCount }, (_, index) => `s${index + 1}`);
  const stepArrays = steps.map(
    (_, index) => sql`${rows.map((row) => row.matches[index] ?? false)}::boolean[]`,
  );
  const { ctes, levels } = windowFunnelCtes({
    source: 'src',
    partitionBy: ['key', 'variant'],
    time: 't',
    steps,
    window: millisecondsInterval(windowMs),
    strictIncrease,
    prefix: 'wf',
  });
  const source = sql`SELECT key, variant, timestamptz '2026-01-01 00:00:00+00' + ms * interval '1 millisecond' AS t, ${join(steps.map(raw))}
    FROM unnest(${rows.map((row) => row.key)}::text[], ${rows.map((row) => row.variant)}::text[], ${rows.map((row) => row.t)}::bigint[], ${join(stepArrays)})
      AS v(key, variant, ms, ${join(steps.map(raw))})`;
  const query = sql`WITH src AS (${source}), ${join(ctes.map((cte) => sql`${raw(cte.name)} AS (${cte.query})`))}
    SELECT key, variant, level FROM ${raw(levels)}`;
  const result = await runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, () =>
    anQuery<{ key: string; variant: string | null; level: number }>(query),
  );
  return new Map(result.map((row) => [`${row.key}|${row.variant}`, row.level]));
}

const NAMES = ['A', 'B', 'C', 'D'] as const;

describe('windowFunnelCtes', () => {
  it.each(FUNNEL_CLICKHOUSE_CASES)('matches ClickHouse: $name', async (testCase) => {
    const events = testCase.rows.map(([t, name]) => ({
      t: t * 1000,
      matches: testCase.steps.map((step) => step === name),
    }));
    const group: Group = { key: 'g', variant: 'v', events };
    const windowMs = testCase.window * 1000;
    expect(windowFunnelReference(events, testCase.steps.length, windowMs, testCase.strictIncrease)).toBe(
      testCase.level,
    );
    const levels = await postgresLevels([group], testCase.steps.length, windowMs, testCase.strictIncrease);
    expect(levels.get('g|v') ?? 0).toBe(testCase.level);
  });

  it('keeps partitions apart, NULL keys included', async () => {
    const chain = [
      { t: 0, matches: [true, false] },
      { t: 1000, matches: [false, true] },
    ];
    const levels = await postgresLevels(
      [
        { key: 'a', variant: null, events: [chain[0]!] },
        { key: 'a', variant: 'x', events: [chain[1]!] },
        { key: 'b', variant: null, events: chain },
      ],
      2,
      10_000,
      true,
    );
    expect(Object.fromEntries(levels)).toEqual({ 'a|null': 1, 'b|null': 2 });
  });

  it('matches the ClickHouse replay on random groups', async () => {
    const random = seededRandom(20_260_924);
    const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    let compared = 0;
    const reachedTop = { strict: 0, default: 0 };

    for (let round = 0; round < 40; round++) {
      const stepCount = int(1, 6);
      const accepted = Array.from({ length: stepCount }, () => {
        const names = NAMES.filter(() => random() < 0.4);
        return names.length > 0 ? names : [pick(NAMES)];
      });
      // Whole seconds make ties common; some rounds add milliseconds.
      const jitter = round % 3 === 0;
      const windowMs = pick([0, 1, 999, 1000, 2000, 3000, 5000, 10_000, 1_000_000]);
      const groups: Group[] = Array.from({ length: 60 }, (_, index) => ({
        key: `g${index % 30}`,
        variant: index < 30 ? null : 'v',
        events: Array.from({ length: int(1, 9) }, () => {
          const name = pick(NAMES);
          return {
            t: int(0, 12) * 1000 + (jitter ? int(0, 2) : 0),
            matches: accepted.map((names) => names.includes(name)),
          };
        }),
      }));

      for (const strictIncrease of [false, true]) {
        const actual = await postgresLevels(groups, stepCount, windowMs, strictIncrease);
        for (const group of groups) {
          const expected = windowFunnelReference(group.events, stepCount, windowMs, strictIncrease);
          const level = actual.get(`${group.key}|${group.variant}`) ?? 0;
          expect(
            level,
            JSON.stringify({ strictIncrease, windowMs, accepted, events: group.events }),
          ).toBe(expected);
          compared++;
          if (expected === stepCount && stepCount > 1) {
            reachedTop[strictIncrease ? 'strict' : 'default']++;
          }
        }
      }
    }
    expect(compared).toBe(40 * 60 * 2);
    // The random groups must actually exercise complete chains in both modes.
    expect(reachedTop.strict).toBeGreaterThan(20);
    expect(reachedTop.default).toBeGreaterThan(20);
  }, 60_000);
});
