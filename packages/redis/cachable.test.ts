/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: test */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cacheable,
  clearGlobalLruCache,
  deleteCache,
  getCache,
  MAX_MEMO_TTL_MS,
  memoTtlMs,
} from './cachable';

function counter<T>(value: T) {
  let calls = 0;
  const fn = async (..._args: unknown[]) => {
    calls++;
    return value;
  };
  return {
    fn,
    get calls() {
      return calls;
    },
  };
}

describe('memoTtlMs', () => {
  it('caps every entry at 60 s, since other isolates cannot be cleared', () => {
    expect(MAX_MEMO_TTL_MS).toBe(60_000);
    expect(memoTtlMs(3600)).toBe(60_000);
    expect(memoTtlMs(5)).toBe(5000);
    expect(memoTtlMs(0)).toBe(1);
  });
});

describe('getCache', () => {
  beforeEach(() => {
    clearGlobalLruCache();
  });

  it('memoizes the result per key', async () => {
    const data = { id: 1, createdAt: new Date('2023-01-01T00:00:00Z') };
    const source = counter(data);

    expect(await getCache('test-key', 3600, source.fn)).toBe(data);
    expect(await getCache('test-key', 3600, source.fn)).toBe(data);
    expect(source.calls).toBe(1);
    // No JSON round trip any more: dates stay dates.
    expect((await getCache('test-key', 3600, source.fn)).createdAt).toBeInstanceOf(Date);
  });

  it('does not memoize undefined', async () => {
    const source = counter(undefined);
    await getCache('test-key-undefined', 3600, source.fn);
    await getCache('test-key-undefined', 3600, source.fn);
    expect(source.calls).toBe(2);
  });

  it('deletes entries', async () => {
    const source = counter('value');
    await getCache('test-key-delete', 3600, source.fn);
    expect(await deleteCache('test-key-delete')).toBe(1);
    expect(await deleteCache('test-key-delete')).toBe(0);
    await getCache('test-key-delete', 3600, source.fn);
    expect(source.calls).toBe(2);
  });
});

describe('cacheable', () => {
  it('memoizes per argument list', async () => {
    const source = counter({ id: 1 });
    const cachedFn = cacheable('testFunction', source.fn, 3600);

    await cachedFn('a', 'b');
    await cachedFn('a', 'b');
    expect(source.calls).toBe(1);

    await cachedFn('a', 'c');
    expect(source.calls).toBe(2);
  });

  it('accepts the (fn, ttl) overload', async () => {
    const source = counter({ id: 1 });
    const cachedFn = cacheable(source.fn, 3600);
    await cachedFn('x');
    await cachedFn('x');
    expect(source.calls).toBe(1);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['an empty array', []],
    ['an empty object', {}],
  ])('does not memoize %s', async (_label, value) => {
    const source = counter(value);
    const cachedFn = cacheable(`empty-${_label}`, source.fn, 3600);
    await cachedFn('arg');
    await cachedFn('arg');
    expect(source.calls).toBe(2);
  });

  it.each([
    ['a non-empty string', 'value'],
    ['a non-empty array', [1]],
    ['a non-empty object', { a: 1 }],
    ['false', false],
    ['zero', 0],
  ])('memoizes %s', async (_label, value) => {
    const source = counter(value);
    const cachedFn = cacheable(`value-${_label}`, source.fn, 3600);
    expect(await cachedFn('arg')).toEqual(value);
    expect(await cachedFn('arg')).toEqual(value);
    expect(source.calls).toBe(1);
  });

  it('memoizes empty arrays with cacheEmptyArray, but still not null or {}', async () => {
    const emptyArray = counter([]);
    const cachedArray = cacheable('emptyArray', emptyArray.fn, 3600, {
      cacheEmptyArray: true,
    });
    await cachedArray('arg');
    await cachedArray('arg');
    expect(emptyArray.calls).toBe(1);

    const nothing = counter(null);
    const cachedNull = cacheable('null', nothing.fn, 3600, {
      cacheEmptyArray: true,
    });
    await cachedNull('arg');
    await cachedNull('arg');
    expect(nothing.calls).toBe(2);
  });

  it('clears one entry', async () => {
    const source = counter({ id: 1 });
    const cachedFn = cacheable('clearable', source.fn, 3600);
    await cachedFn('arg');
    expect(await cachedFn.clear('arg')).toBe(1);
    expect(await cachedFn.clear('arg')).toBe(0);
    await cachedFn('arg');
    expect(source.calls).toBe(2);
  });

  it('primes entries with set()', async () => {
    const source = counter({ id: 1 });
    const cachedFn = cacheable('settable', source.fn, 3600);
    expect(await cachedFn.set('arg')({ id: 2 })).toBe('OK');
    expect(await cachedFn('arg')).toEqual({ id: 2 });
    expect(source.calls).toBe(0);
    expect(await cachedFn.set('other')({} as { id: number })).toBeUndefined();
  });

  it('requires a function and an expiry', () => {
    expect(() => cacheable('noExpiry', async () => 1, undefined as any)).toThrow(
      'expireInSec is not a number',
    );
    expect(() => cacheable('noFn', undefined as any, 60)).toThrow(
      'fn is not a function',
    );
  });

  it('builds stable keys regardless of object key order', () => {
    const fn = async (arg1: { a: number; b: number }, arg2: string) => ({});
    const cachedFn = cacheable(fn, 3600);
    expect(cachedFn.getKey({ a: 1, b: 2 }, 'test')).toBe(
      cachedFn.getKey({ b: 2, a: 1 }, 'test'),
    );
  });

  it('handles complex argument types in keys', () => {
    const fn = async (
      arg1: string,
      arg2: number,
      arg3: boolean,
      arg4: null,
      arg5: undefined,
      arg6: number[],
      arg7: { a: number; b: number },
      arg8: Date,
    ) => ({});
    const cachedFn = cacheable(fn, 3600);
    const key = cachedFn.getKey(
      'string',
      123,
      true,
      null,
      undefined,
      [1, 2, 3],
      { a: 1, b: 2 },
      new Date('2023-01-01T00:00:00Z'),
    );
    expect(key).toBe(
      'cachable:fn:[string,123,true,null,undefined,[1,2,3],a:1:b:2,2023-01-01T00:00:00.000Z]',
    );
  });
});
