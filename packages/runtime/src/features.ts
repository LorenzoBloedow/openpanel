import { isWorkerd } from './scope';

/**
 * Features the Cloudflare build doesn't ship yet. Their packages are swapped
 * for stubs through the "workerd" export condition (so the heavy Node-only
 * dependencies never reach a Worker bundle); the stubs throw
 * {@link FeatureUnavailableError}, which the API maps to 501 / tRPC
 * `NOT_IMPLEMENTED`.
 */
export type PlatformFeature =
  | 'ai'
  | 'billing'
  | 'exports'
  | 'importers'
  | 'integrations'
  | 'mcp'
  | 'telemetry'
  | 'tools';

const FEATURE_MESSAGES: Record<PlatformFeature, string> = {
  ai: 'AI features are not available on Cloudflare yet',
  billing: 'Billing is not available on Cloudflare yet',
  exports: 'Object-storage exports are not available on Cloudflare yet',
  importers: 'Importers are not available on Cloudflare yet',
  integrations:
    'Slack, Discord and webhook integrations are not available on Cloudflare yet',
  mcp: 'The MCP server is not available on Cloudflare yet',
  telemetry: 'Self-hosting telemetry is not collected on Cloudflare',
  tools: 'The site checker and IP lookup tools are not available on Cloudflare yet',
};

export class FeatureUnavailableError extends Error {
  readonly feature: PlatformFeature;

  constructor(feature: PlatformFeature) {
    super(FEATURE_MESSAGES[feature]);
    this.name = 'FeatureUnavailableError';
    this.feature = feature;
  }
}

export function isFeatureUnavailableError(
  error: unknown,
): error is FeatureUnavailableError {
  return (
    error instanceof FeatureUnavailableError ||
    (error instanceof Error && error.name === 'FeatureUnavailableError')
  );
}

/** Every out-of-scope feature is unavailable on workerd and available in Node. */
export function isFeatureAvailable(_feature: PlatformFeature): boolean {
  return !isWorkerd();
}

export function assertFeatureAvailable(feature: PlatformFeature): void {
  if (!isFeatureAvailable(feature)) {
    throw new FeatureUnavailableError(feature);
  }
}

/** Build a function that throws {@link FeatureUnavailableError} when called. */
export function unavailable<T extends (...args: any[]) => any>(
  feature: PlatformFeature,
): T {
  const stub = (..._args: unknown[]): never => {
    throw new FeatureUnavailableError(feature);
  };
  return stub as unknown as T;
}

/**
 * An object that throws {@link FeatureUnavailableError} on any property
 * access — for stubbing exported client instances. Creating it is inert.
 */
export function unavailableObject<T extends object>(
  feature: PlatformFeature,
): T {
  return new Proxy({} as T, {
    get(_target, property) {
      // Let `await stub`, JSON and inspection probe the object safely.
      if (property === 'then' || typeof property === 'symbol') {
        return undefined;
      }
      throw new FeatureUnavailableError(feature);
    },
  });
}
