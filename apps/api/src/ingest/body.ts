import type { Context } from 'hono';
import type { ZodType } from 'zod';

import type { AppEnv } from '@/env';
import { HttpError } from '@/utils/errors';

const FORBIDDEN_PROPERTY = 'Object contains forbidden prototype property';

function badRequest(message: string) {
  return new HttpError(message, { status: 400, error: 'Bad Request' });
}

/**
 * Fastify's JSON parser (secure-json-parse) rejected bodies that could
 * poison prototypes once merged into other objects (ramda's assocPath and
 * mergeDeepRight run on SDK payloads); keep rejecting them.
 */
function rejectPrototypeKeys(key: string, value: unknown) {
  if (key === '__proto__') {
    throw badRequest(FORBIDDEN_PROPERTY);
  }
  if (
    key === 'constructor' &&
    value !== null &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'prototype')
  ) {
    throw badRequest(FORBIDDEN_PROPERTY);
  }
  // Postgres text can't hold NUL characters; drop them at the door.
  if (typeof value === 'string' && value.includes('\u0000')) {
    return value.replaceAll('\u0000', '');
  }
  return value;
}

/** The request's JSON body, parsed once per request (null when empty). */
export async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  const cached = c.get('body');
  if (cached !== undefined) {
    return cached;
  }
  const text = await c.req.text();
  let body: unknown = null;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text, rejectPrototypeKeys);
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw badRequest('Body is not valid JSON');
    }
  }
  c.set('body', body);
  return body;
}

/** Validate with zod; failures are 400s shaped like Fastify's. */
export function validate<T>(
  schema: ZodType<T>,
  value: unknown,
  label = 'body',
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const message = result.error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('/');
      return `${label}${path ? `/${path}` : ''} ${issue.message}`;
    })
    .join(', ');
  throw badRequest(message);
}
