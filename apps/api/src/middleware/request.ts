import { generateId } from '@openpanel/common';
import { getClientIpFromHeaders } from '@openpanel/common/server/get-client-ip';
import { createMiddleware } from 'hono/factory';

import type { AppEnv } from '@/env';
import { logger } from '@/utils/logger';
import { sanitizeUrl } from '@/utils/sanitize-url';

const IGNORE_LOG = ['/healthcheck', '/healthz', '/metrics', '/misc'];
const LOGGED_HEADERS = [
  'openpanel-client-id',
  'openpanel-sdk-name',
  'openpanel-sdk-version',
];

function bodyForLog(body: unknown) {
  // Replay chunks are up to 2 MB of recording data.
  if (body && typeof body === 'object' && 'type' in body && body.type === 'replay') {
    return { type: 'replay' };
  }
  return body;
}

/**
 * Request id, receive timestamp, client IP and a request-scoped logger (the
 * Fastify onRequest hooks), and one log line per response (the onResponse
 * hook): the same fields as before, IPs only for clients listed in
 * ENABLE_VERBOSE_LOGGING.
 */
export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = c.req.header('request-id') ?? generateId();
  c.set('requestId', requestId);
  c.set('timestamp', Date.now());

  const { ip, header } = getClientIpFromHeaders(c.req.raw.headers);
  c.set('clientIp', ip ?? '');
  c.set('clientIpHeader', header ?? '');

  const requestLogger = logger.child({ reqId: requestId });
  c.set('logger', requestLogger);

  const start = Date.now();
  await next();

  const path = c.req.path;
  if (c.req.method === 'OPTIONS' || IGNORE_LOG.some((prefix) => path.startsWith(prefix))) {
    return;
  }
  const url = sanitizeUrl(`${path}${new URL(c.req.url).search}`);
  const elapsed = Date.now() - start;

  if (path.startsWith('/trpc')) {
    requestLogger.info(
      { url: path, method: c.req.method, status: c.res.status, elapsed },
      'request done',
    );
    return;
  }

  const clientId = c.req.header('openpanel-client-id') ?? '';
  const verbose = c.env.ENABLE_VERBOSE_LOGGING?.split(',').includes(clientId);
  requestLogger.info(
    {
      url,
      method: c.req.method,
      status: c.res.status,
      elapsed,
      headers: Object.fromEntries(
        LOGGED_HEADERS.flatMap((name) => {
          const value = c.req.header(name);
          return value === undefined ? [] : [[name, value]];
        }),
      ),
      ...(path.startsWith('/track') ? { body: bodyForLog(c.get('body')) } : {}),
      clientIp: verbose ? ip : '',
      clientIpHeader: verbose ? header : '',
      userAgent: verbose ? (c.req.header('user-agent') ?? '') : '',
    },
    'request done',
  );
});
