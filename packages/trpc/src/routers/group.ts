import {
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupList,
  getGroupListCount,
  getGroupMemberProfiles,
  getGroupPropertyKeys,
  getGroupStats,
  getGroupsByIds,
  getGroupTypes,
  toNullIfDefaultMinDate,
  updateGroup,
} from '@openpanel/db';
import { anQuery } from '@openpanel/db/src/analytics/client';
import { gapFill } from '@openpanel/db/src/analytics/fill';
import { sql } from '@openpanel/db/src/analytics/sql';
import { zCreateGroup, zUpdateGroup } from '@openpanel/validation';
import { z } from 'zod';
import { createdSince } from '../analytics-time';
import { createTRPCRouter, protectedProcedure } from '../trpc';

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' of an instant in UTC. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const groupRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        cursor: z.number().optional(),
        take: z.number().default(50),
        search: z.string().optional(),
        type: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const [data, count] = await Promise.all([
        getGroupList(input),
        getGroupListCount(input),
      ]);
      const stats = await getGroupStats(
        input.projectId,
        data.map((g) => g.id)
      );
      return {
        data: data.map((g) => ({
          ...g,
          memberCount: stats.get(g.id)?.memberCount ?? 0,
          lastActiveAt: stats.get(g.id)?.lastActiveAt ?? null,
        })),
        meta: { count, take: input.take },
      };
    }),

  byId: protectedProcedure
    .input(z.object({ id: z.string(), projectId: z.string() }))
    .query(({ input: { id, projectId } }) => {
      return getGroupById(id, projectId);
    }),

  create: protectedProcedure
    .input(zCreateGroup)
    .mutation(({ input }) => {
      return createGroup(input);
    }),

  update: protectedProcedure
    .input(zUpdateGroup)
    .mutation(({ input: { id, projectId, ...data } }) => {
      return updateGroup(id, projectId, data);
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string(), projectId: z.string() }))
    .mutation(({ input: { id, projectId } }) => {
      return deleteGroup(id, projectId);
    }),

  types: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input: { projectId } }) => {
      return getGroupTypes(projectId);
    }),

  metrics: protectedProcedure
    .input(z.object({ id: z.string(), projectId: z.string() }))
    .query(async ({ input: { id, projectId } }) => {
      const [eventData, profileData] = await Promise.all([
        anQuery<{
          totalEvents: number;
          firstSeen: string | null;
          lastSeen: string | null;
        }>(sql`
          SELECT
            count(*) AS "totalEvents",
            min(created_at) AS "firstSeen",
            max(created_at) AS "lastSeen"
          FROM analytics.events
          WHERE project_id = ${projectId}
            AND ${id}::text = ANY(groups)
        `),
        anQuery<{ uniqueProfiles: number }>(sql`
          SELECT count(*) AS "uniqueProfiles"
          FROM analytics.profiles
          WHERE project_id = ${projectId}
            AND ${id}::text = ANY(groups)
        `),
      ]);

      return {
        totalEvents: eventData[0]?.totalEvents ?? 0,
        uniqueProfiles: profileData[0]?.uniqueProfiles ?? 0,
        firstSeen: toNullIfDefaultMinDate(eventData[0]?.firstSeen),
        lastSeen: toNullIfDefaultMinDate(eventData[0]?.lastSeen),
      };
    }),

  activity: protectedProcedure
    .input(z.object({ id: z.string(), projectId: z.string() }))
    .query(({ input: { id, projectId } }) => {
      // UTC days, as ClickHouse's toStartOfDay without a session time zone.
      return anQuery<{ count: number; date: string }>(sql`
        SELECT count(*) AS count, to_char(e.day, 'YYYY-MM-DD HH24:MI:SS') AS date
        FROM (
          SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day
          FROM analytics.events
          WHERE project_id = ${projectId}
            AND ${id}::text = ANY(groups)
        ) AS e
        GROUP BY e.day
        ORDER BY e.day DESC
      `);
    }),

  memberGrowth: protectedProcedure
    .input(z.object({ id: z.string(), projectId: z.string() }))
    .query(async ({ input: { id, projectId } }) => {
      // UTC days of the last 30 days; empty days from 29 days ago through
      // today are filled (ClickHouse WITH FILL).
      const now = Date.now();
      const rows = await anQuery<{ date: string; count: number }>(sql`
        SELECT to_char(p.day, 'YYYY-MM-DD') AS date, count(*) AS count
        FROM (
          SELECT (created_at AT TIME ZONE 'UTC')::date AS day
          FROM analytics.profiles
          WHERE project_id = ${projectId}
            AND ${id}::text = ANY(groups)
            AND ${createdSince(new Date(now - 30 * DAY_MS))}
        ) AS p
        GROUP BY p.day
        ORDER BY p.day
      `);
      return gapFill(rows, {
        key: 'date',
        from: utcDay(now - 29 * DAY_MS),
        to: utcDay(now + DAY_MS),
        unit: 'day',
        format: 'date',
        fill: (date) => ({ date, count: 0 }),
      });
    }),

  listProfiles: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        groupId: z.string(),
        cursor: z.number().optional(),
        take: z.number().default(50),
        search: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const { data, count } = await getGroupMemberProfiles({
        projectId: input.projectId,
        groupId: input.groupId,
        cursor: input.cursor,
        take: input.take,
        search: input.search,
      });
      return {
        data,
        meta: { count, pageCount: input.take },
      };
    }),

  mostEvents: protectedProcedure
    .input(z.object({ id: z.string(), projectId: z.string() }))
    .query(({ input: { id, projectId } }) => {
      return anQuery<{ count: number; name: string }>(sql`
        SELECT count(*) AS count, name
        FROM analytics.events
        WHERE project_id = ${projectId}
          AND ${id}::text = ANY(groups)
          AND name NOT IN ('screen_view', 'session_start', 'session_end')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
      `);
    }),

  popularRoutes: protectedProcedure
    .input(z.object({ id: z.string(), projectId: z.string() }))
    .query(({ input: { id, projectId } }) => {
      return anQuery<{ count: number; path: string }>(sql`
        SELECT count(*) AS count, path
        FROM analytics.events
        WHERE project_id = ${projectId}
          AND ${id}::text = ANY(groups)
          AND name = 'screen_view'
        GROUP BY path
        ORDER BY count DESC
        LIMIT 10
      `);
    }),

  properties: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input: { projectId } }) => {
      return getGroupPropertyKeys(projectId);
    }),

  listByIds: protectedProcedure
    .input(z.object({ projectId: z.string(), ids: z.array(z.string()) }))
    .query(({ input: { projectId, ids } }) => {
      return getGroupsByIds(projectId, ids);
    }),
});
