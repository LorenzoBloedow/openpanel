import { getTrustedIpFromHeaders } from '@openpanel/common/server/get-client-ip';

import type { FastifyInstance, FastifyRequest } from '@/compat/fastify';
import { sanitizeUrl } from './sanitize-url';

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The public API's limits on Workers rate limiting bindings (wrangler
 * `ratelimits`, periods of 10 or 60 seconds): one binding per limit so
 * endpoints with different limits never share a counter.
 */
const BINDINGS: Record<string, 'RL_PUBLIC' | 'RL_MANAGE'> = {
  '100/10 seconds': 'RL_PUBLIC',
  '20/10 seconds': 'RL_MANAGE',
};

/**
 * Rate limit every route of a router, keyed by client id (or the trusted IP
 * when there is none), like @fastify/rate-limit did. The binding counts per
 * Cloudflare location, so the limit is approximate by design.
 */
export function activateRateLimiter<T extends FastifyRequest>({
  fastify,
  max,
  timeWindow,
  keyGenerator,
}: {
  fastify: FastifyInstance;
  max: number;
  timeWindow?: string;
  keyGenerator?: (req: T) => string | undefined;
}) {
  const bindingName = BINDINGS[`${max}/${timeWindow ?? '1 minute'}`];
  if (!bindingName) {
    throw new Error(
      `No rate limiting binding for ${max} requests per ${timeWindow}; add one to wrangler.jsonc`,
    );
  }

  fastify.addHook('onRequest', async (req, reply) => {
    const binding = (req.raw.env as unknown as Record<string, RateLimitBinding | undefined>)[
      bindingName
    ];
    if (!binding) {
      return;
    }
    const key =
      keyGenerator?.(req as T) ||
      req.headers['openpanel-client-id'] ||
      getTrustedIpFromHeaders(req.headers).ip;
    const { success } = await binding.limit({ key: key || 'unknown' });
    if (success) {
      return;
    }
    const { ip, header } = getTrustedIpFromHeaders(req.headers);
    req.log.warn(
      {
        clientId: req.headers['openpanel-client-id'],
        ip,
        ipHeader: header,
        url: sanitizeUrl(req.url),
        userAgent: req.headers['user-agent'],
      },
      'rate limit exceeded',
    );
    reply.status(429).send({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'You have exceeded the rate limit for this endpoint.',
    });
  });
}
