import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpAuthContext } from './auth';

vi.mock('@openpanel/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionManager } from './session-manager';

const CTX: McpAuthContext = {
  projectId: 'proj-1',
  organizationId: 'org-1',
  clientType: 'read',
};

const TTL_MS = 30 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionManager', () => {
  it('generates unique UUIDs', () => {
    const sm = new SessionManager();
    const a = sm.generateId();
    const b = sm.generateId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores and returns a context', async () => {
    const sm = new SessionManager();
    await sm.setContext('sess-1', CTX);
    expect(await sm.getContext('sess-1')).toEqual(CTX);
    expect(await sm.getContext('missing')).toBeNull();
  });

  it('expires a context after 30 idle minutes', async () => {
    const sm = new SessionManager();
    await sm.setContext('sess-1', CTX);
    vi.advanceTimersByTime(TTL_MS - 1);
    expect(await sm.getContext('sess-1')).toEqual(CTX);
    vi.advanceTimersByTime(1);
    expect(await sm.getContext('sess-1')).toBeNull();
  });

  it('extends the TTL on touch', async () => {
    const sm = new SessionManager();
    await sm.setContext('sess-1', CTX);
    vi.advanceTimersByTime(TTL_MS - 1000);
    await sm.touchContext('sess-1');
    vi.advanceTimersByTime(TTL_MS - 1000);
    expect(await sm.getContext('sess-1')).toEqual(CTX);
  });

  it('deletes on close and on destroy', async () => {
    const sm = new SessionManager();
    await sm.setContext('sess-1', CTX);
    await sm.setContext('sess-2', CTX);
    await sm.close('sess-1');
    expect(await sm.getContext('sess-1')).toBeNull();
    await sm.destroy();
    expect(await sm.getContext('sess-2')).toBeNull();
  });
});
