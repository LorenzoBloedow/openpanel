import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { BackupBucket } from '@openpanel/db/src/backup/backup';
import { listKeys } from '@openpanel/db/src/backup/memory-bucket';
import { AwsClient } from 'aws4fetch';

/**
 * Where the backup and restore scripts find backups: a directory on disk,
 * the R2 bucket itself (over its S3 API), or the local R2 state that
 * `wrangler dev` persists for the worker.
 */

type Body = ArrayBuffer | Uint8Array | string;

function toBytes(value: Body): Uint8Array {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function objectBody(bytes: Uint8Array) {
  return {
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    text: async () => new TextDecoder().decode(bytes),
  };
}

/**
 * A directory laid out like the bucket (`<dir>/backups/<date>/…`), e.g. a
 * copy made with `rclone copy r2:openpanel-backups/backups/2026-09-24 …`.
 */
export class DirectoryBucket implements BackupBucket {
  constructor(readonly root: string) {}

  private path(key: string) {
    const path = join(this.root, ...key.split('/'));
    if (relative(this.root, path).startsWith('..')) {
      throw new Error(`Key outside the backup directory: ${key}`);
    }
    return path;
  }

  async put(key: string, value: Body) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, toBytes(value));
  }

  async get(key: string) {
    try {
      return objectBody(new Uint8Array(await readFile(this.path(key))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async list(options: { prefix?: string; cursor?: string; delimiter?: string }) {
    const keys: string[] = [];
    try {
      const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          keys.push(relative(this.root, join(entry.parentPath, entry.name)).split(sep).join('/'));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return listKeys(keys, options);
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      await rm(this.path(key), { force: true });
    }
  }
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function xmlText(value: string) {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity);
}

function xmlValues(xml: string, parent: string, tag: string): string[] {
  const values: string[] = [];
  for (const block of xml.matchAll(new RegExp(`<${parent}>([\\s\\S]*?)</${parent}>`, 'g'))) {
    const match = block[1]?.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (match?.[1] !== undefined) {
      values.push(xmlText(match[1]));
    }
  }
  return values;
}

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** 'eu' or 'fedramp' for buckets created in a jurisdiction. */
  jurisdiction?: string;
}

/** An R2 bucket over its S3-compatible API (an R2 API token's key pair). */
export class R2S3Bucket implements BackupBucket {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(credentials: R2Credentials) {
    this.client = new AwsClient({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    const host = credentials.jurisdiction
      ? `${credentials.accountId}.${credentials.jurisdiction}.r2.cloudflarestorage.com`
      : `${credentials.accountId}.r2.cloudflarestorage.com`;
    this.base = `https://${host}/${encodeURIComponent(credentials.bucket)}`;
  }

  private url(key: string) {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async request(url: string, init?: RequestInit) {
    const response = await this.client.fetch(url, init);
    if (!response.ok && response.status !== 404) {
      throw new Error(`R2 ${init?.method ?? 'GET'} ${url}: ${response.status} ${await response.text()}`);
    }
    return response;
  }

  async put(key: string, value: Body) {
    const bytes = toBytes(value);
    await this.request(this.url(key), {
      method: 'PUT',
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    });
  }

  async get(key: string) {
    const response = await this.request(this.url(key));
    if (response.status === 404) {
      return null;
    }
    return objectBody(new Uint8Array(await response.arrayBuffer()));
  }

  async list(options: { prefix?: string; cursor?: string; delimiter?: string }) {
    const params = new URLSearchParams({ 'list-type': '2' });
    if (options.prefix) {
      params.set('prefix', options.prefix);
    }
    if (options.delimiter) {
      params.set('delimiter', options.delimiter);
    }
    if (options.cursor) {
      params.set('continuation-token', options.cursor);
    }
    const response = await this.request(`${this.base}?${params}`);
    const xml = await response.text();
    const cursor = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
    return {
      objects: xmlValues(xml, 'Contents', 'Key').map((key) => ({ key })),
      delimitedPrefixes: xmlValues(xml, 'CommonPrefixes', 'Prefix'),
      truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml),
      cursor: cursor ? xmlText(cursor) : undefined,
    };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      await this.request(this.url(key), { method: 'DELETE' });
    }
  }
}

export function r2CredentialsFromEnv(env = process.env): R2Credentials {
  const accountId = env.R2_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!(accountId && accessKeyId && secretAccessKey)) {
    throw new Error(
      'Set R2_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID), R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (an R2 API token with read access to the bucket)',
    );
  }
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket: env.R2_BUCKET ?? 'openpanel-backups',
    jurisdiction: env.R2_JURISDICTION || undefined,
  };
}

/**
 * The worker's BACKUPS bucket as `wrangler dev` persists it locally (the
 * Backup workflow writes there when run with `wrangler dev`).
 */
export async function openLocalR2(workerDir: string): Promise<{
  bucket: BackupBucket;
  dispose: () => Promise<void>;
}> {
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy<{ BACKUPS: BackupBucket }>({
    configPath: join(workerDir, 'wrangler.jsonc'),
    persist: { path: join(workerDir, '.wrangler/state/v3') },
  });
  return { bucket: proxy.env.BACKUPS, dispose: proxy.dispose };
}
