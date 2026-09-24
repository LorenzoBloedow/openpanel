import { uuidv7 } from '@openpanel/common/server';
import { createMiddleware } from 'hono/factory';
import { path } from 'ramda';

import { isBot } from '@/bots';
import type { AppEnv } from '@/env';
import { readJsonBody } from '@/ingest/body';
import { enqueueRecords } from '@/ingest/queue';
import { SdkAuthError, validateSdkRequest } from '@/utils/auth';

/**
 * SDK authentication (the Fastify clientHook): client id plus origin (CORS
 * allow-list) or client secret, and the project's IP / profile-id blocks.
 */
export const sdkClient = createMiddleware<AppEnv>(async (c, next) => {
  const body = await readJsonBody(c);
  try {
    const { client, clientSecretAuth } = await validateSdkRequest({
      headers: c.req.raw.headers,
      clientIp: c.get('clientIp'),
      body,
    });
    c.set('client', client);
    c.set('clientSecretAuth', clientSecretAuth);
  } catch (error) {
    if (error instanceof SdkAuthError) {
      c.get('logger').warn({ err: error }, 'Invalid SDK request');
      return c.text(error.message, 401);
    }
    c.get('logger').error({ err: error }, 'Invalid SDK request');
    return c.text('Internal server error', 500);
  }
  await next();
});

/** The page path of a track payload or a legacy /event payload. */
function getBotPath(body: unknown): string | undefined {
  const properties =
    path<Record<string, unknown>>(['payload', 'properties'], body) ??
    path<Record<string, unknown>>(['properties'], body);
  const value = properties?.__path || properties?.path;
  return typeof value === 'string' && value ? value : undefined;
}

function isTrackOrLegacyEvent(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }
  if ('type' in body) {
    return body.type === 'track';
  }
  return 'name' in body && 'properties' in body;
}

/**
 * Known bots get a 202 and their page view goes to the bots table (the
 * Fastify isBotHook). Requests authenticated with a client secret come
 * from server-side SDKs and are never treated as bots.
 */
export const botFilter = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('clientSecretAuth')) {
    return next();
  }
  const ua = c.req.header('user-agent');
  const bot = ua ? await isBot(ua) : null;
  const projectId = c.get('client')?.projectId;
  if (!(bot && projectId)) {
    return next();
  }

  const body = c.get('body');
  const botPath = isTrackOrLegacyEvent(body) ? getBotPath(body) : undefined;
  if (botPath) {
    await enqueueRecords(c.env.EVENTS_QUEUE, projectId, [
      {
        type: 'bot',
        id: uuidv7(),
        bot: {
          projectId,
          name: bot.name,
          type: bot.type,
          path: botPath,
          createdAt: new Date().toISOString(),
        },
      },
    ]);
  }
  return c.json({ bot }, 202);
});
