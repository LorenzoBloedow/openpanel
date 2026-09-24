/**
 * Shared afterAll cleanup registered via setupFiles in vitest.shared.ts.
 *
 * Pools and Prisma clients created outside a request scope live in the
 * runtime's fallback scope (Node only). Closing it after every test file lets
 * worker threads exit cleanly.
 */
import { afterAll } from 'vitest';
import { disposeFallbackScope } from '../packages/runtime/index';

afterAll(async () => {
  await disposeFallbackScope();
});
