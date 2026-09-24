import { clix } from '../../../src/analytics/query-builder';
import { createEngine } from '../../../src/services/insights/engine';
import {
  devicesModule,
  entryPagesModule,
  geoModule,
  pageTrendsModule,
  referrersModule,
} from '../../../src/services/insights/modules';
import type {
  ComputeResult,
  InsightModule,
  InsightStore,
  WindowKind,
} from '../../../src/services/insights/types';
import { getReferrerSpikes } from '../../../src/services/referrer-spikes.service';
import type { GoldenCase, GoldenContext, GoldenProjectKey } from '../harness';
import { FILTERS, window } from './common';
import { pid } from './pages.cases';

const MODULES: Record<string, InsightModule> = {
  referrers: referrersModule,
  'entry-pages': entryPagesModule,
  'page-trends': pageTrendsModule,
  geo: geoModule,
  devices: devicesModule,
};

/** DEFAULT_ENGINE_CONFIG of apps/worker/src/jobs/analytics.ts */
const WORKER_ENGINE_CONFIG = {
  keepTopNPerModuleWindow: 20,
  closeStaleAfterDays: 7,
  dimensionBatchSize: 50,
  globalThresholds: { minTotal: 200, minAbsDelta: 80, minPct: 0.15 },
};

interface WindowCapture {
  kind: WindowKind;
  dimensions: string[];
  results: ComputeResult[];
  insights: unknown[];
}

/**
 * Runs one insight module for a project the way the daily worker job does
 * (createEngine().runProject, `now` = the UTC day of the anchor), against an
 * in-memory store: nothing is written. The module is wrapped to record what
 * enumerateDimensions and computeMany return for every window, next to the
 * insights the engine would persist (after thresholds, scoring, rendering).
 *
 * `dimensions` replaces the module's enumeration (to compute chosen keys).
 */
async function runInsightModule(
  ctx: GoldenContext,
  project: GoldenProjectKey,
  moduleKey: string,
  dimensions?: string[],
) {
  const module = MODULES[moduleKey]!;
  const windows = new Map<WindowKind, WindowCapture>();
  const capture = (kind: WindowKind) => {
    let entry = windows.get(kind);
    if (!entry) {
      entry = { kind, dimensions: [], results: [], insights: [] };
      windows.set(kind, entry);
    }
    return entry;
  };

  const recording: InsightModule = {
    ...module,
    async enumerateDimensions(computeCtx) {
      const keys = dimensions ?? (await module.enumerateDimensions!.call(module, computeCtx));
      capture(computeCtx.window.kind).dimensions = [...keys];
      return keys;
    },
    async computeMany(computeCtx, keys) {
      const results = await module.computeMany.call(module, computeCtx, keys);
      capture(computeCtx.window.kind).results.push(...results.map((result) => ({ ...result })));
      return results;
    },
  };

  let nextId = 0;
  const store: InsightStore = {
    listProjectIdsForCadence: async () => [],
    getProjectCreatedAt: async () => null,
    getActiveInsightByIdentity: async () => null,
    upsertInsight: async (args) => {
      capture(args.window.kind).insights.push({
        dimensionKey: args.dimensionKey,
        card: args.card,
        metrics: args.metrics,
        decision: args.decision,
      });
      nextId++;
      return {
        id: `memory-${nextId}`,
        projectId: args.projectId,
        moduleKey: args.moduleKey,
        dimensionKey: args.dimensionKey,
        windowKind: args.window.kind,
        state: 'active',
        version: 1,
        impactScore: args.metrics.impactScore,
        lastSeenAt: args.now,
        lastUpdatedAt: args.now,
        direction: args.metrics.direction ?? null,
        severityBand: args.metrics.severityBand ?? null,
      };
    },
    insertEvent: async () => undefined,
    closeMissingActiveInsights: async () => 0,
    applySuppression: async () => ({ deleted: 0 }),
  };

  // The engine logs and skips a failing module; surface that as an error.
  // It builds each window's context (cached query builder) from the query
  // factory it takes as `db`, as the worker job passes it.
  const errors: unknown[] = [];
  const engine = createEngine({
    store,
    modules: [recording],
    db: clix,
    logger: { info: () => undefined, warn: () => undefined, error: (...args) => errors.push(args) },
    config: WORKER_ENGINE_CONFIG,
  });
  await engine.runProject({
    projectId: pid(project),
    cadence: 'daily',
    now: new Date(ctx.anchor.toISOString().slice(0, 10)),
    projectCreatedAt: null,
  });
  if (errors.length > 0) {
    throw new Error(`insights engine errors: ${JSON.stringify(errors).slice(0, 500)}`);
  }
  return { windows: [...windows.values()] };
}

// Dimension order ranks by max(current, baseline) with ties in the order the
// engine returned the groups; results and insights follow that order.
const UNORDERED = ['windows.*.dimensions', 'windows.*.results', 'windows.*.insights'];

const RUNS: [GoldenProjectKey, string][] = [
  ['sthlm', 'referrers'],
  ['sthlm', 'entry-pages'],
  ['sthlm', 'page-trends'],
  ['sthlm', 'geo'],
  ['sthlm', 'devices'],
  ['ny', 'referrers'],
  ['ny', 'entry-pages'],
  ['ny', 'page-trends'],
  ['ny', 'geo'],
  ['ny', 'devices'],
  ['utc', 'referrers'],
  ['utc', 'entry-pages'],
  ['utc', 'page-trends'],
  ['utc', 'geo'],
  ['utc', 'devices'],
];

export const group = 'insights';

export const cases: GoldenCase[] = [
  ...RUNS.map(([project, moduleKey]) => ({
    name: `${moduleKey} ${project} all windows`,
    run: (ctx: GoldenContext) => runInsightModule(ctx, project, moduleKey),
    unordered: UNORDERED,
  })),
  // computeMany for chosen keys: missing dimensions, the 'direct'/'unknown'
  // fallbacks, and keys of another module (skipped).
  {
    name: 'referrers sthlm chosen dimensions',
    run: (ctx) =>
      runInsightModule(ctx, 'sthlm', 'referrers', [
        'referrer:Google',
        'referrer:direct',
        'referrer:Newsletter',
        'referrer:Bing',
        'country:SE',
      ]),
    unordered: UNORDERED,
  },
  {
    name: 'geo ny chosen dimensions',
    run: (ctx) =>
      runInsightModule(ctx, 'ny', 'geo', ['country:US', 'country:unknown', 'country:ZZ']),
    unordered: UNORDERED,
  },
  {
    name: 'page-trends utc chosen dimensions',
    run: (ctx) =>
      runInsightModule(ctx, 'utc', 'page-trends', [
        'page:https://example.com|||/pricing',
        'page:https://app.example.com|||/dashboard',
        'page:https://example.com|||/missing',
        'entry:https://example.com|||/pricing',
      ]),
    unordered: UNORDERED,
  },

  // Referrer spike markers (also reached through overview.getReferrerSpikes
  // in the routers group). The dataset has no spike, so this is [].
  {
    name: 'getReferrerSpikes utc 3m week countrySE',
    run: () =>
      getReferrerSpikes({ ...window('utc', '3m'), interval: 'week', filters: FILTERS.countrySE }),
  },
];
