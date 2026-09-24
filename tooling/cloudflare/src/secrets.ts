import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The Workers' secrets, kept in gitignored JSON files that `pnpm cf:deploy`
 * uploads with `wrangler deploy --secrets-file`. Keys that already exist
 * are never regenerated: a new ENCRYPTION_KEY would make every stored
 * token unreadable, a new COOKIE_SECRET would sign everyone out.
 */

export type SecretsFile = Record<string, string>;

export type SecretsApp = 'api' | 'worker';

export function secretsPath(root: string, app: SecretsApp) {
  return join(root, '.secrets', `${app}.json`);
}

export async function readSecrets(file: string): Promise<SecretsFile> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as SecretsFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export async function writeSecrets(file: string, secrets: SecretsFile) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
}

const randomHex = (bytes: number) => randomBytes(bytes).toString('hex');

/** Optional secrets passed through from the environment when set. */
const OPTIONAL_API_SECRETS = [
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_REDIRECT_URI',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'GSC_GOOGLE_REDIRECT_URI',
  'DEMO_USER_ID',
] as const;

const WORKER_GOOGLE_SECRETS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;

/**
 * Merge the api's and worker's secrets: the database URL (Neon's pooled
 * endpoint) is replaced, generated keys are kept when present, and the
 * worker shares the api's ENCRYPTION_KEY (it decrypts the Search Console
 * tokens the api stores).
 */
export function mergeSecrets(
  current: Record<SecretsApp, SecretsFile>,
  input: { pooledDatabaseUrl: string; env?: Record<string, string | undefined> },
): Record<SecretsApp, SecretsFile> {
  const env = input.env ?? {};
  const encryptionKey =
    current.api.ENCRYPTION_KEY ?? current.worker.ENCRYPTION_KEY ?? randomHex(32);
  const api: SecretsFile = {
    ...current.api,
    DATABASE_URL: input.pooledDatabaseUrl,
    COOKIE_SECRET: current.api.COOKIE_SECRET ?? randomHex(32),
    ENCRYPTION_KEY: encryptionKey,
  };
  for (const key of OPTIONAL_API_SECRETS) {
    const value = env[key];
    if (value) {
      api[key] = value;
    }
  }
  const worker: SecretsFile = {
    ...current.worker,
    DATABASE_URL: input.pooledDatabaseUrl,
    ENCRYPTION_KEY: encryptionKey,
  };
  // The Search Console sync (in the worker) refreshes Google access tokens.
  for (const key of WORKER_GOOGLE_SECRETS) {
    const value = env[key];
    if (value) {
      worker[key] = value;
    }
  }
  return { api, worker };
}
