import type { BackupBucket } from './backup';

/**
 * R2's `list` over a set of keys: the keys under `prefix`, with those
 * containing `delimiter` past the prefix rolled up into
 * `delimitedPrefixes`. Everything fits in one page.
 */
export function listKeys(
  allKeys: Iterable<string>,
  options: { prefix?: string; delimiter?: string },
) {
  const prefix = options.prefix ?? '';
  const keys = [...allKeys].filter((key) => key.startsWith(prefix)).sort();
  if (!options.delimiter) {
    return { objects: keys.map((key) => ({ key })), truncated: false as const };
  }
  const delimitedPrefixes = new Set<string>();
  const objects: { key: string }[] = [];
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    const index = rest.indexOf(options.delimiter);
    if (index >= 0) {
      delimitedPrefixes.add(prefix + rest.slice(0, index + 1));
    } else {
      objects.push({ key });
    }
  }
  return { objects, delimitedPrefixes: [...delimitedPrefixes], truncated: false as const };
}

/** An in-memory BackupBucket (tests, local dry runs). */
export class MemoryBucket implements BackupBucket {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: ArrayBuffer | Uint8Array | string) {
    const bytes =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    this.objects.set(key, bytes);
  }

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) {
      return null;
    }
    return {
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async list(options: { prefix?: string; cursor?: string; delimiter?: string }) {
    return listKeys(this.objects.keys(), options);
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }
}
