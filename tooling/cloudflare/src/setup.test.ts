import { describe, expect, it } from 'vitest';

import { CloudflareApi } from './cloudflare-api';
import {
  BACKUP_BUCKET,
  QUEUE_NAMES,
  ensureBackupBucket,
  ensureHyperdrive,
  ensureQueues,
  lifecycleExpiryDays,
  originFromUrl,
  placementRegion,
} from './provision';
import { mergeSecrets } from './secrets';
import { applyConfigEdits, readConfigValue, routesEdit } from './wrangler-config';

/** An in-memory stand-in for the account endpoints setup uses. */
function fakeCloudflare() {
  const state = {
    hyperdrive: [] as { id: string; name: string; origin: unknown; caching?: unknown }[],
    queues: [] as { queue_id: string; queue_name: string }[],
    buckets: [] as { name: string }[],
    lifecycle: new Map<string, unknown>(),
  };
  const calls: string[] = [];
  const ok = (result: unknown, info?: unknown) =>
    Response.json({ success: true, result, errors: [], result_info: info });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/client/v4/accounts/acc', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${method} ${path}`);
    if (path === '/hyperdrive/configs' && method === 'GET') {
      return ok(state.hyperdrive, { page: 1, total_pages: 1 });
    }
    if (path === '/hyperdrive/configs' && method === 'POST') {
      const config = { id: `hd${state.hyperdrive.length + 1}`, ...body };
      state.hyperdrive.push(config);
      return ok(config);
    }
    if (path.startsWith('/hyperdrive/configs/') && method === 'PATCH') {
      const config = state.hyperdrive.find((item) => path.endsWith(item.id));
      Object.assign(config ?? {}, body);
      return ok(config);
    }
    if (path === '/queues' && method === 'GET') {
      return ok(state.queues, { page: 1, total_pages: 1 });
    }
    if (path === '/queues' && method === 'POST') {
      state.queues.push({ queue_id: `q${state.queues.length}`, queue_name: body.queue_name });
      return ok(state.queues.at(-1));
    }
    if (path === '/r2/buckets' && method === 'GET') {
      return ok({ buckets: state.buckets });
    }
    if (path === '/r2/buckets' && method === 'POST') {
      state.buckets.push({ name: body.name });
      return ok({});
    }
    if (path.endsWith('/lifecycle') && method === 'PUT') {
      state.lifecycle.set(path, body);
      return ok({});
    }
    return Response.json({ success: false, errors: [{ code: 7003, message: 'No route' }] }, {
      status: 404,
    });
  };
  return { api: new CloudflareApi('acc', 'token', fetchImpl as typeof fetch), state, calls };
}

const NEON_DIRECT =
  'postgresql://neondb_owner:p%40ss%2Fword@ep-cool-lab-123.us-east-2.aws.neon.tech/neondb?sslmode=require';

describe('provisioning', () => {
  it('creates what is missing and reuses what exists', async () => {
    const { api, state, calls } = fakeCloudflare();
    const log = () => undefined;
    const origin = originFromUrl(NEON_DIRECT);

    const first = await ensureHyperdrive(api, { origin }, log);
    await ensureQueues(api, {}, log);
    await ensureBackupBucket(api, { retentionDays: 30, fullEveryDays: 7 }, log);

    expect(first).toBe('hd1');
    expect(state.hyperdrive[0]).toMatchObject({ name: 'openpanel', caching: { disabled: true } });
    expect(state.queues.map((queue) => queue.queue_name)).toEqual([...QUEUE_NAMES]);
    expect(state.buckets).toEqual([{ name: BACKUP_BUCKET }]);
    expect(state.lifecycle.get(`/r2/buckets/${BACKUP_BUCKET}/lifecycle`)).toEqual({
      rules: [
        {
          id: 'openpanel-backups-expiry',
          enabled: true,
          conditions: { prefix: 'backups/' },
          deleteObjectsTransition: { condition: { type: 'Age', maxAge: 44 * 86_400 } },
          abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 86_400 } },
        },
      ],
    });

    calls.length = 0;
    const second = await ensureHyperdrive(api, { origin }, log);
    await ensureQueues(api, {}, log);
    await ensureBackupBucket(api, { retentionDays: 30, fullEveryDays: 7 }, log);
    expect(second).toBe('hd1');
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([]);
    expect(calls).toContain('PATCH /hyperdrive/configs/hd1');
    expect(state.hyperdrive).toHaveLength(1);
  });

  it('changes nothing on a dry run', async () => {
    const { api, calls } = fakeCloudflare();
    const log = () => undefined;
    await ensureHyperdrive(api, { origin: originFromUrl(NEON_DIRECT), dryRun: true }, log);
    await ensureQueues(api, { dryRun: true }, log);
    await ensureBackupBucket(api, { retentionDays: 30, fullEveryDays: 7, dryRun: true }, log);
    expect(calls.every((call) => call.startsWith('GET'))).toBe(true);
  });

  it('surfaces API errors with their messages', async () => {
    const api = new CloudflareApi('acc', 'token', (async () =>
      Response.json(
        { success: false, errors: [{ code: 10_000, message: 'Authentication error' }] },
        { status: 403 },
      )) as typeof fetch);
    await expect(ensureQueues(api, {}, () => undefined)).rejects.toThrow(
      'GET /queues?page=1&per_page=100: 403 Authentication error (10000)',
    );
  });
});

describe('originFromUrl', () => {
  it('reads Neon connection strings', () => {
    expect(originFromUrl(NEON_DIRECT)).toEqual({
      scheme: 'postgresql',
      host: 'ep-cool-lab-123.us-east-2.aws.neon.tech',
      port: 5432,
      database: 'neondb',
      user: 'neondb_owner',
      password: 'p@ss/word',
    });
  });

  it('rejects incomplete or foreign URLs', () => {
    expect(() => originFromUrl('mysql://u:p@h/db')).toThrow('postgres');
    expect(() => originFromUrl('postgresql://h/db')).toThrow('user, password');
  });
});

describe('placementRegion', () => {
  it('maps Neon regions to placement regions', () => {
    expect(placementRegion('aws-us-east-2')).toBe('aws:us-east-2');
    expect(placementRegion('aws-eu-central-1')).toBe('aws:eu-central-1');
    expect(placementRegion('azure-eastus2')).toBe('azure:eastus2');
    expect(() => placementRegion('us-east-2')).toThrow('Unrecognized Neon region');
  });

  it('keeps backups past the longest chain pruning retains', () => {
    expect(lifecycleExpiryDays(30, 7)).toBe(44);
  });
});

describe('wrangler config edits', () => {
  const config = `{
  // openpanel-api
  "name": "openpanel-api",
  "placement": { "mode": "targeted", "region": "aws:us-east-1" },
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "00000000000000000000000000000000" // filled by setup
    }
  ],
  "vars": {
    "API_URL": "http://localhost:3333"
  }
}
`;

  it('sets nested values and keeps comments', () => {
    const next = applyConfigEdits(config, [
      { path: ['hyperdrive', 0, 'id'], value: 'abc123' },
      { path: ['placement'], value: { mode: 'targeted', region: 'aws:eu-central-1' } },
      { path: ['vars', 'API_URL'], value: 'https://api.example.com' },
      { path: ['vars', 'API_CORS_ORIGINS'], value: 'https://a.example.com' },
      ...routesEdit('api.example.com'),
    ]);
    expect(next).toContain('// openpanel-api');
    expect(next).toContain('// filled by setup');
    expect(readConfigValue(next, ['hyperdrive', 0, 'id'])).toBe('abc123');
    expect(readConfigValue(next, ['placement', 'region'])).toBe('aws:eu-central-1');
    expect(readConfigValue(next, ['vars'])).toEqual({
      API_URL: 'https://api.example.com',
      API_CORS_ORIGINS: 'https://a.example.com',
    });
    expect(readConfigValue(next, ['routes'])).toEqual([
      { pattern: 'api.example.com', custom_domain: true },
    ]);
    // Idempotent: the same edits again change nothing.
    expect(
      applyConfigEdits(next, [{ path: ['hyperdrive', 0, 'id'], value: 'abc123' }]),
    ).toBe(next);
  });

  it('adds no routes without a domain', () => {
    expect(routesEdit(undefined)).toEqual([]);
  });
});

describe('mergeSecrets', () => {
  it('generates keys once, shares the encryption key and passes OAuth through', () => {
    const first = mergeSecrets(
      { api: {}, worker: {} },
      {
        pooledDatabaseUrl: 'postgresql://u:p@ep-x-pooler.neon.tech/db',
        env: { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', GITHUB_CLIENT_ID: 'hid' },
      },
    );
    expect(first.api.COOKIE_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(first.api.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(first.worker.ENCRYPTION_KEY).toBe(first.api.ENCRYPTION_KEY);
    expect(first.api).toMatchObject({ GITHUB_CLIENT_ID: 'hid', GOOGLE_CLIENT_ID: 'gid' });
    expect(first.worker).toMatchObject({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' });
    expect(first.worker.GITHUB_CLIENT_ID).toBeUndefined();

    const second = mergeSecrets(first, {
      pooledDatabaseUrl: 'postgresql://u:p@ep-y-pooler.neon.tech/db',
    });
    expect(second.api.COOKIE_SECRET).toBe(first.api.COOKIE_SECRET);
    expect(second.api.ENCRYPTION_KEY).toBe(first.api.ENCRYPTION_KEY);
    expect(second.api.DATABASE_URL).toBe('postgresql://u:p@ep-y-pooler.neon.tech/db');
    expect(second.api.GITHUB_CLIENT_ID).toBe('hid');
  });
});
