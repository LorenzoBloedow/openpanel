/**
 * Per-isolate memoization — the Redis-free replacement for the old
 * L1 (LRU) + L2 (Redis) cache.
 *
 * OpenPanel on Cloudflare has no shared cache: every Worker isolate keeps its
 * own small LRU. The old design already served entries from a per-process L1
 * for up to 60 s after a `.clear()` elsewhere, so capping every TTL at 60 s
 * keeps the same worst-case staleness while the API stays identical for the
 * call sites (`cacheable(fn, ttl)`, `.clear()`, `.set()`, `getCache(...)`).
 */
import { LRUCache } from 'lru-cache';

export { LRUCache } from 'lru-cache';

/** Upper bound for every entry: other isolates cannot be invalidated. */
export const MAX_MEMO_TTL_MS = 60 * 1000;

const MEMO_MAX_ENTRIES = 1000;

/** A memo entry lives for `expireInSec`, capped at {@link MAX_MEMO_TTL_MS}. */
export function memoTtlMs(expireInSec: number) {
  return Math.max(1, Math.min(expireInSec * 1000, MAX_MEMO_TTL_MS));
}

// Global LRU cache for getCache()
const globalLruCache = new LRUCache<string, any>({
  max: 5000,
  ttl: MAX_MEMO_TTL_MS,
});

export const deleteCache = async (key: string) => {
  return globalLruCache.delete(key) ? 1 : 0;
};

export async function getCache<T>(
  key: string,
  expireInSec: number,
  fn: () => Promise<T>,
  // Kept for signature compatibility; every entry is in-memory now.
  _useLruCache?: boolean,
): Promise<T> {
  const hit = globalLruCache.get(key);
  if (hit !== undefined) {
    return hit as T;
  }

  const data = await fn();
  if (data !== undefined) {
    globalLruCache.set(key, data, { ttl: memoTtlMs(expireInSec) });
  }
  return data;
}

export function clearGlobalLruCache(key?: string) {
  if (key) {
    return globalLruCache.delete(key);
  }
  globalLruCache.clear();
  return true;
}

export function getGlobalLruCacheStats() {
  return {
    size: globalLruCache.size,
    max: globalLruCache.max,
    calculatedSize: globalLruCache.calculatedSize,
  };
}

function stringify(obj: unknown): string {
  if (obj === null) {
    return 'null';
  }
  if (obj === undefined) {
    return 'undefined';
  }
  if (typeof obj === 'boolean') {
    return obj ? 'true' : 'false';
  }
  if (typeof obj === 'number') {
    return String(obj);
  }
  if (typeof obj === 'string') {
    return obj;
  }
  if (typeof obj === 'function') {
    return obj.toString();
  }

  if (Array.isArray(obj)) {
    return `[${obj.map(stringify).join(',')}]`;
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  if (typeof obj === 'object') {
    const pairs = Object.entries(obj)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}:${stringify(value)}`);
    return pairs.join(':');
  }

  // Fallback for any other types
  return String(obj);
}

export interface CacheableOptions {
  cacheEmptyArray?: boolean;
}

function shouldCache(result: unknown, options: CacheableOptions = {}): boolean {
  // Don't cache undefined or null
  if (result === undefined || result === null) {
    return false;
  }

  // Don't cache empty strings
  if (typeof result === 'string') {
    return result.length > 0;
  }

  if (Array.isArray(result)) {
    return options.cacheEmptyArray ? true : result.length > 0;
  }

  // Don't cache empty objects
  if (typeof result === 'object' && result !== null) {
    return Object.keys(result).length > 0;
  }

  // Cache everything else (booleans, numbers, etc.)
  return true;
}

type CachedFn<T extends (...args: any) => any> = T & {
  getKey: (...args: Parameters<T>) => string;
  clear: (...args: Parameters<T>) => Promise<number>;
  set: (
    ...args: Parameters<T>
  ) => (payload: Awaited<ReturnType<T>>) => Promise<'OK' | undefined>;
};

// Overload 1: cacheable(fn, expireInSec, options?)
export function cacheable<T extends (...args: any) => any>(
  fn: T,
  expireInSec: number,
  options?: CacheableOptions,
): CachedFn<T>;

// Overload 2: cacheable(name, fn, expireInSec, options?)
export function cacheable<T extends (...args: any) => any>(
  name: string,
  fn: T,
  expireInSec: number,
  options?: CacheableOptions,
): CachedFn<T>;

export function cacheable<T extends (...args: any) => any>(
  fnOrName: T | string,
  fnOrExpireInSec: number | T,
  expireInSecOrOptions?: number | CacheableOptions,
  maybeOptions?: CacheableOptions,
) {
  const name = typeof fnOrName === 'string' ? fnOrName : fnOrName.name;
  const fn =
    typeof fnOrName === 'function'
      ? fnOrName
      : typeof fnOrExpireInSec === 'function'
        ? fnOrExpireInSec
        : null;

  let expireInSec: number | null = null;
  let options: CacheableOptions = {};

  if (typeof fnOrName === 'function') {
    // Overload 1: cacheable(fn, expireInSec, options?)
    expireInSec = typeof fnOrExpireInSec === 'number' ? fnOrExpireInSec : null;
    if (expireInSecOrOptions && typeof expireInSecOrOptions === 'object') {
      options = expireInSecOrOptions;
    }
  } else {
    // Overload 2: cacheable(name, fn, expireInSec, options?)
    expireInSec =
      typeof expireInSecOrOptions === 'number' ? expireInSecOrOptions : null;
    if (maybeOptions) {
      options = maybeOptions;
    }
  }

  if (typeof fn !== 'function') {
    throw new Error('fn is not a function');
  }

  if (typeof expireInSec !== 'number') {
    throw new Error('expireInSec is not a number');
  }

  const cachePrefix = `cachable:${name}`;
  const getKey = (...args: Parameters<T>) =>
    `${cachePrefix}:${stringify(args)}`.replaceAll(/\s/g, '');

  const memo = new LRUCache<string, any>({
    max: MEMO_MAX_ENTRIES,
    ttl: memoTtlMs(expireInSec),
  });

  const cachedFn = async (
    ...args: Parameters<T>
  ): Promise<Awaited<ReturnType<T>>> => {
    const key = getKey(...args);

    const hit = memo.get(key);
    if (hit !== undefined && shouldCache(hit, options)) {
      return hit as Awaited<ReturnType<T>>;
    }

    const result = await fn(...(args as any));

    if (shouldCache(result, options)) {
      memo.set(key, result);
    }

    return result;
  };

  cachedFn.getKey = getKey;
  cachedFn.clear = async (...args: Parameters<T>) => {
    return memo.delete(getKey(...args)) ? 1 : 0;
  };
  cachedFn.set =
    (...args: Parameters<T>) =>
    async (payload: Awaited<ReturnType<T>>) => {
      if (!shouldCache(payload, options)) {
        return undefined;
      }
      memo.set(getKey(...args), payload);
      return 'OK' as const;
    };

  return cachedFn;
}
