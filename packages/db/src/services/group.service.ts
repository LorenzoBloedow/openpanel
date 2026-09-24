import { toDots } from '@openpanel/common';
import { anQuery, anQueryOne } from '../analytics/client';
import { formatClickhouseDate } from '../analytics/dates';
import { type Sql, and, or, sql } from '../analytics/sql';
import { upsertGroups } from '../analytics/writers';
import type { IServiceProfile } from './profile.service';
import { getProfiles } from './profile.service';

export type IServiceGroup = {
  id: string;
  projectId: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type IServiceUpsertGroup = {
  id: string;
  projectId: string;
  type: string;
  name: string;
  properties?: Record<string, unknown>;
};

type IClickhouseGroup = {
  project_id: string;
  id: string;
  type: string;
  name: string;
  properties: Record<string, string>;
  created_at: string;
  version: string;
};

/**
 * Groups are one row per (project, id): an upsert with a newer `version`
 * (the write time in ms, read back as updatedAt) replaces the row, and a
 * deleted group is a deleted row.
 */
const GROUP_COLUMNS = sql`project_id, id, type, name, properties, created_at, version`;

function transformGroup(row: IClickhouseGroup): IServiceGroup {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    name: row.name,
    properties: row.properties,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(Number(row.version)),
  };
}

async function writeGroup(group: {
  id: string;
  projectId: string;
  type: string;
  name: string;
  properties: Record<string, string>;
  createdAt?: Date;
}) {
  await upsertGroups([
    {
      project_id: group.projectId,
      id: group.id,
      type: group.type,
      name: group.name,
      properties: group.properties,
      created_at: formatClickhouseDate(group.createdAt ?? new Date()),
      version: Date.now(),
    },
  ]);
}

export async function upsertGroup(input: IServiceUpsertGroup) {
  const existing = await getGroupById(input.id, input.projectId);
  await writeGroup({
    id: input.id,
    projectId: input.projectId,
    type: input.type,
    name: input.name,
    properties: toDots({
      ...(existing?.properties ?? {}),
      ...(input.properties ?? {}),
    }),
    createdAt: existing?.createdAt,
  });
}

export async function getGroupById(
  id: string,
  projectId: string,
): Promise<IServiceGroup | null> {
  const row = await anQueryOne<IClickhouseGroup>(sql`
    SELECT ${GROUP_COLUMNS}
    FROM analytics.groups
    WHERE project_id = ${projectId} AND id = ${id}
  `);
  return row ? transformGroup(row) : null;
}

/** Type and name/id search (a LIKE pattern as typed) of the group list. */
function groupListWhere({
  projectId,
  type,
  search,
}: {
  projectId: string;
  type?: string;
  search?: string;
}): Sql {
  const like = sql`${`%${search}%`}::text`;
  return and([
    sql`project_id = ${projectId}`,
    type ? sql`type = ${type}::text` : null,
    search ? or([sql`name ILIKE ${like}`, sql`id ILIKE ${like}`]) : null,
  ]);
}

export async function getGroupList({
  projectId,
  cursor,
  take,
  search,
  type,
}: {
  projectId: string;
  cursor?: number;
  take: number;
  search?: string;
  type?: string;
}): Promise<IServiceGroup[]> {
  const rows = await anQuery<IClickhouseGroup>(sql`
    SELECT ${GROUP_COLUMNS}
    FROM analytics.groups
    WHERE ${groupListWhere({ projectId, type, search })}
    ORDER BY created_at DESC
    LIMIT ${take}
    OFFSET ${Math.max(0, (cursor ?? 0) * take)}
  `);
  return rows.map(transformGroup);
}

export async function getGroupListCount({
  projectId,
  type,
  search,
}: {
  projectId: string;
  type?: string;
  search?: string;
}): Promise<number> {
  const row = await anQueryOne<{ count: number }>(sql`
    SELECT count(*) AS count
    FROM analytics.groups
    WHERE ${groupListWhere({ projectId, type, search })}
  `);
  return row?.count ?? 0;
}

export async function getGroupTypes(projectId: string): Promise<string[]> {
  const rows = await anQuery<{ type: string }>(sql`
    SELECT DISTINCT type
    FROM analytics.groups
    WHERE project_id = ${projectId}
  `);
  return rows.map((r) => r.type);
}

export async function createGroup(input: IServiceUpsertGroup) {
  await upsertGroup(input);
  return getGroupById(input.id, input.projectId);
}

export async function updateGroup(
  id: string,
  projectId: string,
  data: { type?: string; name?: string; properties?: Record<string, unknown> },
) {
  const existing = await getGroupById(id, projectId);
  if (!existing) {
    throw new Error(`Group ${id} not found`);
  }
  const mergedProperties = {
    ...(existing.properties ?? {}),
    ...(data.properties ?? {}),
  };
  const normalizedProperties = toDots(
    mergedProperties as Record<string, unknown>,
  );
  const updated = {
    id,
    projectId,
    type: data.type ?? existing.type,
    name: data.name ?? existing.name,
    properties: normalizedProperties,
    createdAt: existing.createdAt,
  };
  await writeGroup(updated);
  return { ...existing, ...updated };
}

export async function deleteGroup(id: string, projectId: string) {
  const existing = await getGroupById(id, projectId);
  if (!existing) {
    throw new Error(`Group ${id} not found`);
  }
  await anQuery(sql`
    DELETE FROM analytics.groups
    WHERE project_id = ${projectId} AND id = ${id}
  `);
  return existing;
}

export async function getGroupPropertyKeys(
  projectId: string,
): Promise<string[]> {
  const rows = await anQuery<{ key: string }>(sql`
    SELECT DISTINCT jsonb_object_keys(properties) AS key
    FROM analytics.groups
    WHERE project_id = ${projectId}
  `);
  return rows.map((r) => r.key).sort();
}

export type IServiceGroupStats = {
  groupId: string;
  memberCount: number;
  lastActiveAt: Date | null;
};

/**
 * Identified members (distinct profiles) and the last event of each group,
 * from the events that carry the group.
 */
export async function getGroupStats(
  projectId: string,
  groupIds: string[],
): Promise<Map<string, IServiceGroupStats>> {
  if (groupIds.length === 0) {
    return new Map();
  }

  const rows = await anQuery<{
    group_id: string;
    member_count: number;
    last_active_at: string;
  }>(sql`
    SELECT
      g AS group_id,
      count(DISTINCT e.profile_id) AS member_count,
      max(e.created_at) AS last_active_at
    FROM analytics.events e
    CROSS JOIN LATERAL unnest(e.groups) AS g
    WHERE e.project_id = ${projectId}
      AND e.groups && ${groupIds}::text[]
      AND g = ANY(${groupIds}::text[])
      AND e.profile_id <> e.device_id
    GROUP BY g
  `);

  return new Map(
    rows.map((r) => [
      r.group_id,
      {
        groupId: r.group_id,
        memberCount: r.member_count,
        lastActiveAt: r.last_active_at ? new Date(r.last_active_at) : null,
      },
    ]),
  );
}

export async function getGroupsByIds(
  projectId: string,
  ids: string[],
): Promise<IServiceGroup[]> {
  if (ids.length === 0) {
    return [];
  }

  const rows = await anQuery<IClickhouseGroup>(sql`
    SELECT ${GROUP_COLUMNS}
    FROM analytics.groups
    WHERE project_id = ${projectId} AND id = ANY(${ids}::text[])
  `);
  return rows.map(transformGroup);
}

export async function getGroupMemberProfiles({
  projectId,
  groupId,
  cursor,
  take,
  search,
}: {
  projectId: string;
  groupId: string;
  cursor?: number;
  take: number;
  search?: string;
}): Promise<{ data: IServiceProfile[]; count: number }> {
  const offset = Math.max(0, (cursor ?? 0) * take);
  const term = search?.trim();
  const like = sql`${`%${term}%`}::text`;
  const searchCondition = term
    ? or([
        sql`email ILIKE ${like}`,
        sql`first_name ILIKE ${like}`,
        sql`last_name ILIKE ${like}`,
      ])
    : null;

  // The count is a window over the page's rows: past the last page it is 0.
  const rows = await anQuery<{ id: string; total_count: number }>(sql`
    SELECT id, count(*) OVER () AS total_count
    FROM analytics.profiles
    WHERE ${and([
      sql`project_id = ${projectId}`,
      sql`${groupId}::text = ANY(groups)`,
      searchCondition,
    ])}
    ORDER BY created_at DESC
    LIMIT ${take}
    OFFSET ${offset}
  `);

  const count = rows[0]?.total_count ?? 0;
  const profileIds = rows.map((r) => r.id);

  if (profileIds.length === 0) {
    return { data: [], count };
  }

  const profiles = await getProfiles(profileIds, projectId);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const data = profileIds
    .map((id) => byId.get(id))
    .filter(Boolean) as IServiceProfile[];
  return { data, count };
}

export async function listGroupTypesCore(projectId: string) {
  const types = await getGroupTypes(projectId);
  return { types };
}

export async function findGroupsCore(input: {
  projectId: string;
  type?: string;
  search?: string;
  limit?: number;
}) {
  return getGroupList({
    projectId: input.projectId,
    type: input.type,
    search: input.search,
    take: input.limit ?? 20,
  });
}

export async function getGroupCore(input: {
  projectId: string;
  groupId: string;
  memberLimit?: number;
}) {
  const [group, members] = await Promise.all([
    getGroupById(input.groupId, input.projectId),
    getGroupMemberProfiles({
      projectId: input.projectId,
      groupId: input.groupId,
      take: input.memberLimit ?? 10,
    }),
  ]);

  if (!group) {
    throw new Error(`Group not found: ${input.groupId}`);
  }

  return {
    group,
    member_count: members.count,
    members: members.data,
  };
}
