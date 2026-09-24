import ipaddr from 'ipaddr.js';

/**
 * SSRF guard for the endpoints that fetch user-supplied URLs (the favicon/OG
 * proxy and webhook-style deliveries).
 *
 * On Cloudflare Workers outbound `fetch` leaves from Cloudflare's edge, which
 * cannot reach private networks, loopback or link-local metadata services —
 * the class of targets the old Node implementation defended against by
 * resolving hostnames and pinning sockets to the validated address. That
 * pinning (undici + node:dns) is neither available nor needed here.
 *
 * What remains, as defense in depth:
 * - only http/https,
 * - IP-literal hosts must be publicly routable,
 * - redirects are followed manually so every hop is re-validated,
 * - responses are read under a size cap and a timeout.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

/**
 * ipaddr.js range names that are not publicly routable. `unicast` is the only
 * range we accept; this list is spelled out so the intent is reviewable.
 */
const BLOCKED_RANGES = new Set([
  'unspecified', // 0.0.0.0/8, ::
  'broadcast', // 255.255.255.255
  'multicast', // 224.0.0.0/4, ff00::/8
  'linkLocal', // 169.254.0.0/16 (cloud metadata), fe80::/10
  'loopback', // 127.0.0.0/8, ::1
  'private', // 10/8, 172.16/12, 192.168/16
  'uniqueLocal', // fc00::/7
  'carrierGradeNat', // 100.64.0.0/10
  'reserved', // 192.0.0.0/24, 198.18/15, 240/4, 2001::/32, ...
  'benchmarking',
  'as112',
  'amt',
  'rfc6052', // 64:ff9b::/96
  'rfc6145',
  'teredo',
  '6to4', // 2002::/16
]);

export function isBlockedIp(ip: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(ip);
  } catch {
    // Unparseable means we cannot prove it is safe.
    return true;
  }

  // ::ffff:127.0.0.1 and friends must be judged as the IPv4 address they carry.
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isBlockedIp(v6.toIPv4Address().toString());
    }
  }

  return BLOCKED_RANGES.has(parsed.range());
}

function stripBrackets(hostname: string) {
  // WHATWG URL keeps the brackets around IPv6 literals ("[::1]").
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);

/**
 * Reject hosts that are obviously internal. IP literals are checked against
 * the blocked ranges; names are left to the platform, whose egress cannot
 * reach non-public addresses.
 */
function assertPublicHost(hostname: string): string[] {
  const host = stripBrackets(hostname).toLowerCase();
  if (!host) {
    throw new BlockedUrlError('Missing host');
  }
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    throw new BlockedUrlError(`Refusing to connect to ${host}`);
  }
  if (ipaddr.isValid(host)) {
    if (isBlockedIp(host)) {
      throw new BlockedUrlError(`Refusing to connect to ${host}`);
    }
    return [host];
  }
  return [];
}

/**
 * Validate a URL's scheme and destination without fetching it.
 * Throws {@link BlockedUrlError} when the URL must not be requested.
 * Returns the IP literal when the host is one, otherwise an empty list.
 */
export async function assertPublicUrl(url: URL): Promise<string[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError('Only http/https URLs are allowed');
  }
  return assertPublicHost(url.hostname);
}

/** Validate a bare hostname (no URL available). */
export async function assertPublicHostname(
  hostname: string,
): Promise<string[]> {
  return assertPublicHost(hostname);
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  method?: string;
  /** Request body, for the POST callers (webhook delivery). */
  body?: string;
  /** Abort the whole chain after this many milliseconds. */
  timeoutMs?: number;
  maxRedirects?: number;
  /**
   * When false, a 3xx is returned as-is instead of being followed. Callers
   * that walk the chain themselves still get per-hop validation.
   */
  followRedirects?: boolean;
  /** Reject responses whose body exceeds this many bytes. */
  maxBytes?: number;
  /** Caller-owned cancellation, combined with the timeout above. */
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  status: number;
  headers: Headers;
  body: Buffer;
  finalUrl: string;
  /** Every URL that was requested, in order, with the status it returned. */
  chain: { url: string; status: number }[];
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5_000_000;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BlockedUrlError('Response exceeded the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    await body.cancel().catch(() => {
      // best effort
    });
  }

  return Buffer.concat(chunks);
}

export interface SafeFetchStreamResult {
  status: number;
  headers: Headers;
  /** The live response body. Consume it, then call {@link close}. */
  body: ReadableStream<Uint8Array> | null;
  finalUrl: string;
  chain: { url: string; status: number }[];
  /** Release the response body. Safe to call more than once. */
  close: () => Promise<void>;
}

function combineSignals(
  timeoutSignal: AbortSignal,
  callerSignal?: AbortSignal,
): AbortSignal {
  return callerSignal
    ? AbortSignal.any([timeoutSignal, callerSignal])
    : timeoutSignal;
}

/** Walk the redirect chain, validating every hop before requesting it. */
async function walkToFinalResponse(
  input: string | URL,
  options: SafeFetchOptions,
  signal: AbortSignal,
): Promise<{
  response: Response;
  finalUrl: string;
  chain: { url: string; status: number }[];
}> {
  const followRedirects = options.followRedirects ?? true;
  const maxRedirects = followRedirects
    ? (options.maxRedirects ?? DEFAULT_MAX_REDIRECTS)
    : 0;
  const chain: { url: string; status: number }[] = [];

  let current = input instanceof URL ? input : new URL(input);

  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);

    const response = await fetch(current, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal,
      // Handled below so every hop is re-validated.
      redirect: 'manual',
    });

    const status = response.status;
    const location = response.headers.get('location');
    chain.push({ url: current.toString(), status });

    if (!(followRedirects && REDIRECT_STATUS.has(status) && location)) {
      return { response, finalUrl: current.toString(), chain };
    }

    // A redirect hop is discarded entirely; the next one is validated afresh.
    await response.body?.cancel().catch(() => {
      // best effort
    });

    if (hop >= maxRedirects) {
      throw new BlockedUrlError('Too many redirects');
    }

    try {
      current = new URL(location, current);
    } catch {
      throw new BlockedUrlError('Invalid redirect location');
    }
  }
}

/**
 * `fetch` with SSRF protection: every hop is validated before it is
 * requested, and the body is read under a size cap.
 * Throws {@link BlockedUrlError} if any hop points somewhere non-public.
 */
export async function safeFetch(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const { response, finalUrl, chain } = await walkToFinalResponse(
      input,
      options,
      combineSignals(controller.signal, options.signal),
    );

    const body = await readBodyWithLimit(response.body, maxBytes);
    return {
      status: response.status,
      headers: response.headers,
      body,
      finalUrl,
      chain,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Same guarantees as {@link safeFetch}, but hands back the live body instead of
 * buffering it.
 *
 * `timeoutMs` bounds the redirect walk only — once the caller owns the stream,
 * a long download is legitimate, so cancellation after that point is the
 * caller's job via `options.signal`.
 */
export async function safeFetchStream(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeFetchStreamResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const { response, finalUrl, chain } = await walkToFinalResponse(
      input,
      options,
      combineSignals(controller.signal, options.signal),
    );

    let closed = false;
    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      finalUrl,
      chain,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        await response.body?.cancel().catch(() => {
          // best effort
        });
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
