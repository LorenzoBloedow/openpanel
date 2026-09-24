import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DirectoryBucket, R2S3Bucket } from './buckets';

describe('DirectoryBucket', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stores, lists and deletes keys like a bucket', async () => {
    root = await mkdtemp(join(tmpdir(), 'op-backup-'));
    const bucket = new DirectoryBucket(root);
    await bucket.put('backups/2026-09-20/manifest.json', '{}');
    await bucket.put('backups/2026-09-20/public.projects/000000.jsonl.gz', new Uint8Array([1, 2]));
    await bucket.put('backups/2026-09-21/public.projects/000000.jsonl.gz', new Uint8Array([3]));

    expect(await (await bucket.get('backups/2026-09-20/manifest.json'))?.text()).toBe('{}');
    expect(await bucket.get('backups/2026-09-22/manifest.json')).toBeNull();

    const dates = await bucket.list({ prefix: 'backups/', delimiter: '/' });
    expect(dates.delimitedPrefixes).toEqual(['backups/2026-09-20/', 'backups/2026-09-21/']);
    const parts = await bucket.list({ prefix: 'backups/2026-09-20/' });
    expect(parts.objects.map((object) => object.key)).toEqual([
      'backups/2026-09-20/manifest.json',
      'backups/2026-09-20/public.projects/000000.jsonl.gz',
    ]);

    await bucket.delete(parts.objects.map((object) => object.key));
    expect((await bucket.list({ prefix: 'backups/2026-09-20/' })).objects).toEqual([]);
  });

  it('refuses keys that leave the directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'op-backup-'));
    await expect(new DirectoryBucket(root).put('../escape', 'x')).rejects.toThrow(
      'outside the backup directory',
    );
  });
});

describe('R2S3Bucket', () => {
  const credentials = {
    accountId: 'acc123',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    bucket: 'openpanel-backups',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: () => Response) {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return response();
      }),
    );
    return requests;
  }

  it('lists with ListObjectsV2 and signs the request', async () => {
    const requests = stubFetch(
      () =>
        new Response(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>openpanel-backups</Name>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token&amp;2</NextContinuationToken>
  <Contents><Key>backups/a&amp;b.json</Key><Size>2</Size></Contents>
  <CommonPrefixes><Prefix>backups/2026-09-20/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>backups/2026-09-21/</Prefix></CommonPrefixes>
</ListBucketResult>`),
    );
    const page = await new R2S3Bucket(credentials).list({
      prefix: 'backups/',
      delimiter: '/',
      cursor: 'token1',
    });
    expect(page).toEqual({
      objects: [{ key: 'backups/a&b.json' }],
      delimitedPrefixes: ['backups/2026-09-20/', 'backups/2026-09-21/'],
      truncated: true,
      cursor: 'token&2',
    });

    const url = new URL(requests[0]!.url);
    expect(url.host).toBe('acc123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/openpanel-backups');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'list-type': '2',
      prefix: 'backups/',
      delimiter: '/',
      'continuation-token': 'token1',
    });
    expect(requests[0]!.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/,
    );
  });

  it('returns null for a missing object and addresses jurisdictions', async () => {
    const requests = stubFetch(() => new Response('NoSuchKey', { status: 404 }));
    const bucket = new R2S3Bucket({ ...credentials, jurisdiction: 'eu' });
    expect(await bucket.get('backups/2026-09-20/manifest.json')).toBeNull();
    expect(requests[0]!.url).toBe(
      'https://acc123.eu.r2.cloudflarestorage.com/openpanel-backups/backups/2026-09-20/manifest.json',
    );
  });

  it('surfaces other errors', async () => {
    stubFetch(() => new Response('AccessDenied', { status: 403 }));
    await expect(new R2S3Bucket(credentials).get('x')).rejects.toThrow('403 AccessDenied');
  });
});
