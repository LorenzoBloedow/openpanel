import { Hono } from 'hono';

import { mountFastifyPlugin } from '@/compat/fastify';
import type { AppEnv } from '@/env';
import { corsPolicy } from '@/middleware/cors';
import { onError } from '@/middleware/errors';
import { requestContext } from '@/middleware/request';
import { docsRoutes } from '@/routes/docs';
import exportRouter from '@/routes/export.router';
import { healthRoutes } from '@/routes/health';
import { importRoutes } from '@/routes/import';
import insightsRouter from '@/routes/insights.router';
import { eventRoutes, profileRoutes } from '@/routes/legacy';
import { liveRoutes } from '@/routes/live';
import manageRouter from '@/routes/manage.router';
import miscRouter from '@/routes/misc.router';
import { gscCallbackRoutes, oauthRoutes } from '@/routes/oauth';
import { trackRoutes } from '@/routes/track';
import { trpcRoutes } from '@/routes/trpc';
import { unavailableRoutes } from '@/routes/unavailable';

/**
 * The OpenPanel API on Hono. Every request runs inside a runtime scope
 * (see index.ts) whose default database route is Hyperdrive; call sites
 * that write in bulk switch to the direct route through db-routing.
 */
export async function createApp() {
  const app = new Hono<AppEnv>();

  app.use(requestContext);
  app.use(corsPolicy);
  app.onError(onError);
  app.notFound((c) =>
    c.json(
      {
        message: `Route ${c.req.method}:${c.req.path} not found`,
        error: 'Not Found',
        statusCode: 404,
      },
      404,
    ),
  );

  // Dashboard API (session cookie)
  app.route('/trpc', trpcRoutes);
  app.route('/live', liveRoutes);
  app.route('/oauth', oauthRoutes);
  app.route('/gsc', gscCallbackRoutes);
  await mountFastifyPlugin(app, '/misc', miscRouter);

  // Public API
  app.route('/track', trackRoutes);
  app.route('/event', eventRoutes);
  app.route('/profile', profileRoutes);
  app.route('/import', importRoutes);
  await mountFastifyPlugin(app, '/export', exportRouter);
  await mountFastifyPlugin(app, '/insights', insightsRouter);
  await mountFastifyPlugin(app, '/manage', manageRouter);
  app.route('/documentation', docsRoutes);
  app.route('/', healthRoutes);

  // Not available on Cloudflare yet.
  app.route('/ai', unavailableRoutes('ai'));
  app.route('/mcp', unavailableRoutes('mcp'));
  app.route('/tools', unavailableRoutes('tools'));
  app.route('/webhook', unavailableRoutes('integrations'));

  return app;
}

export type App = Awaited<ReturnType<typeof createApp>>;
