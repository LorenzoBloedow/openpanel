/**
 * Tests for validateSdkRequest — the ingestion auth check behind POST /track
 * and the deprecated POST /event.
 *
 * The behaviour guarded here: `clientSecretAuth` and revenue ingestion
 * follow whether the supplied secret verified against the stored hash, not
 * whether a secret string was present on the request.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyPassword = vi.fn();
const getClientByIdCached = vi.fn();

vi.mock('@openpanel/common/server', () => ({
  verifyPassword: (...args: unknown[]) => verifyPassword(...args),
}));
vi.mock('@openpanel/db/src/prisma-client', () => ({
  ClientType: { read: 'read', write: 'write', root: 'root' },
}));
vi.mock('@openpanel/db/src/services/clients.service', () => ({
  getClientByIdCached: (...args: unknown[]) => getClientByIdCached(...args),
}));

const { validateSdkRequest } = await import('./auth');

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://app.example.com';

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    id: CLIENT_ID,
    projectId: 'proj-1',
    secret: 'stored-hash',
    ignoreCorsAndSecret: false,
    ...overrides,
    project: {
      cors: [ORIGIN],
      allowUnsafeRevenueTracking: false,
      filters: [],
      ...((overrides.project as Record<string, unknown>) ?? {}),
    },
  };
}

function makeReq({
  headers = {},
  revenue = false,
}: {
  headers?: Record<string, string>;
  revenue?: boolean;
} = {}) {
  return {
    headers: new Headers({ 'openpanel-client-id': CLIENT_ID, ...headers }),
    clientIp: '1.2.3.4',
    body: {
      type: 'track',
      payload: {
        name: 'purchase',
        properties: revenue ? { __revenue: 42 } : {},
      },
    },
  };
}

let secretCounter = 0;
/** Every test uses a fresh secret: verified secrets are memoized per isolate. */
function uniqueSecret(label: string) {
  secretCounter += 1;
  return `${label}-${secretCounter}`;
}

beforeEach(() => {
  verifyPassword.mockReset();
  getClientByIdCached.mockReset();
  getClientByIdCached.mockResolvedValue(makeClient());
});

describe('validateSdkRequest', () => {
  it('does not mark a request authenticated when the secret does not match', async () => {
    verifyPassword.mockResolvedValue(false);
    const result = await validateSdkRequest(
      makeReq({
        headers: {
          origin: ORIGIN,
          'openpanel-client-secret': uniqueSecret('guessed'),
        },
      }),
    );
    expect(result.client).toMatchObject({ id: CLIENT_ID });
    expect(result.clientSecretAuth).toBe(false);
  });

  it('rejects revenue from an origin-authorized request with a bad secret', async () => {
    verifyPassword.mockResolvedValue(false);
    await expect(
      validateSdkRequest(
        makeReq({
          headers: {
            origin: ORIGIN,
            'openpanel-client-secret': uniqueSecret('guessed'),
          },
          revenue: true,
        }),
      ),
    ).rejects.toThrow('Revenue tracking is not allowed without a client secret');
  });

  it('rejects a bad secret outright when no origin is allowed', async () => {
    verifyPassword.mockResolvedValue(false);
    await expect(
      validateSdkRequest(
        makeReq({
          headers: { 'openpanel-client-secret': uniqueSecret('guessed') },
        }),
      ),
    ).rejects.toThrow('Invalid cors or secret');
  });

  it('lets ordinary browser traffic through on the origin alone', async () => {
    const result = await validateSdkRequest(
      makeReq({ headers: { origin: ORIGIN } }),
    );
    expect(result.client).toMatchObject({ id: CLIENT_ID });
    expect(result.clientSecretAuth).toBe(false);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('authorizes a correct secret without an origin and accepts revenue', async () => {
    verifyPassword.mockResolvedValue(true);
    const result = await validateSdkRequest(
      makeReq({
        headers: { 'openpanel-client-secret': uniqueSecret('correct') },
        revenue: true,
      }),
    );
    expect(result.client).toMatchObject({ id: CLIENT_ID });
    expect(result.clientSecretAuth).toBe(true);
  });

  it('trusts a memoized successful verification without re-hashing', async () => {
    verifyPassword.mockResolvedValue(true);
    const secret = uniqueSecret('correct');
    const req = makeReq({ headers: { 'openpanel-client-secret': secret } });

    await validateSdkRequest(req);
    const second = await validateSdkRequest(req);

    expect(second.clientSecretAuth).toBe(true);
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  it('never memoizes a failed verification', async () => {
    verifyPassword.mockResolvedValue(false);
    const req = makeReq({
      headers: {
        origin: ORIGIN,
        'openpanel-client-secret': uniqueSecret('guessed'),
      },
    });

    await validateSdkRequest(req);
    const second = await validateSdkRequest(req);

    expect(second.clientSecretAuth).toBe(false);
    expect(verifyPassword).toHaveBeenCalledTimes(2);
  });

  it('never verifies when the client has no stored secret', async () => {
    getClientByIdCached.mockResolvedValue(makeClient({ secret: null }));
    const result = await validateSdkRequest(
      makeReq({
        headers: {
          origin: ORIGIN,
          'openpanel-client-secret': uniqueSecret('anything'),
        },
      }),
    );
    expect(result.clientSecretAuth).toBe(false);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('accepts revenue with no secret when allowUnsafeRevenueTracking is on', async () => {
    getClientByIdCached.mockResolvedValue(
      makeClient({ project: { allowUnsafeRevenueTracking: true } }),
    );
    const result = await validateSdkRequest(
      makeReq({ headers: { origin: ORIGIN }, revenue: true }),
    );
    expect(result.client).toMatchObject({ id: CLIENT_ID });
    expect(result.clientSecretAuth).toBe(false);
  });

  it('rejects revenue with no secret when allowUnsafeRevenueTracking is off', async () => {
    await expect(
      validateSdkRequest(makeReq({ headers: { origin: ORIGIN }, revenue: true })),
    ).rejects.toThrow('Revenue tracking is not allowed without a client secret');
  });

  it('blocks IPs and profile ids listed in the project filters', async () => {
    getClientByIdCached.mockResolvedValue(
      makeClient({
        project: {
          filters: [
            { type: 'ip', ip: '1.2.3.4' },
            { type: 'profile_id', profileId: 'blocked' },
          ],
        },
      }),
    );
    await expect(
      validateSdkRequest(makeReq({ headers: { origin: ORIGIN } })),
    ).rejects.toThrow('IP address is blocked by project filter');
  });
});
