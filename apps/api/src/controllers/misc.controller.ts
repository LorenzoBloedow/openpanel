import { logger } from '@/utils/logger';
import { parseUrlMeta } from '@/utils/parseUrlMeta';
import {
  ALLOWED_IMAGE_CONTENT_TYPES,
  normalizeContentType,
  processImage,
  processOgImage,
} from '@/utils/image-proxy';
import { BlockedUrlError, assertPublicUrl, safeFetch } from '@/utils/safe-fetch';
import { getCachedImage, setCachedImage } from '@/utils/image-cache';
import type { FastifyReply, FastifyRequest } from '@/compat/fastify';

import {
  DEFAULT_IP_HEADER_ORDER,
  getClientIpFromHeaders,
} from '@openpanel/common/server/get-client-ip';
import { anQuery, anQueryOne } from '@openpanel/db/src/analytics/client';
import { sql } from '@openpanel/db/src/analytics/sql';
import {
  type CfGeoProperties,
  type GeoLocation,
  getGeoLocation,
} from '@openpanel/geo';
import { getCache } from '@openpanel/redis';
import { unavailable } from '@openpanel/runtime';

interface GetFaviconParams {
  url: string;
}

// Configuration
const MAX_BYTES = 1_000_000; // 1MB cap
const USER_AGENT = 'OpenPanel-FaviconProxy/1.0 (+https://openpanel.dev)';

/**
 * Shape check only. The destination is validated by `assertPublicUrl` /
 * `safeFetch` right before each outbound request, because a hostname can
 * resolve differently between validation and connection.
 */
function validateUrl(raw?: string): URL | null {
  try {
    if (!raw) throw new Error('Missing ?url');
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only http/https URLs are allowed');
    }
    return url;
  } catch {
    return null;
  }
}

// Fetch image with SSRF protection, timeout and size limits
async function fetchImage(
  url: URL,
): Promise<{ buffer: Uint8Array; contentType: string; status: number }> {
  try {
    // `safeFetch` validates and pins every hop, so a redirect cannot be used
    // to reach an internal address after the initial URL checks out.
    const result = await safeFetch(url, {
      timeoutMs: 10_000,
      maxBytes: MAX_BYTES,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'image/*,*/*;q=0.8',
      },
    });

    if (result.status !== 200) {
      return {
        buffer: Buffer.alloc(0),
        contentType: 'text/plain',
        status: result.status,
      };
    }

    const contentType = normalizeContentType(
      result.headers.get('content-type'),
    );
    if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
      logger.debug(
        { url: url.toString(), contentType },
        'Refusing non-image response',
      );
      return { buffer: Buffer.alloc(0), contentType: 'text/plain', status: 415 };
    }

    return { buffer: result.body, contentType, status: 200 };
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      logger.warn(
        { url: url.toString(), reason: error.message },
        'Blocked image fetch',
      );
    }
    return { buffer: Buffer.alloc(0), contentType: 'text/plain', status: 500 };
  }
}

/**
 * These bytes come from a third-party server, so make sure a browser treats
 * them strictly as an image: no MIME sniffing, no scripts, no embedding
 * privileges on the API origin.
 */
function setImageSecurityHeaders(reply: FastifyReply, contentType: string) {
  reply.header('Content-Type', contentType);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
  reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
}

// Check if URL is a direct image
function isDirectImage(url: URL): boolean {
  const imageExtensions = ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico'];
  return (
    imageExtensions.some((ext) => url.pathname.endsWith(`.${ext}`)) ||
    url.toString().includes('googleusercontent.com')
  );
}

export async function getFavicon(
  request: FastifyRequest<{
    Querystring: GetFaviconParams;
  }>,
  reply: FastifyReply,
) {
  try {
    logger.info({ url: request.query.url }, 'getFavicon');
    const url = validateUrl(request.query.url);
    if (!url) {
      return reply
        .status(404)
        .header('Content-Type', 'text/plain')
        .send('Not found');
    }

    // Check the destination before anything else, so a blocked host is not
    // leaked to the DuckDuckGo fallback below either.
    await assertPublicUrl(url);

    // Check cache first
    const cached = await getCachedImage(url.toString(), 'favicon');
    if (cached) {
      setImageSecurityHeaders(reply, cached.contentType);
      reply.header('Cache-Control', 'public, max-age=604800, immutable');
      return reply.send(cached.buffer);
    }

    let imageUrl: URL;
    // If it's a direct image URL, use it directly
    if (isDirectImage(url)) {
      imageUrl = url;
    } else {
      logger.info({ url: url.toString() }, 'before parseUrlMeta');
      // For website URLs, extract favicon from HTML
      const meta = await parseUrlMeta(url.toString());
      logger.info(
        { url: url.toString(), favicon: meta?.favicon },
        'parseUrlMeta result',
      );
      if (meta?.favicon) {
        imageUrl = new URL(meta.favicon);
      } else {
        // Try standard favicon location first
        const { origin } = url;
        imageUrl = new URL(`${origin}/favicon.ico`);
      }
    }

    logger.info(
      {
        originalUrl: url.toString(),
        imageUrl: imageUrl.toString(),
      },
      'Fetching favicon',
    );

    // Fetch the image
    let { buffer, contentType, status } = await fetchImage(imageUrl);

    logger.info(
      {
        originalUrl: url.toString(),
        imageUrl: imageUrl.toString(),
        status,
        bufferLength: buffer.length,
        contentType,
      },
      'Favicon fetch result',
    );

    // If the direct favicon fetch failed and it's not from DuckDuckGo's service,
    // try DuckDuckGo's favicon service as a fallback
    if (buffer.length === 0 && !imageUrl.hostname.includes('duckduckgo.com')) {
      const { hostname } = url;
      const duckduckgoUrl = new URL(
        `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
      );

      logger.info(
        {
          originalUrl: url.toString(),
          duckduckgoUrl: duckduckgoUrl.toString(),
        },
        'Trying DuckDuckGo favicon service',
      );

      const duckduckgoResult = await fetchImage(duckduckgoUrl);
      buffer = duckduckgoResult.buffer;
      contentType = duckduckgoResult.contentType;
      status = duckduckgoResult.status;
      imageUrl = duckduckgoUrl;

      logger.info(
        {
          status,
          bufferLength: buffer.length,
          contentType,
        },
        'DuckDuckGo favicon result',
      );
    }

    // Accept any response as long as we have valid image data
    if (buffer.length === 0) {
      return reply
        .status(404)
        .header('Content-Type', 'text/plain')
        .send('Not found');
    }

    // Resize to a 30px PNG, or serve a verified icon/raster as-is. The
    // response type comes from what we produced, never from the upstream.
    const processed = await processImage(
      buffer,
      imageUrl.toString(),
      contentType,
    );

    logger.info(
      {
        originalUrl: url.toString(),
        originalBufferLength: buffer.length,
        processedBufferLength: processed.buffer.length,
      },
      'Favicon processing result',
    );

    await setCachedImage(
      url.toString(),
      'favicon',
      processed.buffer,
      processed.contentType,
    );

    setImageSecurityHeaders(reply, processed.contentType);
    reply.header('Cache-Control', 'public, max-age=3600, immutable');
    return reply.send(processed.buffer);
  } catch (error: any) {
    if (error instanceof BlockedUrlError) {
      logger.warn(
        { url: request.query.url, reason: error.message },
        'Blocked favicon fetch',
      );
      reply.header('Cache-Control', 'no-store');
      return reply
        .status(400)
        .header('Content-Type', 'text/plain')
        .send('Bad request');
    }

    logger.error(
      { err: error, url: request.query.url },
      'Favicon fetch error',
    );

    const message =
      process.env.NODE_ENV === 'production'
        ? 'Bad request'
        : (error?.message ?? 'Error');
    reply.header('Cache-Control', 'no-store');
    return reply.status(400).send(message);
  }
}

/**
 * The Cache API can't enumerate keys, so the proxy caches can't be cleared
 * wholesale; entries expire after a day. Kept for API compatibility.
 */
export async function clearFavicons(
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  return reply.status(200).send('OK');
}

export async function clearOgImages(
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  return reply.status(200).send('OK');
}

/** Self-hosting telemetry is collected by openpanel.dev, not on Cloudflare. */
export const ping = unavailable<
  (request: FastifyRequest, reply: FastifyReply) => Promise<never>
>('telemetry');

export async function stats(_request: FastifyRequest, reply: FastifyReply) {
  const res = await getCache('api:stats', 60 * 60, async () => {
    const [projects, last24h] = await Promise.all([
      anQuery<{ project_id: string; count: number }>(sql`
        SELECT project_id, sum(event_count)::bigint AS count
        FROM analytics.event_names
        GROUP BY project_id
      `),
      anQueryOne<{ count: number }>(sql`
        SELECT count(*)::bigint AS count FROM analytics.events
        WHERE created_at > now() - interval '24 hours'
      `),
    ]);
    return { projects, last24hCount: last24h?.count ?? 0 };
  });

  reply.status(200).send({
    projectsCount: res.projects.length,
    eventsCount: res.projects.reduce((acc, { count }) => acc + count, 0),
    eventsLast24hCount: res.last24hCount,
  });
}

function geoSource(request: FastifyRequest) {
  return {
    cf: request.raw.req.raw.cf as CfGeoProperties | undefined,
    connectingIp: request.headers['cf-connecting-ip'],
  };
}

export async function getGeo(request: FastifyRequest, reply: FastifyReply) {
  const { ip, header } = getClientIpFromHeaders(request.headers);
  const others = await Promise.all(
    DEFAULT_IP_HEADER_ORDER.map(async (header) => {
      const { ip } = getClientIpFromHeaders(request.headers, header);
      return {
        header,
        ip,
        geo: await getGeoLocation(ip, geoSource(request)),
      };
    }),
  );

  if (!ip) {
    return reply.status(400).send('Bad Request');
  }
  const geo = await getGeoLocation(ip, geoSource(request));
  return reply.status(200).send({
    selected: {
      geo,
      ip,
      header,
    },
    ...others.reduce(
      (acc, other) => {
        acc[other.header] = other;
        return acc;
      },
      {} as Record<string, { ip: string; header: string; geo: GeoLocation }>,
    ),
  });
}

export async function getOgImage(
  request: FastifyRequest<{
    Querystring: {
      url: string;
    };
  }>,
  reply: FastifyReply,
) {
  try {
    const url = validateUrl(request.query.url);
    if (!url) {
      return getFavicon(request, reply);
    }
    await assertPublicUrl(url);

    // Check cache first
    const cached = await getCachedImage(url.toString(), 'og');
    if (cached) {
      setImageSecurityHeaders(reply, cached.contentType);
      reply.header('Cache-Control', 'public, max-age=604800, immutable');
      return reply.send(cached.buffer);
    }

    let imageUrl: URL;

    // If it's a direct image URL, use it directly
    if (isDirectImage(url)) {
      imageUrl = url;
    } else {
      // For website URLs, extract OG image from HTML
      const meta = await parseUrlMeta(url.toString());
      if (meta?.ogImage) {
        imageUrl = new URL(meta.ogImage);
      } else {
        // No OG image found, return a fallback
        return getFavicon(request, reply);
      }
    }

    // Fetch the image
    const { buffer, status } = await fetchImage(imageUrl);

    if (status !== 200 || buffer.length === 0) {
      return getFavicon(request, reply);
    }

    // At most 300px wide (PNG), or a verified raster as-is
    const processed = await processOgImage(buffer, imageUrl.toString());

    await setCachedImage(url.toString(), 'og', processed.buffer, processed.contentType);

    setImageSecurityHeaders(reply, processed.contentType);
    reply.header('Cache-Control', 'public, max-age=3600, immutable');
    return reply.send(processed.buffer);
  } catch (error: any) {
    if (error instanceof BlockedUrlError) {
      logger.warn(
        { url: request.query.url, reason: error.message },
        'Blocked OG image fetch',
      );
      reply.header('Cache-Control', 'no-store');
      return reply
        .status(400)
        .header('Content-Type', 'text/plain')
        .send('Bad request');
    }

    logger.error(
      { err: error, url: request.query.url },
      'OG image fetch error',
    );

    const message =
      process.env.NODE_ENV === 'production'
        ? 'Bad request'
        : (error?.message ?? 'Error');
    reply.header('Cache-Control', 'no-store');
    return reply.status(400).send(message);
  }
}
