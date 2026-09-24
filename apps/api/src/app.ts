import { Hono } from 'hono';

import type { AppEnv } from '@/env';
import { corsPolicy } from '@/middleware/cors';
import { onError } from '@/middleware/errors';
import { requestContext } from '@/middleware/request';
import { healthRoutes } from '@/routes/health';
import { importRoutes } from '@/routes/import';
import { eventRoutes, profileRoutes } from '@/routes/legacy';
import { trackRoutes } from '@/routes/track';

/**
 * The OpenPanel API on Hono. Every request runs inside a runtime scope
 * (see index.ts) whose default database route is Hyperdrive; call sites
 * that write in bulk switch to the direct route through db-routing.
 */
export function createApp() {
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

  // Public API
  app.route('/track', trackRoutes);
  app.route('/event', eventRoutes);
  app.route('/profile', profileRoutes);
  app.route('/import', importRoutes);
  app.route('/', healthRoutes);

  return app;
}

export const app = createApp();

export type App = typeof app;
