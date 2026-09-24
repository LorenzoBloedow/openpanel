import { pipe, sort, uniq } from 'ramda';
import { z } from 'zod';

import {
  getProfileById,
  getProfileList,
  getProfileListCount,
  getProfileMetrics,
  getProfiles,
  isProfileColumn,
} from '@openpanel/db';
import { anQuery } from '@openpanel/db/src/analytics/client';
import { ident, sql } from '@openpanel/db/src/analytics/sql';
import { zChartEventFilter } from '@openpanel/validation';

import { TRPCBadRequestError } from '../errors';
import { createTRPCRouter, protectedProcedure } from '../trpc';

export const profileRouter = createTRPCRouter({
  byId: protectedProcedure
    .input(z.object({ profileId: z.string(), projectId: z.string() }))
    .query(async ({ input: { profileId, projectId } }) => {
      return getProfileById(profileId, projectId);
    }),

  metrics: protectedProcedure
    .input(z.object({ profileId: z.string(), projectId: z.string() }))
    .query(async ({ input: { profileId, projectId } }) => {
      return getProfileMetrics(profileId, projectId);
    }),

  activity: protectedProcedure
    .input(z.object({ profileId: z.string(), projectId: z.string() }))
    .query(async ({ input: { profileId, projectId } }) => {
      // UTC days, as ClickHouse's toStartOfDay without a session time zone.
      return anQuery<{ count: number; date: string }>(sql`
        SELECT count(*) AS count, to_char(e.day, 'YYYY-MM-DD HH24:MI:SS') AS date
        FROM (
          SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day
          FROM analytics.events
          WHERE project_id = ${projectId} AND profile_id = ${profileId}
        ) AS e
        GROUP BY e.day
        ORDER BY e.day DESC
      `);
    }),

  mostEvents: protectedProcedure
    .input(z.object({ profileId: z.string(), projectId: z.string() }))
    .query(async ({ input: { profileId, projectId } }) => {
      return anQuery<{ count: number; name: string }>(sql`
        SELECT count(*) AS count, name
        FROM analytics.events
        WHERE name NOT IN ('screen_view', 'session_start', 'session_end')
          AND project_id = ${projectId}
          AND profile_id = ${profileId}
        GROUP BY name
        ORDER BY count DESC
      `);
    }),

  popularRoutes: protectedProcedure
    .input(z.object({ profileId: z.string(), projectId: z.string() }))
    .query(async ({ input: { profileId, projectId } }) => {
      return anQuery<{ count: number; path: string }>(sql`
        SELECT count(*) AS count, path
        FROM analytics.events
        WHERE name = 'screen_view'
          AND project_id = ${projectId}
          AND profile_id = ${profileId}
        GROUP BY path
        ORDER BY count DESC
        LIMIT 10
      `);
    }),

  properties: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input: { projectId } }) => {
      const keys = await anQuery<{ key: string }>(sql`
        SELECT DISTINCT k.key
        FROM analytics.profiles AS p
        CROSS JOIN LATERAL jsonb_object_keys(p.properties) AS k(key)
        WHERE p.project_id = ${projectId}
      `);

      const properties = keys
        .map((row) => row.key)
        .map((item) => item.replace(/\.([0-9]+)\./g, '.*.'))
        .map((item) => item.replace(/\.([0-9]+)/g, '[*]'))
        .map((item) => `properties.${item}`);

      properties.push('id', 'first_name', 'last_name', 'email');

      return pipe(
        sort<string>((a, b) => a.length - b.length),
        uniq,
      )(properties);
    }),

  list: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        cursor: z.number().optional(),
        take: z.number().default(50),
        search: z.string().optional(),
        isExternal: z.boolean().optional(),
        filters: z.array(zChartEventFilter).default([]),
      }),
    )
    .query(async ({ input }) => {
      const [data, count] = await Promise.all([
        getProfileList(input),
        getProfileListCount(input),
      ]);
      return {
        data,
        meta: {
          count,
          pageCount: input.take,
        },
      };
    }),

  powerUsers: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        cursor: z.number().optional(),
        take: z.number().default(50),
      }),
    )
    .query(async ({ input: { projectId, cursor, take } }) => {
      const res = await anQuery<{ profile_id: string; count: number }>(sql`
        SELECT profile_id, count(*) AS count
        FROM analytics.events
        WHERE profile_id <> ''
          AND project_id = ${projectId}
        GROUP BY profile_id
        ORDER BY count DESC
        LIMIT ${take} OFFSET ${(cursor ?? 0) * take}
      `);
      const profiles = await getProfiles(
        res.map((r) => r.profile_id),
        projectId,
      );

      const data = res
        .map((item) => {
          return {
            count: item.count,
            ...(profiles.find((p) => p.id === item.profile_id)! ?? {}),
          };
        })
        // Make sure we return actual profiles
        .filter((item) => item.id);

      return {
        data,
        meta: {
          count: data.length,
          pageCount: take,
        },
      };
    }),

  values: protectedProcedure
    .input(
      z.object({
        property: z.string(),
        projectId: z.string(),
      }),
    )
    .query(async ({ input: { property, projectId } }) => {
      const isProperty = property.startsWith('properties.');
      // A column name is an identifier; only real profile columns are
      // accepted (GHSA-4j6c-j6vc-xq96).
      if (!(isProperty || isProfileColumn(property))) {
        throw new TRPCBadRequestError(`Unknown profile property: ${property}`);
      }
      // A property reads every flattened key matching the pattern
      // (mapExtractKeyLike), trimmed.
      const query = isProperty
        ? sql`
            SELECT DISTINCT btrim(kv.value) AS value
            FROM analytics.profiles AS p
            CROSS JOIN LATERAL jsonb_each_text(p.properties) AS kv(key, value)
            WHERE p.project_id = ${projectId}
              AND kv.key LIKE ${property.replace(/^properties\./, '').replace('.*.', '.%.')}::text
          `
        : sql`
            SELECT DISTINCT ${ident(property.replace(/^profile\./, ''))} AS value
            FROM analytics.profiles
            WHERE project_id = ${projectId}
          `;
      const rows = await anQuery<{ value: string }>(query);

      const values = pipe(
        (data: typeof rows) => data.map((row) => row.value),
        uniq,
        sort((a, b) => a.length - b.length),
      )(rows);

      return {
        values,
      };
    }),
});
