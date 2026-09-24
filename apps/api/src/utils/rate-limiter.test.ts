/**
 * The public API's rate limiter on Workers rate limiting bindings: the key
 * it counts by, the 429 it answers with, and its log line — which records
 * the request URL, a credential carrier on some routes.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { mountFastifyPlugin } from '@/compat/fastify';
import type { AppEnv } from '@/env';
import { activateRateLimiter } from './rate-limiter';

const SECRET = 'c3VwZXItc2VjcmV0LXRva2Vu';

async function limitedApp(options: { max: number; timeWindow: string }) {
  const warn = vi.fn();
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set('logger', { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never);
    await next();
  });
  await mountFastifyPlugin(app, '/limited', (fastify) => {
    activateRateLimiter({ fastify, ...options });
    fastify.get('/', async () => ({ ok: true }));
  });
  return { app, warn };
}

function binding(success: boolean) {
  const keys: string[] = [];
  return {
    keys,
    limit: vi.fn(async ({ key }: { key: string }) => {
      keys.push(key);
      return { success };
    }),
  };
}

describe('activateRateLimiter', () => {
  it('counts per client id and lets requests under the limit through', async () => {
    const { app } = await limitedApp({ max: 100, timeWindow: '10 seconds' });
    const RL_PUBLIC = binding(true);
    const response = await app.request(
      '/limited',
      { headers: { 'openpanel-client-id': 'client-1' } },
      { RL_PUBLIC },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(RL_PUBLIC.keys).toEqual(['client-1']);
  });

  it('falls back to the trusted client IP', async () => {
    const { app } = await limitedApp({ max: 20, timeWindow: '10 seconds' });
    const RL_MANAGE = binding(true);
    await app.request('/limited', { headers: { 'cf-connecting-ip': '203.0.113.9' } }, { RL_MANAGE });
    expect(RL_MANAGE.keys).toEqual(['203.0.113.9']);
  });

  it('answers 429 and does not log the value of a sensitive query parameter', async () => {
    const { app, warn } = await limitedApp({ max: 100, timeWindow: '10 seconds' });
    const response = await app.request(
      `/limited?token=${SECRET}&projectId=p1`,
      { headers: { 'openpanel-client-id': 'client-1' } },
      { RL_PUBLIC: binding(false) },
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'You have exceeded the rate limit for this endpoint.',
    });

    const payload = warn.mock.calls[0]?.[0];
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(payload.url).toBe('/limited?token=[REDACTED]&projectId=p1');
  });

  it('refuses a limit that has no binding', async () => {
    await expect(limitedApp({ max: 7, timeWindow: '1 minute' })).rejects.toThrow(
      'No rate limiting binding for 7 requests per 1 minute',
    );
  });
});
