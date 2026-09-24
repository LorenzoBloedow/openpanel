import { TRPCError, initTRPC } from '@trpc/server';
import { has } from 'ramda';
import superjson from 'superjson';
import { ZodError, z } from 'zod';

import type { SessionValidationResult } from '@openpanel/auth';
import { runWithAlsSession } from '@openpanel/db';
import type { ILogger } from '@openpanel/logger';
import type { ISetCookie } from '@openpanel/validation';
import { type RateLimitOptions, enforceRateLimit } from './rate-limit';
import { getOrganizationAccess, requireProjectAccess } from './access';
import { TRPCForbiddenError } from './errors';

/** What procedures may know about the HTTP request (framework-free). */
export interface TrpcRequestInfo {
  /** Request headers, lowercased names. */
  headers: Record<string, string | undefined>;
  /** The client address as the edge saw it (cf-connecting-ip). */
  ip: string;
  log: ILogger;
}

export interface CreateContextOptions {
  req: TrpcRequestInfo;
  /** Parsed request cookies (signed ones already verified and unwrapped). */
  cookies: Record<string, string | undefined>;
  /** Appends a Set-Cookie header to the response (COOKIE_OPTIONS applied). */
  setCookie: ISetCookie;
  session: SessionValidationResult;
}

/**
 * The tRPC context. The HTTP layer (apps/api, Hono + the fetch adapter)
 * parses cookies, validates the session and supplies `setCookie`.
 */
export function createContext(options: CreateContextOptions) {
  return {
    req: options.req,
    session: options.session,
    setCookie: options.setCookie,
    cookies: options.cookies,
  };
}
export type Context = Awaited<ReturnType<typeof createContext>>;

/**
 * Per-procedure metadata consulted by `enforceAccess`.
 *
 * A tRPC mutation is not always a mutation of project *state* - the AI helpers
 * are one-shot compute that happen to be modelled as mutations. Those may run
 * at read level. The default is write, so forgetting to set this fails closed.
 */
export interface Meta {
  /** This mutation does not change project state; read access is enough. */
  readOnlyMutation?: boolean;
}

const t = initTRPC.context<Context>().meta<Meta>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? z.flattenError(error.cause) : null,
      },
    };
  },
});

const enforceUserIsAuthed = t.middleware(async ({ ctx, next }) => {
  if (!ctx.session?.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }

  try {
    return next({
      ctx: {
        session: { ...ctx.session },
      },
    });
  } catch (error) {
    console.error('Failes to get user', error);
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Failed to get user',
    });
  }
});

// Only used on protected routes
const enforceAccess = t.middleware(async ({ ctx, next, type, meta, getRawInput }) => {
  const sessionId = ctx.session?.session?.id ?? null;
  return runWithAlsSession(sessionId, async () => {
    const rawInput = await getRawInput();
    if (type === 'mutation' && process.env.DEMO_USER_ID) {
      throw new TRPCForbiddenError('You are not allowed to do this in demo mode');
    }

    if (has('projectId', rawInput)) {
      // Fails closed: any procedure that takes a top-level projectId requires
      // write access to mutate, including ones added later. Procedures that
      // resolve the project from a reportId/dashboardId/etc. are invisible to
      // this check and call requireProjectAccess in the handler instead.
      const needsWrite = type === 'mutation' && !meta?.readOnlyMutation;

      await requireProjectAccess({
        userId: ctx.session.userId!,
        projectId: rawInput.projectId as string,
        level: needsWrite ? 'write' : 'read',
      });
    }

    if (has('organizationId', rawInput)) {
      const access = await getOrganizationAccess({
        userId: ctx.session.userId!,
        organizationId: rawInput.organizationId as string,
      });

      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this organization');
      }
    }

    return next();
  });
});

export const createTRPCRouter = t.router;

/**
 * Throttle a procedure by client IP, with an exponentially growing lockout for
 * repeat offenders. See `./rate-limit` for the escalation rules and for the log
 * line (`rate limit blocked`) that carries the offending IP.
 */
export const rateLimitMiddleware = (options: RateLimitOptions) =>
  t.middleware(async ({ ctx, next, path }) => {
    await enforceRateLimit({ req: ctx.req, path, ...options });
    return next();
  });

const loggerMiddleware = t.middleware(
  async ({ ctx, next, getRawInput, path, input, type }) => {
    const rawInput = await getRawInput();
    // Only log mutations
    if (type === 'mutation') {
      ctx.req.log.info(
        {
          path,
          rawInput,
          input,
          userId: ctx.session?.userId,
          organizationId: has('organizationId', rawInput)
            ? rawInput.organizationId
            : undefined,
          projectId: has('projectId', rawInput)
            ? rawInput.projectId
            : undefined,
        },
        'TRPC mutation',
      );
    }
    return next();
  },
);

const sessionScopeMiddleware = t.middleware(async ({ ctx, next }) => {
  const sessionId = ctx.session?.session?.id ?? null;
  return runWithAlsSession(sessionId, async () => {
    return next();
  });
});

export const publicProcedure = t.procedure
  .use(loggerMiddleware)
  .use(sessionScopeMiddleware);
export const protectedProcedure = t.procedure
  .use(enforceUserIsAuthed)
  .use(enforceAccess)
  .use(loggerMiddleware)
  .use(sessionScopeMiddleware);
// Authenticated but WITHOUT the org/project membership check. Use for endpoints
// that must answer for any logged-in user (e.g. checking your own access to an
// org you may not belong to) and return null instead of throwing.
export const protectedProcedureWithoutAccess = t.procedure
  .use(enforceUserIsAuthed)
  .use(loggerMiddleware)
  .use(sessionScopeMiddleware);

/**
 * Response caching for queries. The Redis-backed cache is gone (no shared
 * cache on Cloudflare), so this passes through; call sites keep their TTLs
 * for when a cache comes back.
 */
export const cacheMiddleware = (
  _cbOrTtl: number | ((input: any, opts: { path: string }) => number),
) => t.middleware(({ next }) => next());
