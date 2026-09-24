/**
 * Cloudflare build of the integration registry, selected by the "workerd"
 * condition in package.json.
 *
 * Slack, Discord, webhooks and object-storage exports aren't available on
 * Cloudflare yet. Their plugins keep only what stored rows still need — the
 * secret declarations that drive redaction — and every capability throws
 * FeatureUnavailableError, so creating or testing one fails with a clear
 * "not available" instead of half-working. None of the delivery code (the
 * Slack SDK, the AWS/GCS clients, the JavaScript template runtime) is
 * bundled.
 */
import { type PlatformFeature, unavailable } from '@openpanel/runtime';
import type { IIntegrationConfig } from '@openpanel/validation';
import type { IServerIntegration } from './registry';
import { type ConfigOf, type IConfigSecret, INTEGRATION_SECRET_FIELDS } from './secrets';

export type {
  INotificationDeliverArgs,
  INotificationDeliverPayload,
  IServerIntegration,
} from './registry';
export * from './secrets';

function unavailablePlugin<T extends IIntegrationConfig['type']>(
  type: T,
  feature: PlatformFeature,
): IServerIntegration<T> {
  return {
    type,
    secretFields: INTEGRATION_SECRET_FIELDS[type] as readonly IConfigSecret<
      ConfigOf<T>
    >[],
    validateConfig: unavailable(feature),
    testConnection: unavailable(feature),
  };
}

export const SERVER_INTEGRATIONS = {
  slack: unavailablePlugin('slack', 'integrations'),
  discord: unavailablePlugin('discord', 'integrations'),
  webhook: unavailablePlugin('webhook', 'integrations'),
  app: { type: 'app' },
  email: { type: 'email' },
  s3_export: unavailablePlugin('s3_export', 'exports'),
  gcs_export: unavailablePlugin('gcs_export', 'exports'),
} satisfies {
  [T in IIntegrationConfig['type']]: IServerIntegration<T>;
};

export function getServerIntegration<T extends IIntegrationConfig['type']>(
  type: T,
): IServerIntegration<T> {
  return SERVER_INTEGRATIONS[type] as unknown as IServerIntegration<T>;
}

// Compile-time parity with the Node module: same exports, compatible types.
type Assert<T extends true> = T;
export type RegistryWorkerdParity = Assert<
  typeof import('./registry.workerd') extends typeof import('./registry')
    ? true
    : false
>;
