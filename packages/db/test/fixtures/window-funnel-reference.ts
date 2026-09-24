/**
 * ClickHouse's windowFunnel (AggregateFunctionWindowFunnel, default and
 * 'strict_increase' modes), replayed literally in JS: the oracle the
 * Postgres queries in src/analytics/window-funnel.ts are checked against.
 * Checked against ClickHouse 26.1 itself on ~58k random groups (both modes,
 * ties, repeated and overlapping steps); FUNNEL_CLICKHOUSE_CASES below are
 * a few of them with ClickHouse's answers.
 */

/** A deterministic [0, 1) generator (Park–Miller) for the random groups. */
export function seededRandom(seed: number): () => number {
  const MODULUS = 2_147_483_647;
  let state = seed % MODULUS || 1;
  return () => {
    state = (state * 48_271) % MODULUS;
    return (state - 1) / (MODULUS - 1);
  };
}

export interface FunnelEvent {
  /** Timestamp in the window's unit (ms for the funnel, s for conversion). */
  t: number;
  /** Which steps the row matches, in step order. */
  matches: readonly boolean[];
}

export function windowFunnelReference(
  events: readonly FunnelEvent[],
  stepCount: number,
  window: number,
  strictIncrease: boolean,
): number {
  // One entry per matched step; ClickHouse adds them in reverse step order
  // and then sorts by (timestamp, step).
  const entries: [number, number][] = [];
  for (const event of events) {
    for (let step = stepCount; step >= 1; step--) {
      if (event.matches[step - 1]) {
        entries.push([event.t, step]);
      }
    }
  }
  if (entries.length === 0) {
    return 0;
  }
  if (stepCount === 1) {
    return 1;
  }
  entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // Per step, the (start, time) of the latest chain that reached it.
  const chains: ([number, number] | undefined)[] = new Array(stepCount);
  for (const [t, step] of entries) {
    const index = step - 1;
    if (index === 0) {
      chains[0] = [t, t];
      continue;
    }
    const previous = chains[index - 1];
    if (!previous) {
      continue;
    }
    const inWindow = t <= previous[0] + window;
    const ordered = !strictIncrease || previous[1] < t;
    if (inWindow && ordered) {
      chains[index] = [previous[0], t];
      if (index + 1 === stepCount) {
        return stepCount;
      }
    }
  }
  for (let level = stepCount; level > 0; level--) {
    if (chains[level - 1]) {
      return level;
    }
  }
  return 0;
}

/**
 * Hand-picked groups with the level ClickHouse 26.1 returned
 * (`windowFunnel(window[, 'strict_increase'])(t, n = 'A', …)`).
 */
export const FUNNEL_CLICKHOUSE_CASES: {
  name: string;
  /** `[t, name]` rows; step `i` matches name `steps[i]`. */
  rows: [number, string][];
  steps: string[];
  window: number;
  strictIncrease: boolean;
  level: number;
}[] = [
  { name: 'one row matching three steps, default', rows: [[1, 'a']], steps: ['a', 'a', 'a'], window: 10, strictIncrease: false, level: 3 },
  { name: 'one row matching three steps, strict', rows: [[1, 'a']], steps: ['a', 'a', 'a'], window: 10, strictIncrease: true, level: 1 },
  { name: 'repeated step never advances when strict', rows: [[1, 'A'], [2, 'A'], [2, 'A'], [3, 'A']], steps: ['A', 'A', 'A'], window: 10, strictIncrease: true, level: 1 },
  { name: 'repeated step, default', rows: [[1, 'A'], [5, 'A']], steps: ['A', 'A', 'A'], window: 10, strictIncrease: false, level: 3 },
  { name: 'same-time restart blocks a strict chain', rows: [[1, 'A'], [2, 'A'], [2, 'B']], steps: ['A', 'B'], window: 10, strictIncrease: true, level: 1 },
  { name: 'same-time step joins in default mode', rows: [[1, 'A'], [2, 'A'], [2, 'B']], steps: ['A', 'B'], window: 10, strictIncrease: false, level: 2 },
  { name: 'window is inclusive', rows: [[0, 'A'], [10, 'B']], steps: ['A', 'B'], window: 10, strictIncrease: false, level: 2 },
  { name: 'a restart does not move the older chain', rows: [[0, 'A'], [5, 'B'], [10, 'A'], [12, 'C']], steps: ['A', 'B', 'C'], window: 10, strictIncrease: false, level: 2 },
  { name: 'a restarted chain can finish', rows: [[0, 'A'], [5, 'B'], [10, 'A'], [11, 'B'], [12, 'C']], steps: ['A', 'B', 'C'], window: 10, strictIncrease: false, level: 3 },
  { name: 'latest start is used', rows: [[0, 'A'], [5, 'A'], [6, 'B'], [11, 'C']], steps: ['A', 'B', 'C'], window: 10, strictIncrease: false, level: 3 },
  { name: 'a later start does not rescue an older chain', rows: [[0, 'A'], [6, 'B'], [7, 'A'], [11, 'C']], steps: ['A', 'B', 'C'], window: 10, strictIncrease: false, level: 2 },
];
