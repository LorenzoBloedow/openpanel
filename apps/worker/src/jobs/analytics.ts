import { db, updateCohortMembership } from '@openpanel/db';
import { clix } from '@openpanel/db/src/analytics/query-builder';
import {
  createEngine,
  devicesModule,
  entryPagesModule,
  geoModule,
  insightStore,
  pageTrendsModule,
  referrersModule,
} from '@openpanel/db/src/services/insights';
import type {
  CohortComputePayload,
  InsightsQueuePayloadProject,
} from '@openpanel/queue';

/** Recompute a dynamic cohort's members. */
export async function cohortComputeJob({ cohortId }: CohortComputePayload) {
  await updateCohortMembership(cohortId);
}

const DEFAULT_ENGINE_CONFIG = {
  keepTopNPerModuleWindow: 20,
  closeStaleAfterDays: 7,
  dimensionBatchSize: 50,
  globalThresholds: {
    minTotal: 200,
    minAbsDelta: 80,
    minPct: 0.15,
  },
};

/** The daily insights of one project (deterministic modules, no AI). */
export async function insightsProjectJob({
  projectId,
  date,
}: InsightsQueuePayloadProject['payload']) {
  const engine = createEngine({
    store: insightStore,
    modules: [
      referrersModule,
      entryPagesModule,
      pageTrendsModule,
      geoModule,
      devicesModule,
    ],
    db: clix,
    config: DEFAULT_ENGINE_CONFIG,
  });
  const projectCreatedAt = await insightStore.getProjectCreatedAt(projectId);
  await engine.runProject({
    projectId,
    cadence: 'daily',
    now: new Date(date),
    projectCreatedAt,
  });
}

/** Projects due for the daily insights run. */
export function listInsightProjects() {
  return insightStore.listProjectIdsForCadence('daily');
}

/** Dynamic cohorts, refreshed every 30 minutes. */
export async function listDynamicCohorts() {
  const cohorts = await db.cohort.findMany({
    where: { isStatic: false },
    select: { id: true },
  });
  return cohorts.map((cohort) => cohort.id);
}
