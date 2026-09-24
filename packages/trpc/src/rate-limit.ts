import { getTrustedIpFromHeaders } from '@openpanel/common/server/get-client-ip';
import { db } from '@openpanel/db';
import { LRUCache } from '@openpanel/redis';
import { getEnv } from '@openpanel/runtime';
import { TRPCError } from '@trpc/server';

import type { TrpcRequestInfo } from './trpc';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * The block handed out the first time a fingerprint blows through its window.
 * It doubles on every further strike, so a client that keeps knocking walks
 * 5m -> 10m -> 20m -> ... -> BLOCK_MAX_MS.
 */
const BLOCK_BASE_MS = 5 * MINUTE;
const BLOCK_MAX_MS = 24 * HOUR;

/**
 * Strikes only decay after a full quiet day, and every new strike pushes the
 * expiry out again. Sustained abuse therefore stays at the 24h block forever -
 * the attacker has to actually stop to climb back down.
 */
const STRIKE_TTL_MS = 24 * HOUR;

/** Past this the duration is capped anyway, so stop counting. */
const MAX_STRIKES = Math.ceil(Math.log2(BLOCK_MAX_MS / BLOCK_BASE_MS)) + 1;

/**
 * A blocked client that keeps hammering earns further strikes, but at most one
 * per cooldown. A human clicking "sign in" three more times in frustration adds
 * one strike; a bot at 5 req/s reaches the 24h cap in under ten minutes.
 */
const ESCALATION_COOLDOWN_MS = MINUTE;

export interface RateLimitOptions {
  /** Requests allowed per window before the first block. */
  max: number;
  windowMs: number;
}

/** The Workers rate limiting binding (`ratelimits` in wrangler.jsonc). */
interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The window counting runs on Workers rate limiting bindings, whose period
 * is 10 or 60 seconds: every auth limit uses a 60 s window (the 30 s ones
 * became 60 s). One binding per limit, so procedures with different limits
 * never share a counter.
 */
const BINDINGS: Record<number, string> = {
  3: 'RL_AUTH_3',
  5: 'RL_AUTH_5',
};

function getBinding(max: number): RateLimitBinding | undefined {
  const name = BINDINGS[max];
  if (!name) {
    return undefined;
  }
  return getEnv<Record<string, RateLimitBinding | undefined>>()[name];
}

/**
 * Per-isolate counter, used when no binding is configured (Node tests and
 * scripts) or the binding fails, so the endpoint is never unthrottled.
 */
const fallbackCounters = new LRUCache<string, number>({
  max: 10_000,
  ttl: 5 * MINUTE,
});

function getBlockDurationMs(strikes: number): number {
  return Math.min(BLOCK_BASE_MS * 2 ** (strikes - 1), BLOCK_MAX_MS);
}

function formatDuration(ms: number): string {
  const seconds = Math.ceil(ms / SECOND);
  if (seconds < 90) {
    return `${seconds} seconds`;
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) {
    return `${minutes} minutes`;
  }
  return `${Math.ceil(minutes / 60)} hours`;
}

/**
 * The identity we rate limit on. Deliberately ignores the client-forwarded IP
 * headers that `getClientIpFromHeaders` prefers - those are attacker-controlled
 * and would make every request its own bucket.
 */
export function getRateLimitIdentity(req: Pick<TrpcRequestInfo, 'headers'>) {
  const { ip, header } = getTrustedIpFromHeaders(req.headers);

  return {
    // Everything we cannot identify shares one bucket. Fail closed: an edge
    // that stops forwarding IPs should throttle, not open the gates.
    fingerprint: ip || 'unknown',
    ipHeader: header,
  };
}

function tooManyRequests(blockMs: number): TRPCError {
  return new TRPCError({
    code: 'TOO_MANY_REQUESTS',
    message: `Too many requests. Try again in ${formatDuration(blockMs)}.`,
  });
}

interface Escalation {
  strikes: number;
  blockMs: number;
}

/**
 * `strikes` → the SQL for its block duration (same curve as
 * getBlockDurationMs). The raw queries below only interpolate these numeric
 * constants; path and fingerprint are bind parameters.
 */
const blockUntilSql = (strikesSql: string) =>
  `now() + make_interval(secs => LEAST(${BLOCK_BASE_MS / SECOND} * power(2, (${strikesSql}) - 1), ${BLOCK_MAX_MS / SECOND}))`;

/**
 * Record a strike and (re)arm the block, atomically. A strike older than a
 * quiet day starts over at one.
 */
async function escalate(path: string, fingerprint: string): Promise<Escalation> {
  const nextStrikes = `CASE WHEN b."strikeExpiresAt" > now() THEN LEAST(b.strikes + 1, ${MAX_STRIKES}) ELSE 1 END`;
  const rows = await db.$queryRawUnsafe<{ strikes: number }[]>(
    `INSERT INTO rate_limit_blocks AS b
       (path, fingerprint, strikes, "blockedUntil", "strikeExpiresAt", "cooldownUntil", "createdAt", "updatedAt")
     VALUES ($1, $2, 1, ${blockUntilSql('1')},
       now() + make_interval(secs => ${STRIKE_TTL_MS / SECOND}),
       now() + make_interval(secs => ${ESCALATION_COOLDOWN_MS / SECOND}), now(), now())
     ON CONFLICT (path, fingerprint) DO UPDATE SET
       strikes = ${nextStrikes},
       "blockedUntil" = ${blockUntilSql(nextStrikes)},
       "strikeExpiresAt" = now() + make_interval(secs => ${STRIKE_TTL_MS / SECOND}),
       "cooldownUntil" = now() + make_interval(secs => ${ESCALATION_COOLDOWN_MS / SECOND}),
       "updatedAt" = now()
     RETURNING strikes`,
    path,
    fingerprint,
  );
  const strikes = Number(rows[0]?.strikes ?? 1);
  return { strikes, blockMs: getBlockDurationMs(strikes) };
}

/**
 * Knocking during a block extends it, at most once per cooldown. Returns
 * null when the cooldown hasn't passed (no new strike).
 */
async function escalateWhileBlocked(
  path: string,
  fingerprint: string,
): Promise<Escalation | null> {
  const nextStrikes = `LEAST(b.strikes + 1, ${MAX_STRIKES})`;
  const rows = await db.$queryRawUnsafe<{ strikes: number }[]>(
    `UPDATE rate_limit_blocks AS b SET
       strikes = ${nextStrikes},
       "blockedUntil" = ${blockUntilSql(nextStrikes)},
       "strikeExpiresAt" = now() + make_interval(secs => ${STRIKE_TTL_MS / SECOND}),
       "cooldownUntil" = now() + make_interval(secs => ${ESCALATION_COOLDOWN_MS / SECOND}),
       "updatedAt" = now()
     WHERE b.path = $1 AND b.fingerprint = $2 AND b."cooldownUntil" <= now()
     RETURNING strikes`,
    path,
    fingerprint,
  );
  if (rows.length === 0) {
    return null;
  }
  const strikes = Number(rows[0]!.strikes);
  return { strikes, blockMs: getBlockDurationMs(strikes) };
}

/** Is this request within the window's allowance? */
async function withinWindow(
  { path, fingerprint, max, windowMs }: RateLimitOptions & { path: string; fingerprint: string },
  req: Pick<TrpcRequestInfo, 'log'>,
): Promise<boolean> {
  const binding = getBinding(max);
  if (binding) {
    try {
      const { success } = await binding.limit({ key: `${path}:${fingerprint}` });
      return success;
    } catch (error) {
      req.log?.error({ err: error, path }, 'rate limit binding unavailable');
    }
  }
  const counterKey = `${path}:${fingerprint}`;
  const hits = (fallbackCounters.get(counterKey) ?? 0) + 1;
  fallbackCounters.set(counterKey, hits, { ttl: windowMs });
  return hits <= max;
}

/**
 * IP rate limiting with exponential lockout.
 *
 * Counting per window runs on the Workers rate limiting bindings; the
 * lockout (strikes, block, cooldown) lives in Postgres (`rate_limit_blocks`),
 * read on every guarded call and written only on violations.
 *
 * Blocks are keyed per procedure, so an office NAT that trips the sign-in limit
 * does not lose the rest of the dashboard. Every block is logged as
 * `rate limit blocked` with the resolved IP so repeat offenders can be
 * pulled out of the logs and blocked at the edge.
 */
export async function enforceRateLimit({
  req,
  path,
  max,
  windowMs,
}: RateLimitOptions & {
  req: Pick<TrpcRequestInfo, 'headers' | 'log'>;
  /** tRPC procedure path - blocks are scoped to it. */
  path: string;
}): Promise<void> {
  const { fingerprint, ipHeader } = getRateLimitIdentity(req);

  const log = (message: string, payload: Escalation & { hits?: number }) =>
    req.log?.warn(
      {
        ip: fingerprint,
        ipHeader,
        path,
        userAgent: req.headers['user-agent'],
        strikes: payload.strikes,
        blockedForSeconds: Math.ceil(payload.blockMs / SECOND),
        blockedUntil: new Date(Date.now() + payload.blockMs).toISOString(),
        max,
        windowMs,
      },
      message,
    );

  let blockedUntil: Date | null = null;
  try {
    const block = await db.rateLimitBlock.findUnique({
      where: { path_fingerprint: { path, fingerprint } },
      select: { blockedUntil: true },
    });
    blockedUntil = block?.blockedUntil ?? null;
  } catch (error) {
    req.log?.error({ err: error, path }, 'rate limit store unavailable');
  }

  const blockMs = blockedUntil ? blockedUntil.getTime() - Date.now() : 0;
  if (blockMs > 0) {
    let escalated: Escalation | null = null;
    try {
      escalated = await escalateWhileBlocked(path, fingerprint);
    } catch (error) {
      req.log?.error({ err: error, path }, 'rate limit store unavailable');
    }
    if (!escalated) {
      throw tooManyRequests(blockMs);
    }
    log('rate limit blocked', escalated);
    throw tooManyRequests(escalated.blockMs);
  }

  if (await withinWindow({ path, fingerprint, max, windowMs }, req)) {
    return;
  }

  let escalated: Escalation;
  try {
    escalated = await escalate(path, fingerprint);
  } catch (error) {
    req.log?.error({ err: error, path }, 'rate limit store unavailable');
    throw tooManyRequests(windowMs);
  }
  log('rate limit blocked', escalated);
  throw tooManyRequests(escalated.blockMs);
}

/** Drop lockouts whose strikes have decayed (maintenance cron). */
export async function deleteExpiredRateLimitBlocks(): Promise<number> {
  const { count } = await db.rateLimitBlock.deleteMany({
    where: { strikeExpiresAt: { lt: new Date() } },
  });
  return count;
}

export const __testing = {
  BLOCK_BASE_MS,
  BLOCK_MAX_MS,
  MAX_STRIKES,
  ESCALATION_COOLDOWN_MS,
  getBlockDurationMs,
  formatDuration,
  escalate,
  escalateWhileBlocked,
};
