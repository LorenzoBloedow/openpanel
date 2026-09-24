import { getTrustedIpFromHeaders } from '@openpanel/common/server/get-client-ip';
import { appRouter, createContext } from '@openpanel/trpc';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { Hono } from 'hono';

import type { AppEnv } from '@/env';
import { dashboardSession } from '@/middleware/session';
import { createSetCookie } from '@/utils/cookies';

export const trpcRoutes = new Hono<AppEnv>();

trpcRoutes.use(dashboardSession);

/**
 * The dashboard API: tRPC over the fetch adapter. Queries may be sent as
 * POST (method override): inputs routinely exceed Cloudflare's URL limit.
 * Responses are not streamed, so the request's runtime scope (and its
 * database pools) can close as soon as the handler returns.
 */
trpcRoutes.all('/*', (c) => {
  const headers = c.req.raw.headers;
  const { ip, header: ipHeader } = getTrustedIpFromHeaders(headers);
  const requestInfo = {
    headers: Object.fromEntries(headers),
    ip,
    log: c.get('logger'),
  };

  return fetchRequestHandler({
    endpoint: '/trpc',
    req: c.req.raw,
    router: appRouter,
    allowMethodOverride: true,
    createContext: ({ resHeaders }) =>
      createContext({
        req: requestInfo,
        cookies: c.get('cookies'),
        setCookie: createSetCookie(resHeaders, c.env.COOKIE_SECRET),
        session: c.get('session'),
      }),
    onError({ error, path, input, type, ctx }) {
      if (error.code === 'UNAUTHORIZED' && path === 'organization.list') {
        return;
      }
      // The IP comes from trusted headers only, so it is the address to
      // block at the edge when an abuser needs stopping.
      const payload = {
        err: error,
        path,
        input,
        type,
        session: ctx?.session,
        ip,
        ipHeader,
        userAgent: headers.get('user-agent') ?? undefined,
      };
      // Being rate limited is the system working, not an error.
      if (error.code === 'TOO_MANY_REQUESTS') {
        requestInfo.log.warn(payload, 'trpc rate limited');
        return;
      }
      // A feature compiled out on Cloudflare: expected, not a failure.
      if (error.code === 'NOT_IMPLEMENTED') {
        requestInfo.log.warn({ path, message: error.message }, 'trpc feature unavailable');
        return;
      }
      requestInfo.log.error(payload, 'trpc error');
    },
  });
});
