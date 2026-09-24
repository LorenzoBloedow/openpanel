import { liveHubName } from '@openpanel/queue/src/live';
import { getProjectAccess } from '@openpanel/trpc';
import { getOrganizationAccess } from '@openpanel/trpc/src/access';
import { type Context, Hono } from 'hono';

import type { LiveChannel } from '@/durable/live-hub';
import type { AppEnv } from '@/env';
import { dashboardSession } from '@/middleware/session';

/**
 * Dashboard WebSockets. The upgrade is authenticated here and handed to the
 * project's (or organization's) LiveHub, which holds the connection.
 */
export const liveRoutes = new Hono<AppEnv>();

liveRoutes.use(dashboardSession);

function isUpgrade(c: Context<AppEnv>) {
  return c.req.header('upgrade')?.toLowerCase() === 'websocket';
}

/** Accept, explain and close — what the old handlers did on a denied socket. */
function reject(message: string) {
  // biome-ignore lint/correctness/noUndeclaredVariables: a workerd global
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();
  server.send(message);
  server.close(1008, message);
  return new Response(null, { status: 101, webSocket: client });
}

function forward(
  c: Context<AppEnv>,
  scope: 'project' | 'org',
  id: string,
  channel: LiveChannel,
) {
  const hub = c.env.LIVE_HUB.get(
    c.env.LIVE_HUB.idFromName(liveHubName(scope, id)),
  );
  const url = new URL(c.req.url);
  url.searchParams.set('channel', channel);
  return hub.fetch(new Request(url, c.req.raw));
}

liveRoutes.use('*', async (c, next) => {
  if (!isUpgrade(c)) {
    return c.text('Expected a WebSocket upgrade', 426);
  }
  await next();
});

// Public: the visitor counter of shared overviews and widgets.
liveRoutes.get('/visitors/:projectId', (c) =>
  forward(c, 'project', c.req.param('projectId'), 'visitors'),
);

async function projectChannel(c: Context<AppEnv>, channel: LiveChannel) {
  const projectId = c.req.param('projectId')!;
  const userId = c.get('session').userId;
  if (!userId) {
    return reject('No active session');
  }
  const access = await getProjectAccess({ userId, projectId });
  if (!access) {
    return reject('No access');
  }
  return forward(c, 'project', projectId, channel);
}

liveRoutes.get('/events/:projectId', (c) => projectChannel(c, 'events'));
liveRoutes.get('/notifications/:projectId', (c) =>
  projectChannel(c, 'notifications'),
);

liveRoutes.get('/organization/:organizationId', async (c) => {
  const organizationId = c.req.param('organizationId');
  const userId = c.get('session').userId;
  if (!userId) {
    return reject('No active session');
  }
  const access = await getOrganizationAccess({ userId, organizationId });
  if (!access) {
    return reject('No access');
  }
  return forward(c, 'org', organizationId, 'organization');
});
