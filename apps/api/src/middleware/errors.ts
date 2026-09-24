import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { AppEnv } from '@/env';
import { isFeatureUnavailableError } from '@openpanel/runtime';
import { HttpError, buildErrorRequestContext, normalizeError } from '@/utils/errors';
import { logger } from '@/utils/logger';

const SKIP_LOG_ERRORS = ['UNAUTHORIZED', 'FORBIDDEN'];

/** The Fastify error handler: same status mapping and response shapes. */
export const onError: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  if (isFeatureUnavailableError(error)) {
    return c.json(
      { status: 501, error: 'Not Implemented', message: error.message },
      501,
    );
  }

  const { status, code, message, errorName } = normalizeError(error);

  if (status === 429) {
    return c.json(
      {
        status: 429,
        error: 'Too Many Requests',
        message: 'You have exceeded the rate limit for this endpoint.',
      },
      429,
    );
  }

  const requestLogger = c.get('logger') ?? logger;
  const skipLog = status < 500 && code !== undefined && SKIP_LOG_ERRORS.includes(code);
  if (!skipLog) {
    const context = buildErrorRequestContext({
      id: c.get('requestId') ?? '',
      url: c.req.url,
      method: c.req.method,
      query: c.req.queries(),
      headers: Object.fromEntries(c.req.raw.headers),
      body: c.get('body'),
    });
    const label = error instanceof HttpError ? 'internal server error' : 'request error';
    if (status >= 500) {
      requestLogger.error({ err: error, req: context }, label);
    } else {
      requestLogger.warn({ err: error, req: context }, label);
    }
  }

  if (status === 500 && c.env.NODE_ENV === 'production') {
    return c.text('Internal server error', 500);
  }

  return c.json(
    {
      status,
      error: error instanceof HttpError ? error.error : errorName,
      message,
    },
    status as 500,
  );
};
