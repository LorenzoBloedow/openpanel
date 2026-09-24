/**
 * Cloudflare build of ./polar, selected through the "workerd" condition of
 * the package root. OpenPanel on Cloudflare runs in self-hosted mode, which
 * has no billing, so `@polar-sh/sdk` is never bundled: every call throws
 * FeatureUnavailableError, and defining the stubs is inert.
 */
import { unavailable, unavailableObject } from '@openpanel/runtime';
import type * as Polar from './polar.js';

export type {
  ICancellationReason,
  IPolarPrice,
  IPolarProduct,
} from './polar.js';

const FEATURE = 'billing';

export class PolarWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export const validatePolarEvent =
  unavailable<typeof Polar.validatePolarEvent>(FEATURE);
export const polar = unavailableObject<typeof Polar.polar>(FEATURE);
export const getSuccessUrl: typeof Polar.getSuccessUrl = (
  baseUrl,
  organizationId,
) => `${baseUrl}/${organizationId}/billing`;
export const getProducts = unavailable<typeof Polar.getProducts>(FEATURE);
export const getProduct = unavailable<typeof Polar.getProduct>(FEATURE);
export const createPortal = unavailable<typeof Polar.createPortal>(FEATURE);
export const createCheckout = unavailable<typeof Polar.createCheckout>(FEATURE);
export const cancelSubscription =
  unavailable<typeof Polar.cancelSubscription>(FEATURE);
export const pauseSubscription =
  unavailable<typeof Polar.pauseSubscription>(FEATURE);
export const unpauseSubscription =
  unavailable<typeof Polar.unpauseSubscription>(FEATURE);
export const resumeSubscription =
  unavailable<typeof Polar.resumeSubscription>(FEATURE);
export const applySubscriptionDiscount =
  unavailable<typeof Polar.applySubscriptionDiscount>(FEATURE);
export const reactivateSubscription =
  unavailable<typeof Polar.reactivateSubscription>(FEATURE);
export const changeSubscription =
  unavailable<typeof Polar.changeSubscription>(FEATURE);

// Compile-time parity with the Node module: same exports, compatible types.
type Assert<T extends true> = T;
export type PolarWorkerdParity = Assert<
  typeof import('./polar.workerd.js') extends typeof import('./polar.js')
    ? true
    : false
>;
