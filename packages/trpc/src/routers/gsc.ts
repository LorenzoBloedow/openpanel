import { Arctic, googleGsc } from '@openpanel/auth';
import {
  db,
  getChartStartEndDate,
  getGscCannibalization,
  getGscOverview,
  getGscPageDetails,
  getGscPages,
  getGscQueries,
  getGscQueryDetails,
  getSettingsForProject,
  listGscSites,
} from '@openpanel/db';
import { anQuery } from '@openpanel/db/src/analytics/client';
import { type Sql, join, sql } from '@openpanel/db/src/analytics/sql';
import { gscQueue } from '@openpanel/queue';
import { zRange, zTimeInterval } from '@openpanel/validation';
import { z } from 'zod';
import { getProjectAccess, requireProjectAccess } from '../access';
import { instant } from '../analytics-time';
import { TRPCForbiddenError, TRPCNotFoundError } from '../errors';
import { createTRPCRouter, protectedProcedure } from '../trpc';

const zGscDateInput = z.object({
  projectId: z.string(),
  range: zRange,
  interval: zTimeInterval.optional().default('day'),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
});

async function resolveDates(
  projectId: string,
  input: { range: string; startDate?: string | null; endDate?: string | null }
) {
  const { timezone } = await getSettingsForProject(projectId);
  const { startDate, endDate } = getChartStartEndDate(
    {
      range: input.range as any,
      startDate: input.startDate,
      endDate: input.endDate,
    },
    timezone
  );
  return {
    startDate: startDate.slice(0, 10),
    endDate: endDate.slice(0, 10),
  };
}

/**
 * The same AI referrer is stored under several spellings: the parsed display
 * name ('ChatGPT', 'Google Gemini'), the bare host ('chatgpt.com') and the
 * full origin ('https://kagi.com'). Normalize before matching so every
 * spelling lands on the same engine.
 */
const NORMALIZED_REFERRER_NAME = sql`lower(regexp_replace(referrer_name, '^https?://(www[.])?', ''))`;

const AI_REFERRERS = [
  {
    canonical: 'chatgpt.com',
    aliases: ['chatgpt', 'chatgpt.com', 'chat.openai.com', 'openai', 'openai.com'],
  },
  {
    canonical: 'claude.ai',
    aliases: ['claude', 'claude.ai', 'anthropic', 'anthropic.com'],
  },
  {
    canonical: 'perplexity.ai',
    aliases: ['perplexity', 'perplexity.ai'],
  },
  {
    canonical: 'gemini.google.com',
    aliases: ['gemini', 'google gemini', 'gemini.google.com', 'bard.google.com'],
  },
  {
    canonical: 'copilot.com',
    aliases: ['copilot', 'copilot.com', 'copilot.microsoft.com', 'microsoft copilot'],
  },
  { canonical: 'grok.com', aliases: ['grok', 'grok.com'] },
  {
    canonical: 'mistral.ai',
    aliases: ['mistral', 'mistral.ai', 'chat.mistral.ai', 'le chat'],
  },
  { canonical: 'kagi.com', aliases: ['kagi', 'kagi.com', 'assistant.kagi.com'] },
] as const satisfies ReadonlyArray<{
  canonical: string;
  aliases: readonly string[];
}>;

const AI_REFERRER_ALIASES: string[] = AI_REFERRERS.flatMap((engine) => [
  ...engine.aliases,
]);

/**
 * Collapses every alias onto one row per engine. `norm` is the normalized
 * name selected by aiReferrerSessions below.
 */
const AI_REFERRER_CANONICAL_NAME = sql`CASE ${join(
  AI_REFERRERS.map(
    (engine) =>
      sql`WHEN norm = ANY(${[...engine.aliases]}::text[]) THEN ${engine.canonical}::text`,
  ),
  ' ',
)} ELSE norm END`;

/**
 * Half-open windows so the last day of the range is included and the previous
 * window ends exactly where the current one starts (no gap, no overlap).
 */
function getComparisonWindows(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const endExclusive = new Date(`${endDate}T00:00:00Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const previousStart = new Date(
    start.getTime() - (endExclusive.getTime() - start.getTime())
  );
  return {
    current: { start, end: endExclusive },
    previous: { start: previousStart, end: start },
  };
}

interface ComparisonWindow {
  start: Date;
  end: Date;
}

/** Sessions of the project that started inside the window. */
function sessionsIn(projectId: string, window: ComparisonWindow): Sql {
  return sql`project_id = ${projectId}
    AND created_at >= ${instant(window.start)}
    AND created_at < ${instant(window.end)}`;
}

/**
 * Sessions from an AI referrer in the window, as a subquery with the
 * referrer's normalized name as `norm`. Matched by name — will switch to
 * referrer_type = 'ai' once available.
 */
function aiReferrerSessions(projectId: string, window: ComparisonWindow): Sql {
  return sql`(
    SELECT ${NORMALIZED_REFERRER_NAME} AS norm
    FROM analytics.sessions
    WHERE ${sessionsIn(projectId, window)}
      AND ${NORMALIZED_REFERRER_NAME} = ANY(${AI_REFERRER_ALIASES}::text[])
  ) AS s`;
}

export const gscRouter = createTRPCRouter({
  getConnection: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      return db.gscConnection.findUnique({
        where: { projectId: input.projectId },
        select: {
          id: true,
          siteUrl: true,
          lastSyncedAt: true,
          lastSyncStatus: true,
          lastSyncError: true,
          backfillStatus: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    }),

  initiateOAuth: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'write',
      });

      const state = Arctic.generateState();
      const codeVerifier = Arctic.generateCodeVerifier();
      const url = googleGsc.createAuthorizationURL(state, codeVerifier, [
        'https://www.googleapis.com/auth/webmasters.readonly',
      ]);
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');

      const cookieOpts = { maxAge: 60 * 10, signed: true };
      ctx.setCookie('gsc_oauth_state', state, cookieOpts);
      ctx.setCookie('gsc_code_verifier', codeVerifier, cookieOpts);
      ctx.setCookie('gsc_project_id', input.projectId, cookieOpts);

      return { url: url.toString() };
    }),

  getSites: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      return listGscSites(input.projectId);
    }),

  selectSite: protectedProcedure
    .input(z.object({ projectId: z.string(), siteUrl: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'write',
      });

      const conn = await db.gscConnection.findUnique({
        where: { projectId: input.projectId },
      });
      if (!conn) {
        throw new TRPCNotFoundError('GSC connection not found');
      }

      await db.gscConnection.update({
        where: { projectId: input.projectId },
        data: {
          siteUrl: input.siteUrl,
          backfillStatus: 'pending',
        },
      });

      await gscQueue.add('gscProjectBackfill', {
        type: 'gscProjectBackfill',
        payload: { projectId: input.projectId },
      });

      return { ok: true };
    }),

  disconnect: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'write',
      });

      await db.gscConnection.deleteMany({
        where: { projectId: input.projectId },
      });

      return { ok: true };
    }),

  getOverview: protectedProcedure
    .input(zGscDateInput)
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      const { startDate, endDate } = await resolveDates(input.projectId, input);
      const interval = ['day', 'week', 'month'].includes(input.interval)
        ? (input.interval as 'day' | 'week' | 'month')
        : 'day';
      return getGscOverview(input.projectId, startDate, endDate, interval);
    }),

  getPages: protectedProcedure
    .input(
      zGscDateInput.extend({
        limit: z.number().min(1).max(10_000).optional().default(100),
      })
    )
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      const { startDate, endDate } = await resolveDates(input.projectId, input);
      return getGscPages(input.projectId, startDate, endDate, input.limit);
    }),

  getPageDetails: protectedProcedure
    .input(zGscDateInput.extend({ page: z.string() }))
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      const { startDate, endDate } = await resolveDates(input.projectId, input);
      return getGscPageDetails(input.projectId, input.page, startDate, endDate);
    }),

  getQueryDetails: protectedProcedure
    .input(zGscDateInput.extend({ query: z.string() }))
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      const { startDate, endDate } = await resolveDates(input.projectId, input);
      return getGscQueryDetails(
        input.projectId,
        input.query,
        startDate,
        endDate
      );
    }),

  getQueries: protectedProcedure
    .input(
      zGscDateInput.extend({
        limit: z.number().min(1).max(1000).optional().default(100),
      })
    )
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      const { startDate, endDate } = await resolveDates(input.projectId, input);
      return getGscQueries(input.projectId, startDate, endDate, input.limit);
    }),

  getSearchEngines: protectedProcedure
    .input(zGscDateInput)
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      const { startDate, endDate } = await resolveDates(input.projectId, input);
      const windows = getComparisonWindows(startDate, endDate);

      const where = (window: ComparisonWindow) =>
        sql`${sessionsIn(input.projectId, window)} AND referrer_type = 'search'`;

      const [engines, [currentResult], [prevResult]] = await Promise.all([
        anQuery<{ name: string; sessions: number }>(sql`
          SELECT referrer_name AS name, count(*) AS sessions
          FROM analytics.sessions
          WHERE ${where(windows.current)}
          GROUP BY referrer_name
          ORDER BY sessions DESC
          LIMIT 10
        `),
        anQuery<{ sessions: number }>(sql`
          SELECT count(*) AS sessions
          FROM analytics.sessions
          WHERE ${where(windows.current)}
        `),
        anQuery<{ sessions: number }>(sql`
          SELECT count(*) AS sessions
          FROM analytics.sessions
          WHERE ${where(windows.previous)}
        `),
      ]);

      return {
        engines,
        // Counted separately from `engines`, which is capped at the top 10, so
        // the total compares like-for-like with the previous period.
        total: currentResult?.sessions ?? 0,
        previousTotal: prevResult?.sessions ?? 0,
      };
    }),

  getAiEngines: protectedProcedure
    .input(zGscDateInput)
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      const { startDate, endDate } = await resolveDates(input.projectId, input);
      const windows = getComparisonWindows(startDate, endDate);

      const [engines, [prevResult]] = await Promise.all([
        anQuery<{ name: string; sessions: number }>(sql`
          SELECT ${AI_REFERRER_CANONICAL_NAME} AS name, count(*) AS sessions
          FROM ${aiReferrerSessions(input.projectId, windows.current)}
          GROUP BY 1
          ORDER BY sessions DESC
        `),
        anQuery<{ sessions: number }>(sql`
          SELECT count(*) AS sessions
          FROM ${aiReferrerSessions(input.projectId, windows.previous)}
        `),
      ]);

      return {
        engines,
        // The filter is a fixed alias set, so the grouped rows are the whole
        // population — no LIMIT, and the total matches the previous period.
        total: engines.reduce((sum, engine) => sum + engine.sessions, 0),
        previousTotal: prevResult?.sessions ?? 0,
      };
    }),

  getPreviousOverview: protectedProcedure
    .input(zGscDateInput)
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      const { startDate, endDate } = await resolveDates(input.projectId, input);

      const startMs = new Date(startDate).getTime();
      const duration = new Date(endDate).getTime() - startMs;
      const prevEnd = new Date(startMs - 1);
      const prevStart = new Date(prevEnd.getTime() - duration);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);

      const interval = (['day', 'week', 'month'] as const).includes(
        input.interval as 'day' | 'week' | 'month'
      )
        ? (input.interval as 'day' | 'week' | 'month')
        : 'day';

      return getGscOverview(
        input.projectId,
        fmt(prevStart),
        fmt(prevEnd),
        interval
      );
    }),

  getCannibalization: protectedProcedure
    .input(zGscDateInput)
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      const { startDate, endDate } = await resolveDates(input.projectId, input);
      return getGscCannibalization(input.projectId, startDate, endDate);
    }),
});
