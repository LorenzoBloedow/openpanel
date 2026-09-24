import { mergeConfig } from 'vitest/config';

import { getSharedVitestConfig } from '../../vitest.shared';

export default mergeConfig(getSharedVitestConfig({ __dirname }), {
  test: {
    exclude: [
      // Fastify modules not ported to Hono yet (see tsconfig.json).
      'src/routes/insights.router.test.ts',
      'src/utils/image-proxy.test.ts',
      'src/utils/rate-limiter.test.ts',
      'e2e/**',
    ],
  },
});
