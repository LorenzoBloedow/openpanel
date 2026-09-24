import {
  db,
  getActiveVisitorCount,
  getSettingsForProject,
} from '@openpanel/db';
import { anQuery } from '@openpanel/db/src/analytics/client';
import { sql } from '@openpanel/db/src/analytics/sql';
import { getCache } from '@openpanel/redis';
import { zWidgetOptions, zWidgetType } from '@openpanel/validation';
import ShortUniqueId from 'short-unique-id';
import { z } from 'zod';
import {
  createdSince,
  getLiveMinuteCounts,
  liveEvents,
  liveWindow,
  secondsNow,
  zonedMinus,
} from '../analytics-time';
import { TRPCNotFoundError } from '../errors';
import { createTRPCRouter, protectedProcedure, publicProcedure } from '../trpc';

const uid = new ShortUniqueId({ length: 6 });

// Helper to find widget by projectId and type
async function findWidgetByType(projectId: string, type: string) {
  const widgets = await db.shareWidget.findMany({
    where: { projectId },
  });
  return widgets.find(
    (w) => (w.options as z.infer<typeof zWidgetOptions>)?.type === type
  );
}

export const widgetRouter = createTRPCRouter({
  // Get widget by projectId and type (returns null if not found or not public)
  get: protectedProcedure
    .input(z.object({ projectId: z.string(), type: zWidgetType }))
    .query(async ({ input }) => {
      const widget = await findWidgetByType(input.projectId, input.type);

      if (!widget) {
        return null;
      }

      return widget;
    }),

  // Toggle widget public status (creates if doesn't exist)
  toggle: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        organizationId: z.string(),
        type: zWidgetType,
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const existing = await findWidgetByType(input.projectId, input.type);

      if (existing) {
        return db.shareWidget.update({
          where: { id: existing.id },
          data: { public: input.enabled },
        });
      }

      // Create new widget with default options
      const defaultOptions =
        input.type === 'realtime'
          ? {
              type: 'realtime' as const,
              referrers: true,
              countries: true,
              paths: false,
            }
          : { type: 'counter' as const };

      return db.shareWidget.create({
        data: {
          id: uid.rnd(),
          projectId: input.projectId,
          organizationId: input.organizationId,
          public: input.enabled,
          options: defaultOptions,
        },
      });
    }),

  // Update widget options (for realtime widget)
  updateOptions: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        organizationId: z.string(),
        options: zWidgetOptions,
      })
    )
    .mutation(async ({ input }) => {
      const existing = await findWidgetByType(
        input.projectId,
        input.options.type
      );

      if (existing) {
        return db.shareWidget.update({
          where: { id: existing.id },
          data: { options: input.options },
        });
      }

      // Create new widget if it doesn't exist
      return db.shareWidget.create({
        data: {
          id: uid.rnd(),
          projectId: input.projectId,
          organizationId: input.organizationId,
          public: false,
          options: input.options,
        },
      });
    }),

  counter: publicProcedure
    .input(z.object({ shareId: z.string() }))
    .query(async ({ input }) => {
      const widget = await db.shareWidget.findUnique({
        where: {
          id: input.shareId,
        },
      });

      if (!(widget && widget.public)) {
        throw new TRPCNotFoundError('Widget not found');
      }

      if (widget.options.type !== 'counter') {
        throw new TRPCNotFoundError('Invalid widget type');
      }

      return {
        projectId: widget.projectId,
        counter: await getActiveVisitorCount(widget.projectId),
      };
    }),

  badge: publicProcedure
    .input(z.object({ shareId: z.string() }))
    .query(async ({ input }) => {
      const widget = await db.shareWidget.findUnique({
        where: {
          id: input.shareId,
        },
      });

      if (!(widget && widget.public)) {
        throw new TRPCNotFoundError('Widget not found');
      }

      if (widget.options.type !== 'counter') {
        throw new TRPCNotFoundError('Invalid widget type');
      }

      const { projectId } = widget;
      const { timezone } = await getSettingsForProject(projectId);

      // Cache for 5 minutes since this queries 30 days of data
      const cacheKey = `widget:badge:${projectId}`;
      const visitors = await getCache(
        cacheKey,
        5 * 60, // 5 minutes
        async () => {
          const result = await anQuery<{ count: number }>(sql`
            SELECT COUNT(DISTINCT profile_id) AS count
            FROM analytics.events
            WHERE project_id = ${projectId}
              AND ${createdSince(zonedMinus(secondsNow(), timezone, { days: 30 }))}
          `);
          return result[0]?.count || 0;
        }
      );

      return {
        projectId,
        visitors,
      };
    }),

  realtimeData: publicProcedure
    .input(z.object({ shareId: z.string() }))
    .query(async ({ input }) => {
      // Validate ShareWidget exists and is public
      const widget = await db.shareWidget.findUnique({
        where: {
          id: input.shareId,
        },
        include: {
          project: {
            select: {
              domain: true,
              name: true,
            },
          },
        },
      });

      if (!(widget && widget.public)) {
        throw new TRPCNotFoundError('Widget not found');
      }

      const { projectId, options } = widget;

      if (options.type !== 'realtime') {
        throw new TRPCNotFoundError('Invalid widget type');
      }

      const { timezone } = await getSettingsForProject(projectId);

      const window = liveWindow(projectId, timezone);

      // Always fetch live count and histogram
      const totalSessionsPromise = anQuery<{ total_sessions: number }>(sql`
        SELECT COUNT(DISTINCT session_id) AS total_sessions
        FROM analytics.events
        WHERE ${liveEvents(window)}
      `);

      // Conditionally fetch countries
      const countriesQueryPromise = options.countries
        ? anQuery<{ country: string; count: number }>(sql`
            SELECT country, COUNT(DISTINCT session_id) AS count
            FROM analytics.events
            WHERE ${liveEvents(window)}
              AND country <> ''
            GROUP BY country
            ORDER BY count DESC
            LIMIT 10
          `)
        : Promise.resolve<Array<{ country: string; count: number }>>([]);

      // Conditionally fetch referrers
      const referrersQueryPromise = options.referrers
        ? anQuery<{ referrer: string; count: number }>(sql`
            SELECT referrer_name AS referrer, COUNT(DISTINCT session_id) AS count
            FROM analytics.events
            WHERE ${liveEvents(window)}
              AND referrer_name <> ''
            GROUP BY referrer_name
            ORDER BY count DESC
            LIMIT 10
          `)
        : Promise.resolve<Array<{ referrer: string; count: number }>>([]);

      // Conditionally fetch paths
      const pathsQueryPromise = options.paths
        ? anQuery<{ path: string; count: number }>(sql`
            SELECT path, COUNT(DISTINCT session_id) AS count
            FROM analytics.events
            WHERE ${liveEvents(window)}
              AND path <> ''
            GROUP BY path
            ORDER BY count DESC
            LIMIT 10
          `)
        : Promise.resolve<Array<{ path: string; count: number }>>([]);

      const [totalSessions, minuteCounts, countries, referrers, paths] =
        await Promise.all([
          totalSessionsPromise,
          getLiveMinuteCounts(window),
          countriesQueryPromise,
          referrersQueryPromise,
          pathsQueryPromise,
        ]);

      return {
        projectId,
        liveCount: totalSessions[0]?.total_sessions || 0,
        project: widget.project,
        histogram: minuteCounts.map((item) => ({
          minute: item.minute,
          sessionCount: item.session_count,
          visitorCount: item.visitor_count,
          timestamp: new Date(item.minute).getTime(),
          time: new Date(item.minute).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
        })),
        countries: countries.map((item) => ({
          country: item.country,
          count: item.count,
        })),
        referrers: referrers.map((item) => ({
          referrer: item.referrer,
          count: item.count,
        })),
        paths: paths.map((item) => ({
          path: item.path,
          count: item.count,
        })),
      };
    }),
});
