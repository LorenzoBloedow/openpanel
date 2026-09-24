/**
 * ClickHouse's `windowFunnel(window[, 'strict_increase'])(t, cond1, …, condN)`
 * on Postgres, as a chain of CTEs.
 *
 * ClickHouse's algorithm, per group: every row adds one entry `(t, i)` per
 * step `i` it matches; the entries are sorted by `(t, i)` and replayed while
 * keeping, per step, the (start, time) of the latest chain that reached it:
 *
 * - a step-1 entry starts a chain: step 1 ← (t, t);
 * - a step-i entry extends the chain held by step i-1 when
 *   `t <= start + window` (and, strict, when that chain's time `< t`):
 *   step i ← (start, t);
 * - the level is the highest step ever reached.
 *
 * This is greedy, not "the longest chain that exists": step i-1 only holds
 * the latest chain, and because entries sort by `(t, i)`, a step-(i-1)
 * entry at the same timestamp replaces it just before the step-i entry is
 * read. In strict mode a step-i row therefore never extends a chain from a
 * row with its own timestamp — including itself, which is why a funnel of
 * the same event three times stays at level 1 — and in the default mode one
 * row matching steps 1–3 reaches level 3 alone. The golden funnels depend
 * on both, so the queries reproduce the replay exactly rather than search
 * for chains.
 *
 * The replay needs no loop. The entry a step-i row reads is the latest
 * step-(i-1) success at or before its time (same-time entries of step i-1
 * sort first), and chain starts never decrease along a step's successes (a
 * step-1 chain starts at its own time; a later row reads a later chain).
 * So one window pass per step, over that step's candidate rows and the
 * previous step's successes ordered by (time, predecessor first), finds each
 * candidate's chain with a running `max` of the predecessors' times and
 * starts. test/fixtures/window-funnel-reference.ts replays ClickHouse's
 * algorithm literally; window-funnel.test.ts checks these queries against
 * it on random groups.
 */
import { type Sql, empty, join, raw, sql } from './sql';

export interface WindowFunnelOptions {
  /** CTE (or table) with one row per event: the columns below. */
  source: string;
  /** Columns identifying one funnel (ClickHouse's GROUP BY keys). */
  partitionBy: readonly string[];
  /** Timestamp column the window and the ordering use. */
  time: string;
  /** One boolean column per step, in step order: does the row match it? */
  steps: readonly string[];
  /** The window length, an `interval`. */
  window: Sql;
  /** ClickHouse's 'strict_increase': each step strictly after the previous. */
  strictIncrease: boolean;
  /** Name prefix of the generated CTEs. */
  prefix: string;
}

export interface WindowFunnelCtes {
  /** CTEs to register, in order, after `source`. */
  ctes: { name: string; query: Sql }[];
  /**
   * Name of the CTE with `<partitionBy…>, level`: one row per partition
   * that reached level 1 or more. Partitions that are missing are level 0.
   */
  levels: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

const identifier = (name: string): Sql => raw(checkIdentifier(name));

export function windowFunnelCtes(options: WindowFunnelOptions): WindowFunnelCtes {
  const { partitionBy, steps, window, strictIncrease } = options;
  if (steps.length === 0 || partitionBy.length === 0) {
    throw new Error('windowFunnel needs at least one step and one partition column');
  }
  const source = identifier(options.source);
  const time = identifier(options.time);
  const keys = join(partitionBy.map(identifier));
  const prefix = checkIdentifier(options.prefix);
  const firstStep = identifier(steps[0]!);

  const ctes: WindowFunnelCtes['ctes'] = [];
  // Every step-1 row starts a chain at its own time.
  let reached = sql`SELECT ${keys}, ${time} AS _at, ${time} AS _start FROM ${source} WHERE ${firstStep}`;
  const reachedLevels: Sql[] = [
    sql`SELECT ${keys}, 1 AS level FROM ${source} WHERE ${firstStep}`,
  ];

  steps.slice(1).forEach((step, index) => {
    const level = index + 2;
    const name = `${prefix}_step_${level}`;
    const strict = strictIncrease ? sql` AND _chain_at < _at` : empty;
    // Predecessors sort before candidates at the same time, so each
    // candidate sees every chain that reached the previous step at or
    // before its time; the running max is the latest such chain.
    const query = sql`SELECT ${keys}, _at, _chain_start AS _start
      FROM (
        SELECT ${keys}, _at, _candidate,
          max(_pred_at) OVER _w AS _chain_at,
          max(_pred_start) OVER _w AS _chain_start
        FROM (
          SELECT ${keys}, _at, false AS _candidate, _at AS _pred_at, _start AS _pred_start
          FROM (${reached}) AS _reached
          UNION ALL
          SELECT ${keys}, ${time}, true, NULL, NULL FROM ${source} WHERE ${identifier(step)}
        ) AS _entries
        WINDOW _w AS (PARTITION BY ${keys} ORDER BY _at, _candidate ROWS UNBOUNDED PRECEDING)
      ) AS _replayed
      WHERE _candidate AND _at <= _chain_start + ${window}${strict}`;
    ctes.push({ name, query });
    reached = sql`SELECT ${keys}, _at, _start FROM ${raw(name)}`;
    reachedLevels.push(sql`SELECT ${keys}, ${raw(String(level))} AS level FROM ${raw(name)}`);
  });

  const levels = `${prefix}_levels`;
  ctes.push({
    name: levels,
    query: sql`SELECT ${keys}, max(level) AS level
      FROM (${join(reachedLevels, ' UNION ALL ')}) AS _reached_levels
      GROUP BY ${keys}`,
  });
  return { ctes, levels };
}

/** `ms` milliseconds as an interval (the funnel's window unit). */
export function millisecondsInterval(ms: number): Sql {
  return sql`(${ms}::double precision * interval '1 millisecond')`;
}
