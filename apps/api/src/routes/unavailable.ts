import {
  FeatureUnavailableError,
  type PlatformFeature,
} from '@openpanel/runtime';
import { Hono } from 'hono';

import type { AppEnv } from '@/env';

/**
 * Routes of features that are compiled out on Cloudflare (MCP, the AI chat,
 * the Slack / Polar webhooks, /tools): 501 Not Implemented.
 */
export function unavailableRoutes(feature: PlatformFeature) {
  const routes = new Hono<AppEnv>();
  routes.all('*', () => {
    throw new FeatureUnavailableError(feature);
  });
  return routes;
}
