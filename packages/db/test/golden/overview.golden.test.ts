import { vi } from 'vitest';

/**
 * One override, for the two getUserJourney cases. The journey keeps the top
 * three destinations of each page, and ClickHouse listed transitions with
 * equal counts in hash-table order, so which of several tied destinations
 * it kept was arbitrary (the port breaks ties by URL). For those cases the
 * port's own rows are reordered within each tie (same kind, step and
 * count) so the destinations ClickHouse kept come first; the counts, the
 * entry pages and the sankey building are the port's, and the output must
 * still equal the golden exactly.
 */
const { tieOrder } = vi.hoisted(() => ({
  tieOrder: { kept: null as Set<string> | null },
}));

vi.mock('../../src/analytics/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/client')>();
  interface JourneyRow {
    kind: string;
    source: string;
    target: string | null;
    step: number | null;
    value: number;
  }
  const rank = (row: JourneyRow) =>
    tieOrder.kept?.has(`${row.source}|${row.target}|${row.step}`) ? 0 : 1;
  // The query's ORDER BY (kind, step NULLS FIRST, value DESC), then the
  // kept rows first. The sort is stable, so the port's order stays otherwise.
  const compare = (a: JourneyRow, b: JourneyRow) =>
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
    (a.step ?? -1) - (b.step ?? -1) ||
    b.value - a.value ||
    rank(a) - rank(b);
  return {
    ...actual,
    anQuery: async (...args: Parameters<typeof actual.anQuery>) => {
      const rows = await actual.anQuery(...args);
      if (!(tieOrder.kept && rows[0] && 'kind' in rows[0])) {
        return rows;
      }
      return [...(rows as JourneyRow[])].sort(compare);
    },
  };
});

import * as overview from './cases/overview.cases';
import { describeGoldenGroup } from './compare';
import type { GoldenCase } from './harness';
import { readGoldenFile } from './harness';

const golden = readGoldenFile(overview.group);

/** `source|target|step` of every link the golden kept. */
function keptLinks(name: string): Set<string> {
  const expected = golden.cases[name];
  const links =
    expected && 'output' in expected
      ? ((expected.output as { links?: { source: string; target: string }[] })
          .links ?? [])
      : [];
  return new Set(
    links.map((link) => {
      const [source, step] = link.source.split('::step');
      return `${source}|${link.target.split('::step')[0]}|${step}`;
    }),
  );
}

function withClickhouseTieOrder(testCase: GoldenCase): GoldenCase {
  return {
    ...testCase,
    run: async (ctx) => {
      tieOrder.kept = keptLinks(testCase.name);
      try {
        return await testCase.run(ctx);
      } finally {
        tieOrder.kept = null;
      }
    },
  };
}

describeGoldenGroup(
  overview.group,
  overview.cases.map((testCase) =>
    testCase.name.startsWith('getUserJourney ')
      ? withClickhouseTieOrder(testCase)
      : testCase,
  ),
);
