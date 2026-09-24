import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, redactSensitive, sanitizeUrlQuery } from './index';

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes one structured record with child bindings and a message', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger({ name: 'api' }).child({ requestId: 'r1' });
    logger.info({ projectId: 'p1' }, 'hello %s', 'world');
    expect(log).toHaveBeenCalledTimes(1);
    const record = log.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record).toMatchObject({
      level: 'info',
      requestId: 'r1',
      projectId: 'p1',
      msg: 'hello world',
    });
    expect(String(record.name)).toContain('api');
  });

  it('serializes errors under err and redacts sensitive fields', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger({ name: 'worker' });
    logger.error({ err: new Error('boom'), token: 'secret' }, 'failed');
    const record = error.mock.calls[0]?.[0] as Record<string, any>;
    expect(record.err.message).toBe('boom');
    expect(record.token).toBe('[REDACTED]');
    expect(record.msg).toBe('failed');
  });

  it('accepts an Error as the first argument like pino', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger({ name: 'worker' }).error(new Error('bare'));
    const record = error.mock.calls[0]?.[0] as Record<string, any>;
    expect(record.err.message).toBe('bare');
    expect(record.msg).toBe('bare');
  });

  it('drops records below the configured level', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    createLogger({ name: 'x' }).debug('hidden');
    expect(debug).not.toHaveBeenCalled();
  });
});

describe('sanitizeUrlQuery', () => {
  it('replaces sensitive parameter values and keeps the rest', () => {
    expect(sanitizeUrlQuery('/x?token=abc&foo=1')).toBe(
      '/x?token=[REDACTED]&foo=1'
    );
  });

  it('returns URLs without a query string unchanged', () => {
    expect(sanitizeUrlQuery('/x')).toBe('/x');
    expect(sanitizeUrlQuery('/x?')).toBe('/x?');
  });
});

describe('redactSensitive', () => {
  it('filters the query of a string url value', () => {
    expect(redactSensitive({ url: '/x?token=abc&foo=1' })).toEqual({
      url: '/x?token=[REDACTED]&foo=1',
    });
  });

  it('covers keys that merely contain url', () => {
    expect(redactSensitive({ requestUrl: '/x?apikey=abc' })).toEqual({
      requestUrl: '/x?apikey=[REDACTED]',
    });
  });

  it('leaves a non-string url value to the existing recursion', () => {
    expect(redactSensitive({ url: { path: '/x', token: 'abc' } })).toEqual({
      url: { path: '/x', token: '[REDACTED]' },
    });
  });

  it('still redacts sensitive keys by name', () => {
    expect(redactSensitive({ authorization: 'Bearer abc', page: 2 })).toEqual({
      authorization: '[REDACTED]',
      page: 2,
    });
  });
});
