import { encryptCredential } from '@openpanel/common/server';
import { type IIntegrationConfig, looksEncrypted } from '@openpanel/validation';

/** Narrow the integration config union to one `type`. */
export type ConfigOf<T extends IIntegrationConfig['type']> = Extract<
  IIntegrationConfig,
  { type: T }
>;

/**
 * `keyof` over a union yields only the shared keys, which would drop
 * `secretAccessKey` (it lives on just one arm of the S3 auth-mode union).
 * Distributing keeps every arm's keys while still catching a typo.
 */
type AllConfigKeys<T> = T extends unknown ? keyof T : never;

/** A top-level key, or a dotted path whose first segment is a real key. */
type SecretPath<C> =
  | Extract<AllConfigKeys<C>, string>
  | `${Extract<AllConfigKeys<C>, string>}.${string}`;

export interface IConfigSecret<C> {
  path: SecretPath<C>;
  /**
   * Also encrypt at rest, and treat the value as a required credential:
   * rejected if it arrives already encrypted (a replay), and rejected if it is
   * still blank after carry-over.
   *
   * Only for values whose readers decrypt at use. The object-store adapters
   * do; the notification senders read `config.url` / `config.headers` /
   * `incoming_webhook.url` raw, so those are redact-only until they decrypt
   * too (which needs a backfill of the existing plaintext rows).
   */
  encrypted?: boolean;
  /**
   * The value is a Record<string, string> whose VALUES are secret — webhook
   * auth headers. Keys stay visible so the form can still show which headers
   * are set, and carry-over is per key.
   */
  record?: boolean;
}

/**
 * Config values that must never travel back to a client, per integration
 * type. ONE declaration drives everything we do with a secret — redact on
 * read, carry the stored value over when an update submits a blank, encrypt
 * at rest, reject a replayed ciphertext — so they can never drift apart as
 * integrations are added. Each server plugin exposes its entry as
 * `secretFields`.
 */
export const INTEGRATION_SECRET_FIELDS = {
  // The bot token and the incoming-webhook URL are both bearer credentials for
  // the customer's Slack workspace. Redact-only: the worker reads them raw, and
  // nothing round-trips them (the OAuth callback rewrites the whole config), so
  // there is no carry-over to worry about.
  slack: [{ path: 'access_token' }, { path: 'incoming_webhook.url' }],
  discord: [],
  // Header VALUES routinely carry an Authorization bearer. Keys stay visible so
  // the form still shows which headers are configured; blank values carry over
  // per key on update. Redact-only — postWebhook sends them raw.
  webhook: [{ path: 'headers', record: true }],
  app: [],
  email: [],
  // Absent in iam_role configs; the generic helpers skip keys that aren't there.
  s3_export: [{ path: 'secretAccessKey', encrypted: true }],
  gcs_export: [{ path: 'serviceAccountKey', encrypted: true }],
} as const satisfies {
  [T in IIntegrationConfig['type']]: readonly IConfigSecret<ConfigOf<T>>[];
};

// ---------------------------------------------------------------------------
// Generic secret handling, driven by each plugin's `secretFields`.
//
// Credentials are WRITE-ONLY: blanked before a config is returned to a client,
// and restored from the stored row when an update submits a blank. Returning a
// stored credential would hand a project *reader* the org's secrets — `read` is
// bare project membership. For the encrypted ones it is worse than disclosure:
// decryptCredential accepts any `enc:` value under the single global key, so a
// returned ciphertext is a portable bearer token, not an opaque handle.
// ---------------------------------------------------------------------------

type LooseConfig = Record<string, unknown>;

/** Lenient like `isKind`: an empty/unknown config simply has no secrets. */
function secretsFor(config: unknown): readonly IConfigSecret<never>[] {
  const type = (config as { type?: string } | null)?.type;
  if (!type || !Object.hasOwn(INTEGRATION_SECRET_FIELDS, type)) {
    return [];
  }
  return INTEGRATION_SECRET_FIELDS[
    type as IIntegrationConfig['type']
  ] as readonly IConfigSecret<never>[];
}

function readPath(config: unknown, path: string): unknown {
  let cursor: unknown = config;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) {
      return undefined;
    }
    cursor = (cursor as LooseConfig)[segment];
  }
  return cursor;
}

/** Immutably set `path`, cloning only the objects along the way. */
function writePath<C>(config: C, path: string, value: unknown): C {
  const [head, ...rest] = path.split('.');
  if (head === undefined) {
    return config;
  }
  const source = config as LooseConfig;
  if (rest.length === 0) {
    return { ...source, [head]: value } as C;
  }
  const child = source[head];
  if (typeof child !== 'object' || child === null) {
    return config;
  }
  return {
    ...source,
    [head]: writePath(child, rest.join('.'), value),
  } as C;
}

/**
 * Apply `map` to every declared secret. `map` returns the replacement, or
 * undefined to leave the value alone. Returns the original object by identity
 * when nothing changed, so callers can cheaply skip a copy.
 */
function mapSecrets<C>(
  config: C,
  map: (
    value: string,
    secret: IConfigSecret<never>,
    recordKey?: string,
  ) => string | undefined,
): C {
  let next = config;

  for (const secret of secretsFor(config)) {
    const current = readPath(next, secret.path);

    if (secret.record) {
      if (typeof current !== 'object' || current === null) {
        continue;
      }
      let replacement: Record<string, unknown> | undefined;
      for (const [key, value] of Object.entries(current as LooseConfig)) {
        if (typeof value !== 'string') {
          continue;
        }
        const mapped = map(value, secret, key);
        if (mapped === undefined || mapped === value) {
          continue;
        }
        replacement ??= { ...(current as LooseConfig) };
        replacement[key] = mapped;
      }
      if (replacement) {
        next = writePath(next, secret.path, replacement);
      }
      continue;
    }

    if (typeof current !== 'string') {
      continue;
    }
    const mapped = map(current, secret);
    if (mapped === undefined || mapped === current) {
      continue;
    }
    next = writePath(next, secret.path, mapped);
  }

  return next;
}

/** Encrypt every declared secret that is stored encrypted. */
export function encryptConfigSecrets<C>(config: C): C {
  return mapSecrets(config, (value, secret) =>
    secret.encrypted ? encryptCredential(value) : undefined,
  );
}

/** Blank every declared secret before a config leaves the API. */
export function redactConfigSecrets<C>(config: C): C {
  return mapSecrets(config, (value) => (value === '' ? undefined : ''));
}

/**
 * Restore secrets the client left blank from the stored row, so an edit that
 * doesn't retype them keeps working now that reads are redacted. Record values
 * carry over per key, so clearing one header still clears it while the others
 * survive.
 */
export function carryOverConfigSecrets<C>(next: C, stored: unknown): C {
  return mapSecrets(next, (value, secret, recordKey) => {
    if (value !== '') {
      return undefined;
    }
    const previous = readPath(stored, secret.path);
    if (recordKey === undefined) {
      return typeof previous === 'string' ? previous : undefined;
    }
    if (typeof previous !== 'object' || previous === null) {
      return undefined;
    }
    const previousValue = (previous as LooseConfig)[recordKey];
    return typeof previousValue === 'string' ? previousValue : undefined;
  });
}

/**
 * Path of the first encrypted secret that arrived already encrypted, if any.
 * Callers reject the request: a client never legitimately holds a ciphertext,
 * so one on the wire is a replay attempt. Redact-only fields are stored in
 * plaintext, so an `enc:`-looking value there is just a string.
 */
export function findEncryptedSecretField(config: unknown): string | undefined {
  for (const secret of secretsFor(config)) {
    if (!secret.encrypted) {
      continue;
    }
    const value = readPath(config, secret.path);
    if (typeof value === 'string' && looksEncrypted(value)) {
      return secret.path;
    }
  }
  return undefined;
}

/**
 * Paths of the required credentials that are present but blank.
 *
 * An ABSENT field is not missing — it is not applicable to this config variant
 * (an `iam_role` S3 config carries no `secretAccessKey` at all), and the zod
 * schema already guarantees the field exists on the variants that need it.
 */
export function findMissingSecretFields(config: unknown): string[] {
  if (typeof config !== 'object' || config === null) {
    return [];
  }
  return secretsFor(config)
    .filter(
      (secret) =>
        secret.encrypted &&
        readPath(config, secret.path) === '' &&
        !secret.record,
    )
    .map((secret) => secret.path);
}
