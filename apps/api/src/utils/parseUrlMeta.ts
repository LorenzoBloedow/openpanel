import { safeFetch } from '@openpanel/common/server/safe-fetch';

/**
 * The favicon and OG image of a page, read with HTMLRewriter (a Workers
 * built-in) from the first megabyte of its HTML.
 */

const PAGE_TIMEOUT_MS = 500;
const PAGE_MAX_BYTES = 1_000_000;
const ICON_RELS = ['shortcut icon', 'icon', 'apple-touch-icon'];
const OG_IMAGE_KEYS = [
  'og:image:secure_url',
  'og:image:url',
  'og:image',
  'twitter:image:src',
  'twitter:image',
];

function fallbackFavicon(url: string) {
  try {
    const hostname = new URL(url).hostname;
    return `https://icons.duckduckgo.com/ip3/${hostname}.ico`;
  } catch {
    return `https://icons.duckduckgo.com/ip3/${url}.ico`;
  }
}

function resolve(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export async function parseUrlMeta(url: string) {
  try {
    const page = await safeFetch(url, {
      timeoutMs: PAGE_TIMEOUT_MS,
      maxBytes: PAGE_MAX_BYTES,
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    const icons: { rel: string; href: string }[] = [];
    const meta: Record<string, string> = {};

    // biome-ignore lint/correctness/noUndeclaredVariables: a workerd global
    await new HTMLRewriter()
      .on('link[rel][href]', {
        element(element) {
          const rel = (element.getAttribute('rel') ?? '').trim().toLowerCase();
          const href = element.getAttribute('href');
          if (href && ICON_RELS.includes(rel)) {
            icons.push({ rel, href });
          }
        },
      })
      .on('meta[content]', {
        element(element) {
          const key = (
            element.getAttribute('property') ??
            element.getAttribute('name') ??
            ''
          ).toLowerCase();
          const content = element.getAttribute('content')?.trim();
          if (content && OG_IMAGE_KEYS.includes(key) && !(key in meta)) {
            meta[key] = content;
          }
        },
      })
      .transform(
        new Response(new Uint8Array(page.body), {
          headers: { 'content-type': 'text/html' },
        }),
      )
      .arrayBuffer();

    // The shortest matching rel wins ("icon" over "apple-touch-icon").
    const icon = [...icons].sort((a, b) => a.rel.length - b.rel.length)[0];
    const ogImage = OG_IMAGE_KEYS.map((key) => meta[key]).find(Boolean);
    const base = page.finalUrl || url;

    return {
      favicon: (icon && resolve(icon.href, base)) || fallbackFavicon(url),
      ogImage: ogImage ? resolve(ogImage, base) : null,
    };
  } catch {
    return {
      favicon: fallbackFavicon(url),
      ogImage: null,
    };
  }
}
