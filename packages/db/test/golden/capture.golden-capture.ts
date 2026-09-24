/**
 * Records the golden outputs from the ClickHouse services (porting aid,
 * removed with ClickHouse). Needs a local ClickHouse 26.1 with the schema
 * from setup-clickhouse.ts:
 *
 *   pnpm vitest run --config vitest.golden.config.ts [GOLDEN_GROUPS=a,b]
 */
import { beforeAll, it, vi } from 'vitest';

// The buffers construct Redis-backed singletons at import; the read paths
// only touch these methods.
vi.mock('../../src/buffers', () => {
  const noop = async () => undefined;
  const buffer = { add: noop, tryFlush: noop, getBufferSize: async () => 0 };
  return {
    eventBuffer: { ...buffer, getActiveVisitorCount: async () => 0 },
    profileBuffer: { ...buffer, fetchFromCache: async () => null },
    botBuffer: buffer,
    sessionBuffer: { ...buffer, getExistingSession: async () => null },
    groupBuffer: buffer,
    replayBuffer: buffer,
    profileBackfillBuffer: buffer,
  };
});

import { loadDatasetIntoClickhouse } from '../fixtures/load-clickhouse';
import { GOLDEN_GROUPS } from './cases';
import {
  GOLDEN_PROJECTS,
  type GoldenContext,
  buildDatasets,
  captureGroup,
  freezeTime,
  seedGoldenConfig,
} from './harness';

const anchor = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const ctx: GoldenContext = {
  anchor,
  projects: GOLDEN_PROJECTS,
  datasets: buildDatasets(anchor),
};

const selected = process.env.GOLDEN_GROUPS?.split(',').filter(Boolean);

beforeAll(async () => {
  await seedGoldenConfig();
  for (const dataset of Object.values(ctx.datasets)) {
    await loadDatasetIntoClickhouse(dataset);
  }
  freezeTime(anchor);
}, 600_000);

for (const [group, cases] of Object.entries(GOLDEN_GROUPS)) {
  if (selected && !selected.includes(group)) {
    continue;
  }
  it(`captures ${group}`, async () => {
    const file = await captureGroup(group, cases, ctx, 'ClickHouse 26.1.3.52');
    const errors = Object.entries(file.cases).filter(([, result]) => 'error' in result);
    if (errors.length > 0) {
      console.warn(`${group}: ${errors.length} case(s) captured as errors`, errors.slice(0, 5));
    }
  }, 600_000);
}
