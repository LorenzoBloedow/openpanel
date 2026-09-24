import { FeatureUnavailableError } from '@openpanel/runtime';
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { createTRPCRouter, publicProcedure } from './trpc';

const router = createTRPCRouter({
  ai: publicProcedure.query(() => {
    throw new FeatureUnavailableError('ai');
  }),
  broken: publicProcedure.query(() => {
    throw new Error('database is down');
  }),
});

const caller = router.createCaller({
  req: { headers: {}, ip: '203.0.113.1', log: console as never },
  session: { userId: null, session: null, user: null } as never,
  cookies: {},
  setCookie: () => undefined,
});

describe('features compiled out on Cloudflare', () => {
  it('answer NOT_IMPLEMENTED with the feature message', async () => {
    const error = await caller.ai().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect((error as TRPCError).message).toMatch(/not available on Cloudflare/i);
  });

  it('leave other failures as internal errors', async () => {
    await expect(caller.broken()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});
