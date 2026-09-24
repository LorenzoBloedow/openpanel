import { runWithScope } from '@openpanel/runtime';

/**
 * Workflow steps are background work: they run on the direct database
 * route, each step in its own runtime scope (pools opened and closed per
 * step, as Workers require).
 */
export function inStepScope<T>(
  env: Env,
  ctx: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithScope({ env, ctx, route: 'direct' }, fn);
}
