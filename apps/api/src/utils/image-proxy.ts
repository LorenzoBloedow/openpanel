import { Resvg, initWasm } from '@resvg/resvg-wasm';
import { getEnv } from '@openpanel/runtime';
import { loadResvgWasm } from '#resvg-wasm';

import { logger } from '@/utils/logger';

/**
 * Image normalization for the favicon/OG proxy.
 *
 * These bytes come from a third-party server and are then served from the
 * API origin, which also serves the credentialed `/trpc` and `/oauth`
 * endpoints. Anything returned verbatim is attacker-controlled content on a
 * trusted origin, so:
 *
 * - SVG (active content) is always rasterized to PNG (resvg, WebAssembly).
 * - Raster images are resized through the Images binding when it is bound.
 *   Without it, PNG / JPEG / GIF / WebP / ICO pass through only after their
 *   magic bytes confirm the format, and are served with that type, nosniff
 *   and a sandboxing CSP — never as whatever the upstream claimed.
 * - Anything else is refused.
 */

export const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/bmp',
  'image/tiff',
]);

export function normalizeContentType(raw: string | null): string {
  return (raw ?? '').split(';')[0]!.trim().toLowerCase();
}

/** Check if URL is an ICO file */
export function isIcoFile(url: string, contentType?: string): boolean {
  return (
    url.toLowerCase().endsWith('.ico') ||
    contentType === 'image/x-icon' ||
    contentType === 'image/vnd.microsoft.icon'
  );
}

/** reserved=0, type=1: an icon, not something that merely claims to be one. */
export function hasIcoMagicBytes(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x00 &&
    buffer[1] === 0x00 &&
    buffer[2] === 0x01 &&
    buffer[3] === 0x00
  );
}

const startsWith = (buffer: Uint8Array, bytes: number[], offset = 0) =>
  buffer.length >= offset + bytes.length &&
  bytes.every((byte, index) => buffer[offset + index] === byte);

/** The raster format the bytes really are (by magic bytes), if we serve it. */
export function sniffRasterType(buffer: Uint8Array): string | null {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) {
    return 'image/gif';
  }
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
  if (hasIcoMagicBytes(buffer)) {
    return 'image/x-icon';
  }
  return null;
}

function isSvg(buffer: Uint8Array, contentType?: string): boolean {
  if (contentType === 'image/svg+xml') {
    return true;
  }
  const head = new TextDecoder()
    .decode(buffer.subarray(0, 512))
    .trimStart()
    .toLowerCase();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

let resvgReady: Promise<void> | undefined;

async function rasterizeSvg(buffer: Uint8Array, width: number): Promise<Uint8Array> {
  resvgReady ??= initWasm(loadResvgWasm()).catch((error) => {
    resvgReady = undefined;
    throw error;
  });
  await resvgReady;
  const resvg = new Resvg(new TextDecoder().decode(buffer), {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
  });
  const rendered = resvg.render();
  try {
    return rendered.asPng();
  } finally {
    rendered.free();
    resvg.free();
  }
}

/** The Workers Images binding (optional; see wrangler.jsonc). */
interface ImagesBinding {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: { format: string }): Promise<{ response(): Response }>;
    };
  };
}

async function transformWithImages(
  buffer: Uint8Array,
  transform: Record<string, unknown>,
): Promise<Uint8Array | null> {
  const images = getEnv<{ IMAGES?: ImagesBinding }>().IMAGES;
  if (!images) {
    return null;
  }
  const stream = new Response(new Uint8Array(buffer)).body!;
  const result = await images
    .input(stream)
    .transform(transform)
    .output({ format: 'image/png' });
  return new Uint8Array(await result.response().arrayBuffer());
}

export interface ProcessedImage {
  buffer: Uint8Array;
  contentType: string;
}

async function processRaster(
  buffer: Uint8Array,
  transform: Record<string, unknown>,
  originalUrl: string | undefined,
): Promise<ProcessedImage> {
  const sniffed = sniffRasterType(buffer);
  if (sniffed === 'image/x-icon') {
    // The Images binding doesn't read ICO; icons pass through as before.
    return { buffer, contentType: sniffed };
  }
  try {
    const transformed = await transformWithImages(buffer, transform);
    if (transformed) {
      return { buffer: transformed, contentType: 'image/png' };
    }
  } catch (error) {
    logger.warn(
      { err: error, originalUrl, bufferSize: buffer.length },
      'Images binding failed to process image',
    );
  }
  if (!sniffed) {
    throw new Error('Unsupported image format');
  }
  return { buffer, contentType: sniffed };
}

/** A favicon: 30 px PNG (or the verified original when it can't be resized). */
export async function processImage(
  buffer: Uint8Array,
  originalUrl?: string,
  contentType?: string,
): Promise<ProcessedImage> {
  if (isSvg(buffer, contentType)) {
    return { buffer: await rasterizeSvg(buffer, 30), contentType: 'image/png' };
  }
  return processRaster(
    buffer,
    { width: 30, height: 30, fit: 'cover' },
    originalUrl,
  );
}

/** An OG image: at most 300 px wide. */
export async function processOgImage(
  buffer: Uint8Array,
  originalUrl?: string,
): Promise<ProcessedImage> {
  if (isSvg(buffer)) {
    return { buffer: await rasterizeSvg(buffer, 300), contentType: 'image/png' };
  }
  return processRaster(buffer, { width: 300, fit: 'scale-down' }, originalUrl);
}
