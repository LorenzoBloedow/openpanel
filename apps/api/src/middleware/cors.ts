import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';

import type { AppEnv } from '@/env';

/** Dashboard-only paths: credentials, and only the dashboard's origins. */
const PRIVATE_PATHS = ['/trpc', '/live', '/webhook', '/oauth', '/misc', '/ai'];

function dashboardOrigins(env: Env): string[] {
  return [env.DASHBOARD_URL, ...(env.API_CORS_ORIGINS?.split(',') ?? [])]
    .map((origin) => origin?.trim())
    .filter((origin): origin is string => Boolean(origin));
}

/**
 * The Fastify CORS policy: private paths echo an allow-listed origin with
 * credentials; the public API (SDKs, export, insights, manage) allows any
 * origin without credentials.
 */
export const corsPolicy = createMiddleware<AppEnv>(async (c, next) => {
  const isPrivate = PRIVATE_PATHS.some((prefix) => c.req.path.startsWith(prefix));
  const handler = isPrivate
    ? cors({
        origin: (origin) =>
          origin && dashboardOrigins(c.env).includes(origin) ? origin : null,
        credentials: true,
      })
    : cors({ origin: '*', maxAge: 86_400 * 7 });
  return handler(c, next);
});
