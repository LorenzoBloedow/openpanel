import { db } from '../prisma-client';

/**
 * Cohort names for breakdown labels (the cohort definitions live in
 * Postgres `public`; memberships in analytics.cohort_members, see
 * ./filters.ts).
 */
export interface CohortMetadata {
  id: string;
  name: string;
}

export async function fetchCohortsMetadata(
  cohortIds: string[],
): Promise<Map<string, CohortMetadata>> {
  if (cohortIds.length === 0) {
    return new Map();
  }
  const cohorts = await db.cohort.findMany({
    where: { id: { in: cohortIds } },
    select: { id: true, name: true },
  });
  return new Map(cohorts.map((cohort) => [cohort.id, cohort]));
}

export function fetchProjectCohorts(projectId: string): Promise<CohortMetadata[]> {
  return db.cohort.findMany({
    where: { projectId },
    select: { id: true, name: true },
  });
}
