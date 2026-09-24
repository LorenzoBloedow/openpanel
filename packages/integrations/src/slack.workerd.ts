/**
 * Cloudflare build of ./slack (see registry.workerd.ts): the Slack SDKs are
 * not bundled and every export throws FeatureUnavailableError when used.
 */
import { unavailable, unavailableObject } from '@openpanel/runtime';
import type * as Slack from './slack';

export const slackInstaller =
  unavailableObject<typeof Slack.slackInstaller>('integrations');
export const getSlackInstallUrl =
  unavailable<typeof Slack.getSlackInstallUrl>('integrations');
export const sendSlackNotification =
  unavailable<typeof Slack.sendSlackNotification>('integrations');

// Compile-time parity with the Node module: same exports, compatible types.
type Assert<T extends true> = T;
export type SlackWorkerdParity = Assert<
  typeof import('./slack.workerd') extends typeof import('./slack')
    ? true
    : false
>;
