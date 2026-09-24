import { cacheable } from '@openpanel/redis';
import type { IProjectFilterEvent } from '@openpanel/validation';

import { anQuery } from '../analytics/client';
import { convertClickhouseDateToJs } from '../analytics/dates';
import { sql } from '../analytics/sql';
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

interface EventRow {
  id: string;
  name: string;
  project_id: string;
  device_id: string;
  profile_id: string;
  session_id: string;
  properties: Record<string, unknown>;
  created_at: string;
  path: string;
  origin: string;
  referrer: string;
  referrer_name: string;
  referrer_type: string;
  country: string;
  city: string;
  region: string;
  os: string;
  os_version: string;
  browser: string;
  browser_version: string;
  device: string;
  brand: string;
  model: string;
  duration: number;
  revenue: number;
  groups: string[];
  sdk_name: string;
  sdk_version: string;
}

/**
 * The events of closed sessions, oldest first, as the payloads the
 * notification rules match on (session-end funnel rules).
 */
export async function getSessionEventPayloads(
  projectId: string,
  sessionIds: string[],
): Promise<Map<string, (IServiceCreateEventPayload & { id: string })[]>> {
  const rows = await anQuery<EventRow>(sql`
    SELECT id, name, project_id, device_id, profile_id, session_id, properties,
      created_at, path, origin, referrer, referrer_name, referrer_type, country,
      city, region, os, os_version, browser, browser_version, device, brand,
      model, duration, revenue, groups, sdk_name, sdk_version
    FROM analytics.events
    WHERE project_id = ${projectId}
      AND session_id = ANY(${sessionIds}::text[])
    ORDER BY created_at, id
  `);
  const bySession = new Map<string, (IServiceCreateEventPayload & { id: string })[]>();
  for (const row of rows) {
    const list = bySession.get(row.session_id) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      projectId: row.project_id,
      deviceId: row.device_id,
      profileId: row.profile_id,
      sessionId: row.session_id,
      properties: row.properties,
      createdAt: convertClickhouseDateToJs(row.created_at),
      path: row.path,
      origin: row.origin,
      referrer: row.referrer,
      referrerName: row.referrer_name,
      referrerType: row.referrer_type,
      country: row.country,
      city: row.city,
      region: row.region,
      os: row.os,
      osVersion: row.os_version,
      browser: row.browser,
      browserVersion: row.browser_version,
      device: row.device,
      brand: row.brand,
      model: row.model,
      duration: row.duration,
      revenue: row.revenue,
      groups: row.groups,
      sdkName: row.sdk_name,
      sdkVersion: row.sdk_version,
    });
    bySession.set(row.session_id, list);
  }
  return bySession;
}
