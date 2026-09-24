/**
 * Tests for buildErrorRequestContext — the request context the error handler
 * attaches to error logs.
 */

import { describe, expect, it } from 'vitest';
import { buildErrorRequestContext } from './errors';

const SECRET = 'c3VwZXItc2VjcmV0LXRva2Vu';

describe('buildErrorRequestContext', () => {
  it('does not carry the value of a sensitive query parameter in the url', () => {
    const ctx = buildErrorRequestContext({
      id: 'req-1',
      url: `/mcp?token=${SECRET}&projectId=p1`,
      method: 'POST',
      query: {},
      headers: {},
      body: undefined,
    });

    expect(ctx.url).toBe('/mcp?token=[REDACTED]&projectId=p1');
  });

  it('keeps the parsed body', () => {
    const ctx = buildErrorRequestContext({
      id: 'req-2',
      url: '/track',
      method: 'POST',
      headers: {},
      body: { type: 'track' },
    });

    expect(ctx.body).toEqual({ type: 'track' });
  });
});
