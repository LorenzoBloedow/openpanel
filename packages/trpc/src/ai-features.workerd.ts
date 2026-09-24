/**
 * Cloudflare build of ./ai-features: AI features aren't available on
 * Cloudflare yet, so the helpers throw FeatureUnavailableError (mapped to
 * tRPC NOT_IMPLEMENTED) and nothing AI-related is bundled.
 */
import { unavailable } from '@openpanel/runtime';
import type * as AiFeatures from './ai-features';

export const generateInsightExplanation =
  unavailable<typeof AiFeatures.generateInsightExplanation>('ai');
export const runFilterCommand =
  unavailable<typeof AiFeatures.runFilterCommand>('ai');

export const AI_FEATURES_AVAILABLE: boolean = false;

// Compile-time parity with the Node module: same exports, compatible types.
type Assert<T extends true> = T;
export type AiFeaturesWorkerdParity = Assert<
  typeof import('./ai-features.workerd') extends typeof import('./ai-features')
    ? true
    : false
>;
