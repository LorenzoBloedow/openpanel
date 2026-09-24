import { describe, expect, it } from 'vitest';
import { __testing } from './rate-limit';

const { getBlockDurationMs, BLOCK_BASE_MS, BLOCK_MAX_MS, MAX_STRIKES } =
  __testing;

describe('rate limit escalation', () => {
  it('doubles the lockout on every strike', () => {
    expect(getBlockDurationMs(1)).toBe(BLOCK_BASE_MS);
    expect(getBlockDurationMs(2)).toBe(BLOCK_BASE_MS * 2);
    expect(getBlockDurationMs(3)).toBe(BLOCK_BASE_MS * 4);
    expect(getBlockDurationMs(4)).toBe(BLOCK_BASE_MS * 8);
  });

  it('caps the lockout instead of overflowing into absurd durations', () => {
    expect(getBlockDurationMs(MAX_STRIKES)).toBe(BLOCK_MAX_MS);
    expect(getBlockDurationMs(1000)).toBe(BLOCK_MAX_MS);
  });

  it('reaches the cap at MAX_STRIKES and not before', () => {
    expect(getBlockDurationMs(MAX_STRIKES - 1)).toBeLessThan(BLOCK_MAX_MS);
  });

  it('formats the wait as something a human can act on', () => {
    expect(__testing.formatDuration(30_000)).toBe('30 seconds');
    expect(__testing.formatDuration(5 * 60_000)).toBe('5 minutes');
    expect(__testing.formatDuration(24 * 60 * 60_000)).toBe('24 hours');
  });
});

describe('enforceRateLimit (Postgres lockout)', async () => {
  const { runWithScope } = await import('@openpanel/runtime');
  const { createTestDatabase } = await import(
    '@openpanel/db/src/testing/database'
  );
  const { enforceRateLimit } = await import('./rate-limit');
  const { db } = await import('@openpanel/db');
  const { afterAll, beforeAll } = await import('vitest');

  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb?.drop();
  });

  const inScope = <T>(fn: () => Promise<T>) =>
    runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, fn);
  const req = (ip: string) => ({
    headers: { 'cf-connecting-ip': ip, 'user-agent': 'test' },
    log: { warn: () => undefined, error: () => undefined } as never,
  });

  it('blocks past the limit and doubles the block on the next strike', async () => {
    const limit = { path: 'auth.signIn', max: 3, windowMs: 60_000 };
    await inScope(async () => {
      for (let i = 0; i < 3; i++) {
        await enforceRateLimit({ req: req('198.51.100.1'), ...limit });
      }
      await expect(
        enforceRateLimit({ req: req('198.51.100.1'), ...limit }),
      ).rejects.toThrow('Too many requests. Try again in 5 minutes.');

      // Another IP is unaffected.
      await enforceRateLimit({ req: req('198.51.100.2'), ...limit });

      // Still blocked; the cooldown keeps a human's retries from escalating.
      await expect(
        enforceRateLimit({ req: req('198.51.100.1'), ...limit }),
      ).rejects.toThrow('5 minutes');

      // Once the cooldown has passed, knocking earns a second strike.
      await db.rateLimitBlock.update({
        where: {
          path_fingerprint: { path: limit.path, fingerprint: '198.51.100.1' },
        },
        data: { cooldownUntil: new Date(Date.now() - 1000) },
      });
      await expect(
        enforceRateLimit({ req: req('198.51.100.1'), ...limit }),
      ).rejects.toThrow('10 minutes');
      const block = await db.rateLimitBlock.findUniqueOrThrow({
        where: {
          path_fingerprint: { path: limit.path, fingerprint: '198.51.100.1' },
        },
      });
      expect(block.strikes).toBe(2);
    });
  });

  it('uses the Workers binding for the window when one is bound', async () => {
    let calls = 0;
    const binding = {
      limit: async () => {
        calls++;
        return { success: calls <= 1 };
      },
    };
    await runWithScope(
      { env: { DATABASE_URL: testDb.url, RL_AUTH_5: binding }, route: 'direct' },
      async () => {
        const limit = { path: 'auth.signUp', max: 5, windowMs: 60_000 };
        await enforceRateLimit({ req: req('198.51.100.9'), ...limit });
        await expect(
          enforceRateLimit({ req: req('198.51.100.9'), ...limit }),
        ).rejects.toThrow('5 minutes');
      },
    );
    expect(calls).toBe(2);
  });
});
