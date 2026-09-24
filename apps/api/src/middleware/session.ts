import {
  EMPTY_SESSION,
  type SessionValidationResult,
  decodeSessionToken,
  validateSessionToken,
} from '@openpanel/auth';
import { runWithAlsSession } from '@openpanel/db';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';

import type { AppEnv } from '@/env';

/**
 * The dashboard session from the `session` cookie (the Fastify onRequest
 * hook of the dashboard scope). A failed lookup is an anonymous request,
 * never an error. With DEMO_USER_ID set every request is the demo user.
 */
export const dashboardSession = createMiddleware<AppEnv>(async (c, next) => {
  const cookies = getCookie(c);
  c.set('cookies', cookies);

  let session: SessionValidationResult = EMPTY_SESSION;
  const token = cookies.session;
  try {
    if (token) {
      const sessionId = decodeSessionToken(token);
      session = await runWithAlsSession(sessionId, () =>
        validateSessionToken(token),
      );
    } else if (c.env.DEMO_USER_ID) {
      session = await runWithAlsSession('1', () => validateSessionToken(null));
    }
  } catch (error) {
    c.get('logger').warn({ err: error }, 'Session validation failed');
    session = EMPTY_SESSION;
  }
  c.set('session', session);
  await next();
});
