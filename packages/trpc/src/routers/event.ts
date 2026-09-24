import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  convertClickhouseDateToJs,
  db,
  eventService,
  getChartStartEndDate,
  getConversionEventNames,
  getEventList,
  getEventMetasCached,
  getSettingsForProject,
  hasAnonymousShareAccessToProject,
  pagesService,
  sessionService,
  type IServiceProfile,
  type IServiceSession,
} from '@openpanel/db';
import { anQuery } from '@openpanel/db/src/analytics/client';
import { sql } from '@openpanel/db/src/analytics/sql';
import {
  zChartEventFilter,
  zRange,
  zTimeInterval,
} from '@openpanel/validation';

import { clone } from 'ramda';
import { getProjectAccess } from '../access';
import { createdSince } from '../analytics-time';
import { TRPCForbiddenError } from '../errors';
import { createTRPCRouter, protectedProcedure, publicProcedure } from '../trpc';

const DAY_MS = 86_400_000;

/**
 * `toDate(created_at) > now() - INTERVAL 30 DAY` (UTC): events from the
 * first UTC midnight after that instant on.
 */
function originWindowStart(): Date {
  const since = new Date(Date.now() - 30 * DAY_MS);
  return new Date(
    Date.UTC(
      since.getUTCFullYear(),
      since.getUTCMonth(),
      since.getUTCDate() + 1,
    ),
  );
}

export const eventRouter = createTRPCRouter({
  updateEventMeta: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string(),
        icon: z.string().optional(),
        color: z.string().optional(),
        conversion: z.boolean().optional(),
      }),
    )
    .mutation(
      async ({ input: { projectId, name, icon, color, conversion } }) => {
        await getEventMetasCached.clear(projectId);
        return db.eventMeta.upsert({
          where: {
            name_projectId: {
              name,
              projectId,
            },
          },
          create: { projectId, name, icon, color, conversion },
          update: { icon, color, conversion },
        });
      },
    ),

  byId: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        projectId: z.string(),
        createdAt: z.date().optional(),
      }),
    )
    .query(async ({ input: { id, projectId, createdAt } }) => {
      const res = await eventService.getById({
        projectId,
        id,
        createdAt,
      });

      if (!res) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Event not found',
        });
      }

      return res;
    }),

  details: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        projectId: z.string(),
        createdAt: z.date().optional(),
      }),
    )
    .query(async ({ input: { id, projectId, createdAt } }) => {
      const res = await eventService.getById({
        projectId,
        id,
        createdAt,
      });

      if (!res) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Event not found',
        });
      }

      let session: IServiceSession | undefined;
      if (res?.sessionId) {
        session = await sessionService
          .byId(res?.sessionId, projectId)
          .catch(() => undefined);
      }

      return {
        event: res,
        session,
      };
    }),

  events: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        profileId: z.string().nullish(),
        sessionId: z.string().nullish(),
        groupId: z.string().nullish(),
        cohortId: z.string().nullish(),
        cursor: z.string().nullish(),
        filters: z.array(zChartEventFilter).default([]),
        startDate: z.date().nullish(),
        endDate: z.date().nullish(),
        events: z.array(z.string()).nullish(),
        columnVisibility: z.record(z.string(), z.boolean()).nullish(),
      }),
    )
    .query(async ({ input: { columnVisibility, ...input } }) => {
      const items = await getEventList({
        projectId: input.projectId,
        filters: input.filters,
        profileId: input.profileId ?? undefined,
        sessionId: input.sessionId ?? undefined,
        groupId: input.groupId ?? undefined,
        cohortId: input.cohortId ?? undefined,
        startDate: input.startDate ?? undefined,
        endDate: input.endDate ?? undefined,
        events: input.events ?? undefined,
        take: 50,
        cursor: input.cursor ? new Date(input.cursor) : undefined,
        select: {
          ...columnVisibility,
          city: columnVisibility?.country ?? true,
          path: columnVisibility?.name ?? true,
          duration: columnVisibility?.name ?? true,
          projectId: false,
          revenue: true,
        },
      });

      // Hacky join to get profile for entire session
      // TODO: Replace this with a join on the session table
      const map = new Map<string, IServiceProfile>(); // sessionId -> profileId
      for (const item of items) {
        if (item.sessionId && item.profile?.isExternal === true) {
          map.set(item.sessionId, item.profile);
        }
      }

      for (const item of items) {
        const profile = map.get(item.sessionId);
        if (profile && (item.profile?.isExternal === false || !item.profile)) {
          item.profile = clone(profile);
          if (item?.profile?.firstName) {
            item.profile.firstName = `* ${item.profile.firstName}`;
          }
        }
      }

      const lastItem = items[items.length - 1];

      return {
        data: items,
        meta: {
          next:
            items.length > 0 && lastItem
              ? lastItem.createdAt.toISOString()
              : null,
        },
      };
    }),
  conversionNames: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input: { projectId } }) => {
      return getConversionEventNames(projectId);
    }),
  conversions: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        cursor: z.string().nullish(),
        startDate: z.date().nullish(),
        endDate: z.date().nullish(),
        events: z.array(z.string()).nullish(),
        columnVisibility: z.record(z.string(), z.boolean()).nullish(),
      }),
    )
    .query(async ({ input: { columnVisibility, ...input } }) => {
      const conversions = await getConversionEventNames(input.projectId);
      const filteredConversions = conversions.filter((event) => {
        if (input.events && input.events.length > 0) {
          return input.events.includes(event.name);
        }
        return true;
      });

      if (filteredConversions.length === 0) {
        return {
          data: [],
          meta: {
            next: null,
          },
        };
      }

      const items = await getEventList({
        projectId: input.projectId,
        startDate: input.startDate ?? undefined,
        endDate: input.endDate ?? undefined,
        // The conversion events, already narrowed to input.events above.
        events: filteredConversions.map((event) => event.name),
        take: 50,
        cursor: input.cursor ? new Date(input.cursor) : undefined,
        select: {
          ...columnVisibility,
          city: columnVisibility?.country ?? true,
          path: columnVisibility?.name ?? true,
          duration: columnVisibility?.name ?? true,
          projectId: false,
          revenue: true,
        },
      });

      // Hacky join to get profile for entire session
      // TODO: Replace this with a join on the session table
      const map = new Map<string, IServiceProfile>(); // sessionId -> profileId
      for (const item of items) {
        if (item.sessionId && item.profile?.isExternal === true) {
          map.set(item.sessionId, item.profile);
        }
      }

      for (const item of items) {
        const profile = map.get(item.sessionId);
        if (profile && (item.profile?.isExternal === false || !item.profile)) {
          item.profile = clone(profile);
          if (item?.profile?.firstName) {
            item.profile.firstName = `* ${item.profile.firstName}`;
          }
        }
      }

      const lastItem = items[items.length - 1];

      return {
        data: items,
        meta: {
          next:
            items.length > 0 && lastItem
              ? lastItem.createdAt.toISOString()
              : null,
        },
      };
    }),

  bots: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        cursor: z.number().optional(),
        limit: z.number().default(8),
      }),
    )
    .query(async ({ input: { projectId, cursor, limit }, ctx }) => {
      if (ctx.session.userId) {
        const access = await getProjectAccess({
          projectId,
          userId: ctx.session.userId,
        });
        if (!access) {
          throw new TRPCForbiddenError('You do not have access to this project');
        }
      } else {
        // Anonymous callers only see bot events through an unlocked public
        // overview share; the row existing is not enough (GHSA-r4g5-vgpj-923m).
        const allowed = await hasAnonymousShareAccessToProject(
          projectId,
          ctx.cookies,
          ['overview'],
        );
        if (!allowed) {
          throw new TRPCForbiddenError('You do not have access to this project');
        }
      }

      const [events, counts] = await Promise.all([
        anQuery<{
          id: string;
          project_id: string;
          name: string;
          type: string;
          path: string;
          created_at: string;
        }>(sql`
          SELECT id, project_id, name, type, path, created_at
          FROM analytics.events_bots
          WHERE project_id = ${projectId}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${(cursor ?? 0) * limit}
        `),
        anQuery<{ count: number }>(sql`
          SELECT count(*) AS count
          FROM analytics.events_bots
          WHERE project_id = ${projectId}
        `),
      ]);

      return {
        data: events.map((item) => ({
          ...item,
          createdAt: convertClickhouseDateToJs(item.created_at),
        })),
        count: counts[0]?.count ?? 0,
      };
    }),

  pages: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        cursor: z.number().optional(),
        take: z.number().min(1).optional(),
        search: z.string().optional(),
        range: zRange,
        interval: zTimeInterval,
      }),
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const { startDate, endDate } = getChartStartEndDate(input, timezone);
      return pagesService.getTopPages({
        projectId: input.projectId,
        startDate,
        endDate,
        timezone,
        search: input.search,
        limit: input.take,
      });
    }),

  pagesTimeseries: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        range: zRange,
        interval: zTimeInterval,
      }),
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const { startDate, endDate } = getChartStartEndDate(input, timezone);
      return pagesService.getPageTimeseries({
        projectId: input.projectId,
        startDate,
        endDate,
        timezone,
        interval: input.interval,
      });
    }),

  previousPages: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        range: zRange,
        interval: zTimeInterval,
      }),
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const { startDate, endDate } = getChartStartEndDate(input, timezone);

      const startMs = new Date(startDate).getTime();
      const endMs = new Date(endDate).getTime();
      const duration = endMs - startMs;

      const prevEnd = new Date(startMs - 1);
      const prevStart = new Date(prevEnd.getTime() - duration);
      const fmt = (d: Date) =>
        d.toISOString().slice(0, 19).replace('T', ' ');

      return pagesService.getTopPages({
        projectId: input.projectId,
        startDate: fmt(prevStart),
        endDate: fmt(prevEnd),
        timezone,
      });
    }),

  pageTimeseries: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        range: zRange,
        interval: zTimeInterval,
        origin: z.string(),
        path: z.string(),
      }),
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const { startDate, endDate } = getChartStartEndDate(input, timezone);
      return pagesService.getPageTimeseries({
        projectId: input.projectId,
        startDate,
        endDate,
        timezone,
        interval: input.interval,
        filterOrigin: input.origin,
        filterPath: input.path,
      });
    }),

  origin: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .query(async ({ input }) => {
      const res = await anQuery<{ origin: string }>(sql`
        SELECT origin, count(*) AS count
        FROM analytics.events
        WHERE project_id = ${input.projectId}
          AND origin <> ''
          AND ${createdSince(originWindowStart())}
        GROUP BY origin
        ORDER BY count DESC
        LIMIT 3
      `);

      return res.filter((item) => item.origin && !item.origin.includes('localhost:'));
    }),
});
