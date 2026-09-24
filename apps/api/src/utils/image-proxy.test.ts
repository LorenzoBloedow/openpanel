import { runWithScope } from '@openpanel/runtime';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ALLOWED_IMAGE_CONTENT_TYPES,
  hasIcoMagicBytes,
  normalizeContentType,
  processImage,
  processOgImage,
  sniffRasterType,
} from './image-proxy';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

const maliciousSvg = encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
    '<rect width="64" height="64" fill="red"/>' +
    '<script>alert(document.domain)</script>' +
    '</svg>',
);

let png: Uint8Array;

beforeAll(async () => {
  // A real PNG for the raster paths, rendered by the proxy's own resvg.
  const square = encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="blue"/></svg>',
  );
  png = (await processOgImage(square)).buffer;
});

/** A stand-in for the Images binding that records what it was asked to do. */
function imagesBinding(output: Uint8Array) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    input: (_stream: ReadableStream) => ({
      transform: (options: Record<string, unknown>) => {
        calls.push(options);
        return {
          output: async ({ format }: { format: string }) => ({
            response: () =>
              new Response(new Uint8Array(output), { headers: { 'content-type': format } }),
          }),
        };
      },
    }),
  };
}

const withImages = <T>(images: unknown, fn: () => Promise<T>) =>
  runWithScope({ env: { IMAGES: images }, route: 'hyperdrive' }, fn);

describe('processImage', () => {
  it('rasterizes SVG instead of serving it verbatim (GHSA-r7hx-q6f4-vj6h)', async () => {
    const result = await processImage(maliciousSvg, 'https://evil.example/x.svg', 'image/svg+xml');

    expect(result.contentType).toBe('image/png');
    expect([...result.buffer.subarray(0, 4)]).toEqual(PNG_MAGIC);
    expect(decode(result.buffer)).not.toContain('script');
    expect(decode(result.buffer)).not.toContain('alert');
  });

  it('rasterizes SVG even when only the content type gives it away', async () => {
    const result = await processImage(maliciousSvg, 'https://evil.example/favicon', 'image/svg+xml');
    expect([...result.buffer.subarray(0, 4)]).toEqual(PNG_MAGIC);
  });

  it('rasterizes SVG sent under another content type', async () => {
    const result = await processImage(maliciousSvg, 'https://evil.example/x.png', 'image/png');
    expect(result.contentType).toBe('image/png');
    expect(decode(result.buffer)).not.toContain('alert');
  });

  it('resizes rasters through the Images binding when it is bound', async () => {
    const images = imagesBinding(png);
    const result = await withImages(images, () =>
      processImage(png, 'https://example.com/icon.png', 'image/png'),
    );
    expect(result).toEqual({ buffer: png, contentType: 'image/png' });
    expect(images.calls).toEqual([{ width: 30, height: 30, fit: 'cover' }]);
  });

  it('without the binding, serves a verified raster as the type its bytes are', async () => {
    // Claimed to be a GIF; the bytes say PNG, and PNG is what it's served as.
    const result = await processImage(png, 'https://example.com/icon.gif', 'image/gif');
    expect(result).toEqual({ buffer: png, contentType: 'image/png' });
  });

  it('rejects a non-image body claiming to be an icon', async () => {
    const html = encode('<html><script>alert(1)</script></html>');
    expect(hasIcoMagicBytes(html)).toBe(false);
    await expect(
      processImage(html, 'https://evil.example/x.ico', 'image/x-icon'),
    ).rejects.toThrow('Unsupported image format');
  });

  it('passes a real ICO through untouched, even with the binding bound', async () => {
    // Minimal ICO header: reserved=0, type=1, count=1
    const ico = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, ...new Array(32).fill(0)]);
    const images = imagesBinding(png);
    const result = await withImages(images, () =>
      processImage(ico, 'https://example.com/favicon.ico', 'image/x-icon'),
    );
    expect(result).toEqual({ buffer: ico, contentType: 'image/x-icon' });
    expect(images.calls).toEqual([]);
  });
});

describe('processOgImage', () => {
  it('rasterizes SVG instead of serving it verbatim', async () => {
    const result = await processOgImage(maliciousSvg, 'https://evil.example/x.svg');
    expect(result.contentType).toBe('image/png');
    expect(decode(result.buffer)).not.toContain('alert');
  });

  it('scales rasters down to 300 px through the binding', async () => {
    const images = imagesBinding(png);
    await withImages(images, () => processOgImage(png, 'https://example.com/og.png'));
    expect(images.calls).toEqual([{ width: 300, fit: 'scale-down' }]);
  });
});

describe('content type handling', () => {
  it('strips parameters and lowercases', () => {
    expect(normalizeContentType('Image/SVG+XML; charset=utf-8')).toBe('image/svg+xml');
    expect(normalizeContentType(null)).toBe('');
  });

  it('does not allow non-image types through the proxy', () => {
    for (const type of ['text/html', 'application/json', 'text/plain', 'application/octet-stream', '']) {
      expect(ALLOWED_IMAGE_CONTENT_TYPES.has(type), type).toBe(false);
    }
  });

  it('sniffs the raster formats it serves', () => {
    expect(sniffRasterType(png)).toBe('image/png');
    expect(sniffRasterType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffRasterType(encode('GIF89a'))).toBe('image/gif');
    expect(sniffRasterType(encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffRasterType(encode('<html>'))).toBeNull();
  });
});
