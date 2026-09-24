/**
 * Records the golden outputs from the ClickHouse services (porting aid,
 * removed with ClickHouse). Needs a local ClickHouse 26.1 with the schema
 * from setup-clickhouse.ts:
 *
 *   pnpm vitest run --config vitest.golden.config.ts [GOLDEN_GROUPS=a,b]
 */
import pg from 'pg';
import { afterAll, beforeAll, it, vi } from 'vitest';

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

// The tRPC cacheMiddleware (router cases) still calls getRedisCache, which
// the Redis-free @openpanel/redis no longer exports: a cache that never hits.
vi.mock('@openpanel/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openpanel/redis')>()),
  getRedisCache: () => ({ getJson: async () => null, setJson: async () => undefined }),
}));

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

let ctx: GoldenContext;

const selected = process.env.GOLDEN_GROUPS?.split(',').filter(Boolean);

// Captures share one ClickHouse database and reload the datasets, so runs
// are serialized: a session advisory lock on the local Postgres, held for
// the whole run.
const lock = new pg.Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await lock.connect();
  await lock.query('SELECT pg_advisory_lock(hashtext($1))', ['golden-capture']);
  // Anchored after the lock, so ClickHouse's now() stays close to it.
  const anchor = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  ctx = { anchor, projects: GOLDEN_PROJECTS, datasets: buildDatasets(anchor) };
  await seedGoldenConfig();
  for (const dataset of Object.values(ctx.datasets)) {
    await loadDatasetIntoClickhouse(dataset);
  }
  freezeTime(anchor);
}, 3_600_000);

afterAll(async () => {
  await lock.query('SELECT pg_advisory_unlock(hashtext($1))', ['golden-capture']);
  await lock.end();
});

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
