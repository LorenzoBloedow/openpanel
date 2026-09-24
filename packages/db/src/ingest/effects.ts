import { cacheable } from '@openpanel/redis';
import type { IProjectFilterEvent } from '@openpanel/validation';

import { db } from '../prisma-client';
import type { IServiceCreateEventPayload } from '../services/event.service';
import { matchEvent } from '../services/event-match';

/**
 * Project settings the ingest consumer needs, from Postgres only (the
 * query services stay out of the consumer's bundle).
 */
export const getIngestProject = cacheable(
  'ingest:project',
  async (projectId: string) => {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, filters: true, firstEventAt: true },
    });
    if (!project) {
      return null;
    }
    return {
      id: project.id,
      eventFilters: (project.filters ?? []).filter(
        (filter): filter is IProjectFilterEvent => filter.type === 'event',
      ),
      hasFirstEvent: project.firstEventAt !== null,
    };
  },
  60,
);

/** The project's event exclusion filters (applied to detached events). */
export async function isExcludedByProjectFilter(
  payload: IServiceCreateEventPayload,
): Promise<boolean> {
  const project = await getIngestProject(payload.projectId);
  if (!project || project.eventFilters.length === 0) {
    return false;
  }
  return project.eventFilters.some((filter) => matchEvent(payload, filter));
}

/**
 * Records the project's first event once (the onboarding checklist). The
 * conditional update keeps concurrent consumers idempotent.
 */
export async function markFirstEvent(projectId: string): Promise<boolean> {
  const project = await getIngestProject(projectId);
  if (!project || project.hasFirstEvent) {
    return false;
  }
  const { count } = await db.project.updateMany({
    where: { id: projectId, firstEventAt: null },
    data: { firstEventAt: new Date() },
  });
  await getIngestProject.clear(projectId);
  return count > 0;
}

/** Whether the project has notification rules of each kind. */
export const getNotificationRuleKinds = cacheable(
  'ingest:notification-rules',
  async (projectId: string) => {
    const rules = await db.notificationRule.findMany({
      where: { projectId },
      select: { config: true },
    });
    return {
      // cacheable skips empty objects; keep a stable key.
      projectId,
      events: rules.some((rule) => rule.config.type === 'events'),
      funnel: rules.some((rule) => rule.config.type === 'funnel'),
    };
  },
  60,
);
