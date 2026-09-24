import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { deleteOrganization, deleteProjects } from '@openpanel/db';
import {
  PROJECT_ANALYTICS_TABLES,
  deleteProjectAnalyticsChunk,
} from '@openpanel/db/src/analytics/maintenance';

import { inStepScope } from './scope';

export interface ProjectDeleteParams {
  projectIds: string[];
  organizationIds: string[];
}

const CHUNK_ROWS = 50_000;
const STEP_CONFIG = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

/**
 * Deletes projects' analytics data table by table in bounded chunks (each
 * chunk a durable, retried step), then the projects and organizations
 * themselves. Safe to rerun: every step is idempotent.
 */
export class ProjectDeleteWorkflow extends WorkflowEntrypoint<Env, ProjectDeleteParams> {
  async run(event: WorkflowEvent<ProjectDeleteParams>, step: WorkflowStep) {
    const { projectIds, organizationIds } = event.payload;
    let rows = 0;

    if (projectIds.length > 0) {
      for (const table of PROJECT_ANALYTICS_TABLES) {
        for (let round = 0; ; round++) {
          const deleted = await step.do(`delete ${table} #${round}`, STEP_CONFIG, () =>
            inStepScope(this.env, this.ctx, () =>
              deleteProjectAnalyticsChunk(table, projectIds, CHUNK_ROWS),
            ),
          );
          rows += deleted;
          if (deleted < CHUNK_ROWS) {
            break;
          }
        }
      }
      await step.do('delete projects', STEP_CONFIG, () =>
        inStepScope(this.env, this.ctx, async () => {
          await deleteProjects(projectIds);
        }),
      );
    }

    for (const organizationId of organizationIds) {
      await step.do(`delete organization ${organizationId}`, STEP_CONFIG, () =>
        inStepScope(this.env, this.ctx, async () => {
          await deleteOrganization(organizationId).catch((error: unknown) => {
            // Already gone (a previous attempt succeeded).
            if (
              error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'P2025'
            ) {
              return;
            }
            throw error;
          });
        }),
      );
    }

    return { projects: projectIds.length, organizations: organizationIds.length, rows };
  }
}
