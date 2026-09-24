/**
 * Replays a golden group against the Postgres port.
 *
 * The golden file records the anchor it was captured at. Its Postgres twin
 * is built once per anchor as a template database (the migrated schema, the
 * golden config rows and the three datasets generated for that anchor);
 * every test file then clones it, sets it as the fallback env, freezes the
 * clock at the anchor and runs the group's cases through `compareCases`.
 *
 *   // test/golden/overview.golden.test.ts
 *   import { overviewCases } from './cases/overview.cases';
 *   import { describeGoldenGroup } from './compare';
 *   describeGoldenGroup('overview', overviewCases);
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  disposeFallbackScope,
  runWithScope,
  setFallbackEnv,
} from '@openpanel/runtime';
import { afterAll, beforeAll, describe, vi } from 'vitest';

import {
  type TestDatabase,
  createTestDatabase,
  ensureDerivedTemplate,
} from '../../src/testing/database';
import { loadDatasetIntoPostgres } from '../fixtures/load-postgres';
import {
  GOLDEN_DIR,
  GOLDEN_PROJECTS,
  type GoldenCase,
  type GoldenContext,
  buildDatasets,
  compareCases,
  freezeTime,
  readGoldenFile,
  seedGoldenConfig,
} from './harness';

/** What the golden template depends on besides the migrations. */
function fixturesFingerprint(anchor: Date): string {
  const hash = createHash('sha256').update(anchor.toISOString());
  for (const file of [
    '../fixtures/analytics-dataset.ts',
    '../fixtures/load-postgres.ts',
    'harness.ts',
  ]) {
    hash.update(readFileSync(join(GOLDEN_DIR, file)));
  }
  return hash.digest('hex');
}

/** The golden template for `anchor`, built on first use. */
export async function ensureGoldenTemplate(anchor: Date): Promise<string> {
  const name = `openpanel_golden_${Math.floor(anchor.getTime() / 60_000)}`;
  return ensureDerivedTemplate(name, fixturesFingerprint(anchor), async (url) => {
    await runWithScope({ env: { DATABASE_URL: url }, route: 'direct' }, async () => {
      await seedGoldenConfig();
      for (const dataset of Object.values(buildDatasets(anchor))) {
        await loadDatasetIntoPostgres(dataset);
      }
    });
  });
}

export function describeGoldenGroup(group: string, cases: GoldenCase[]) {
  const golden = readGoldenFile(group);
  const anchor = new Date(golden.anchor);
  let database: TestDatabase | undefined;
  let ctx: GoldenContext | undefined;

  describe(`golden: ${group}`, () => {
    beforeAll(async () => {
      const template = await ensureGoldenTemplate(anchor);
      database = await createTestDatabase({ template });
      setFallbackEnv({ DATABASE_URL: database.url, SELF_HOSTED: 'true' });
      ctx = {
        anchor,
        projects: GOLDEN_PROJECTS,
        datasets: buildDatasets(anchor),
      };
      freezeTime(anchor);
    }, 600_000);

    afterAll(async () => {
      vi.useRealTimers();
      await disposeFallbackScope();
      setFallbackEnv(undefined);
      await database?.drop();
    });

    compareCases(group, cases, () => {
      if (!ctx) {
        throw new Error('golden context is not ready');
      }
      return ctx;
    });
  });
}
