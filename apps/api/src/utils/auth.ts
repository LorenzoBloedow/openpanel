import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { verifyPassword } from '@openpanel/common/server';
// Deep imports keep the ingest path off the db barrel (query services).
import { ClientType } from '@openpanel/db/src/prisma-client';
import {
  type IServiceClientWithProject,
  getClientByIdCached,
} from '@openpanel/db/src/services/clients.service';
import { LRUCache } from '@openpanel/redis';
import type {
  IProjectFilterIp,
  IProjectFilterProfileId,
} from '@openpanel/validation';
import { path } from 'ramda';

type HeaderSource = Headers | Record<string, string | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  return headers[name];
}

const cleanDomain = (domain: string) =>
  domain
    .replace('www.', '')
    .replace(/https?:\/\//, '')
    .replace(/\/$/, '');

export class SdkAuthError extends Error {
  payload: {
    clientId?: string;
    clientSecret?: string;
    origin?: string;
  };

  constructor(
    message: string,
    payload: {
      clientId?: string;
      clientSecret?: string;
      origin?: string;
    }
  ) {
    super(message);
    this.name = 'SdkAuthError';
    this.message = message;
    this.payload = payload;
  }
}

const CLIENT_SECRET_CACHE_MS = 60 * 5 * 1000;

/**
 * Verified (client id, secret) pairs, per isolate. scrypt is deliberately
 * slow, and server-side SDKs send the secret on every request. Keyed by a
 * hash so secrets never sit in memory as cache keys, and only successes are
 * cached (a failed guess must not create entries).
 */
const verifiedSecrets = new LRUCache<string, true>({
  max: 10_000,
  ttl: CLIENT_SECRET_CACHE_MS,
});

async function verifyClientSecret(
  clientId: string,
  clientSecret: string | undefined,
  storedSecret: string | null | undefined
): Promise<boolean> {
  if (!(storedSecret && clientSecret)) {
    return false;
  }

  const cacheKey = bytesToHex(
    sha256(utf8ToBytes(`${clientId}\u0000${clientSecret}\u0000${storedSecret}`))
  );
  if (verifiedSecrets.get(cacheKey)) {
    return true;
  }

  const isVerified = await verifyPassword(clientSecret, storedSecret);
  if (isVerified) {
    verifiedSecrets.set(cacheKey, true);
  }
  return isVerified;
}

export interface SdkRequest {
  headers: HeaderSource;
  clientIp: string;
  body: unknown;
}

export interface SdkAuthResult {
  client: IServiceClientWithProject;
  /** The supplied secret matched the stored hash (server-side SDKs). */
  clientSecretAuth: boolean;
}

export async function validateSdkRequest(
  req: SdkRequest
): Promise<SdkAuthResult> {
  const { headers, clientIp } = req;
  const clientIdNew = header(headers, 'openpanel-client-id');
  const clientIdOld = header(headers, 'mixan-client-id');
  const clientSecretNew = header(headers, 'openpanel-client-secret');
  const clientSecretOld = header(headers, 'mixan-client-secret');
  const clientIdFromBody = path<string | undefined>(['clientId'], req.body);
  const clientSecretFromBody = path<string | undefined>(
    ['clientSecret'],
    req.body
  );
  const clientId = clientIdNew || clientIdOld || clientIdFromBody;
  const clientSecret =
    clientSecretNew || clientSecretOld || clientSecretFromBody;
  const origin = header(headers, 'origin');

  const createError = (message: string) =>
    new SdkAuthError(message, {
      clientId,
      clientSecret:
        typeof clientSecret === 'string'
          ? `${clientSecret.slice(0, 5)}...${clientSecret.slice(-5)}`
          : 'none',
      origin,
    });

  if (!clientId) {
    throw createError('Ingestion: Missing client id');
  }

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      clientId
    )
  ) {
    throw createError('Ingestion: Client ID must be a valid UUIDv4');
  }

  const client = await getClientByIdCached(clientId);

  if (!client) {
    throw createError('Ingestion: Invalid client id');
  }

  if (!client.project) {
    throw createError('Ingestion: Client has no project');
  }

  // Whether the supplied secret actually matches the stored hash. Everything
  // downstream keys off this, not off the mere presence of a secret.
  const secretVerified = await verifyClientSecret(
    clientId,
    clientSecret,
    client.secret
  );

  const result = { client, clientSecretAuth: secretVerified };

  // Filter out blocked IPs
  const ipFilter = client.project.filters.filter(
    (filter): filter is IProjectFilterIp => filter.type === 'ip'
  );
  if (ipFilter.some((filter) => filter.ip === clientIp)) {
    throw createError('Ingestion: IP address is blocked by project filter');
  }

  // Filter out blocked profile ids
  const profileFilter = client.project.filters.filter(
    (filter): filter is IProjectFilterProfileId => filter.type === 'profile_id'
  );
  const profileId =
    path<string | undefined>(['payload', 'profileId'], req.body) || // Track handler
    path<string | undefined>(['profileId'], req.body); // Event handler

  if (profileFilter.some((filter) => filter.profileId === profileId)) {
    throw createError('Ingestion: Profile id is blocked by project filter');
  }

  const revenue =
    path(['payload', 'properties', '__revenue'], req.body) ??
    path(['properties', '__revenue'], req.body);

  // Only allow revenue tracking if it was sent with a verified client secret
  // or if the project has allowUnsafeRevenueTracking enabled
  if (
    !(client.project.allowUnsafeRevenueTracking || secretVerified) &&
    typeof revenue !== 'undefined'
  ) {
    throw createError(
      'Ingestion: Revenue tracking is not allowed without a client secret'
    );
  }

  if (client.ignoreCorsAndSecret) {
    return result;
  }

  if (client.project.cors) {
    const domainAllowed = client.project.cors.find((domain) => {
      const cleanedDomain = cleanDomain(domain);
      // support wildcard domains `*.foo.com`
      if (cleanedDomain.includes('*')) {
        const regex = new RegExp(
          `${cleanedDomain.replaceAll('.', '\\.').replaceAll('*', '.+?')}`
        );

        return regex.test(origin || '');
      }

      return cleanedDomain === cleanDomain(origin || '');
    });

    if (domainAllowed) {
      return result;
    }

    if (client.project.cors.includes('*') && origin) {
      return result;
    }
  }

  if (secretVerified) {
    return result;
  }

  throw createError('Ingestion: Invalid cors or secret');
}

export async function validateExportRequest(
  headers: HeaderSource
): Promise<IServiceClientWithProject> {
  const clientId = header(headers, 'openpanel-client-id') ?? '';
  const clientSecret = header(headers, 'openpanel-client-secret') || '';

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      clientId
    )
  ) {
    throw new Error('Export: Client ID must be a valid UUIDv4');
  }

  const client = await getClientByIdCached(clientId);

  if (!client) {
    throw new Error('Export: Invalid client id');
  }

  if (!client.secret) {
    throw new Error('Export: Client has no secret');
  }

  if (client.type === ClientType.write) {
    throw new Error('Export: Client is not allowed to export');
  }

  if (!(await verifyClientSecret(clientId, clientSecret, client.secret))) {
    throw new Error('Export: Invalid client secret');
  }

  return client;
}

export async function validateImportRequest(
  headers: HeaderSource
): Promise<IServiceClientWithProject> {
  const clientId = header(headers, 'openpanel-client-id') ?? '';
  const clientSecret = header(headers, 'openpanel-client-secret') || '';

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      clientId
    )
  ) {
    throw new Error('Import: Client ID must be a valid UUIDv4');
  }

  const client = await getClientByIdCached(clientId);

  if (!client) {
    throw new Error('Import: Invalid client id');
  }

  if (!client.secret) {
    throw new Error('Import: Client has no secret');
  }

  if (client.type === ClientType.write) {
    throw new Error('Import: Client is not allowed to import');
  }

  if (!(await verifyClientSecret(clientId, clientSecret, client.secret))) {
    throw new Error('Import: Invalid client secret');
  }

  return client;
}

export async function validateManageRequest(
  headers: HeaderSource
): Promise<IServiceClientWithProject> {
  const clientId = header(headers, 'openpanel-client-id') ?? '';
  const clientSecret = header(headers, 'openpanel-client-secret') || '';

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      clientId
    )
  ) {
    throw new Error('Manage: Client ID must be a valid UUIDv4');
  }

  const client = await getClientByIdCached(clientId);

  if (!client) {
    throw new Error('Manage: Invalid client id');
  }

  if (!client.secret) {
    throw new Error('Manage: Client has no secret');
  }

  if (client.type !== ClientType.root) {
    throw new Error(
      'Manage: Only root clients are allowed to manage resources'
    );
  }

  if (!(await verifyClientSecret(clientId, clientSecret, client.secret))) {
    throw new Error('Manage: Invalid client secret');
  }

  return client;
}
