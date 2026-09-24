const JSON_EXTENSION = '.json';

/**
 * Turns an eager `import.meta.glob` over `content/<dir>/*.json` into a map
 * keyed by slug (the file name), adding the URL each entry is rendered at.
 *
 * The site runs on Cloudflare Workers, where there is no filesystem to read
 * `content/` from at request time, so these files are bundled at build time
 * instead. Keys keep the glob's (alphabetical) file order.
 */
export function collectBySlug<T>(
  files: Record<string, T>,
  urlPrefix: string,
): Map<string, T & { url: string }> {
  const collection = new Map<string, T & { url: string }>();
  for (const [file, data] of Object.entries(files)) {
    const slug = file.slice(
      file.lastIndexOf('/') + 1,
      -JSON_EXTENSION.length,
    );
    collection.set(slug, { ...data, url: `${urlPrefix}/${slug}` });
  }
  return collection;
}
