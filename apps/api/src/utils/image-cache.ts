import { createHash } from 'node:crypto';

/**
 * The favicon/OG proxy's cache: the Workers Cache API (per data center)
 * instead of Redis. It caches HTTP responses, not data.
 */

const CACHE_ORIGIN = 'https://image-cache.openpanel.internal';
const TTL_SECONDS = 60 * 60 * 24;

function cacheKey(url: string, prefix: string): Request {
  // v3: the namespace the Redis cache used after the SVG passthrough fix.
  const hash = createHash('sha256').update(url).digest('hex');
  return new Request(`${CACHE_ORIGIN}/${prefix}/v3/${hash}`);
}

function getCache(): Cache | null {
  // `caches.default` is Workers-only (absent in Node tests).
  return typeof caches === 'undefined'
    ? null
    : (caches as unknown as { default: Cache }).default;
}

export async function getCachedImage(
  url: string,
  prefix: string,
): Promise<{ buffer: Uint8Array; contentType: string } | null> {
  const cache = getCache();
  const hit = await cache?.match(cacheKey(url, prefix));
  if (!hit) {
    return null;
  }
  return {
    buffer: new Uint8Array(await hit.arrayBuffer()),
    contentType: hit.headers.get('content-type') ?? 'application/octet-stream',
  };
}

export async function setCachedImage(
  url: string,
  prefix: string,
  buffer: Uint8Array,
  contentType: string,
): Promise<void> {
  const cache = getCache();
  await cache?.put(
    cacheKey(url, prefix),
    new Response(new Uint8Array(buffer), {
      headers: {
        'content-type': contentType,
        'cache-control': `public, max-age=${TTL_SECONDS}`,
      },
    }),
  );
}
