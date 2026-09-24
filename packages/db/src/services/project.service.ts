import { cacheable } from '@openpanel/redis';
import { anQuery, anQueryOne } from '../analytics/client';
import { convertClickhouseDateToJs } from '../analytics/dates';
import { sql } from '../analytics/sql';
import { db, type Prisma, type Project } from '../prisma-client';

export type IServiceProject = Project;
export type IServiceProjectWithClients = Prisma.ProjectGetPayload<{
  include: {
    clients: true;
  };
}>;

export async function getProjectById(id: string) {
  const res = await db.project.findUnique({
    where: {
      id,
    },
  });

  if (!res) {
    return null;
  }

  return res;
}

/** L1 LRU (60s) + L2 Redis. clear() invalidates Redis + local LRU; other nodes may serve stale from LRU for up to 60s. */
export const getProjectByIdCached = cacheable(getProjectById, 60 * 60 * 24);

export async function getProjectWithClients(id: string) {
  const res = await db.project.findUnique({
    where: {
      id,
    },
    include: {
      clients: true,
    },
  });

  if (!res) {
    return null;
  }

  return res;
}

export async function getProjects({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string | null;
}) {
  if (!userId) {
    return [];
  }

  const [projects, members, access] = await Promise.all([
    db.project.findMany({
      where: {
        organizationId,
      },
      orderBy: {
        eventsCount: 'desc',
      },
    }),
    db.member.findMany({
      where: {
        userId,
        organizationId,
      },
    }),
    db.projectAccess.findMany({
      where: {
        userId,
        organizationId,
      },
    }),
  ]);

  if (members.length === 0) {
    return [];
  }

  if (access.length > 0) {
    return projects.filter((project) =>
      access.some((a) => a.projectId === project.id)
    );
  }

  return projects;
}

/**
 * A project's event count (excluding session_start / session_end), from the
 * analytics.event_names rollup the ingest transaction keeps: a few rows per
 * project instead of a scan of its events. Exact (the ClickHouse MV it
 * replaces could undercount).
 */
export const getProjectEventsCount = async (projectId: string) => {
  const row = await anQueryOne<{ count: number | null }>(sql`
    SELECT sum(event_count)::bigint AS count
    FROM analytics.event_names
    WHERE project_id = ${projectId}
      AND name NOT IN ('session_start', 'session_end')
  `);
  return row?.count ?? 0;
};

/**
 * Newest event timestamp per project, for the whole instance in one query,
 * from the same rollup. Session rows are worker-generated (the reaper can
 * emit session_end after tracking stopped), so only real tracking counts.
 * Projects with no events are absent from the map.
 */
export const getLastEventPerProject = async (): Promise<Map<string, Date>> => {
  const rows = await anQuery<{ project_id: string; last_event_at: string }>(sql`
    SELECT project_id, max(last_seen_at) AS last_event_at
    FROM analytics.event_names
    WHERE name NOT IN ('session_start', 'session_end')
    GROUP BY project_id
  `);
  return new Map(
    rows.map((row) => [row.project_id, convertClickhouseDateToJs(row.last_event_at)]),
  );
};

/**
 * Resolve and validate a projectId for an API client.
 *
 * - Read clients: returns the fixed projectId from the client (ignores any supplied value).
 * - Root clients: validates that the supplied projectId belongs to the client's organization.
 *
 * Throws if the project is not found or does not belong to the organization.
 * Use this as the single source of truth for projectId resolution across the API and MCP.
 */
export async function resolveClientProjectId({
  clientType,
  clientProjectId,
  organizationId,
  inputProjectId,
}: {
  clientType: 'read' | 'root';
  clientProjectId: string | null;
  organizationId: string;
  inputProjectId: string | undefined;
}): Promise<string> {
  if (clientType !== 'root') {
    if (!clientProjectId) {
      throw new Error('Client is not associated with a project');
    }
    return clientProjectId;
  }

  if (!inputProjectId) {
    throw new Error(
      'projectId is required when using a root (organization-level) client'
    );
  }

  const project = await db.project.findFirst({
    where: { id: inputProjectId, organizationId },
    select: { id: true },
  });

  if (!project) {
    throw new Error(
      'Project not found or does not belong to your organization'
    );
  }

  return inputProjectId;
}

export async function listProjectsCore(input: {
  clientType: 'root' | 'read';
  organizationId: string;
  projectId: string | null;
}) {
  if (input.clientType === 'root') {
    const projects = await db.project.findMany({
      where: { organizationId: input.organizationId },
      orderBy: { eventsCount: 'desc' },
      select: {
        id: true,
        name: true,
        organizationId: true,
        eventsCount: true,
        domain: true,
        types: true,
      },
    });
    return { clientType: 'root', projects };
  }

  const project = input.projectId
    ? await db.project.findUnique({
        where: { id: input.projectId },
        select: {
          id: true,
          name: true,
          organizationId: true,
          eventsCount: true,
          domain: true,
          types: true,
        },
      })
    : null;

  return {
    clientType: 'read',
    projects: project ? [project] : [],
  };
}
