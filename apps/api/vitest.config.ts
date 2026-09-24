import { mergeConfig } from 'vitest/config';

import { getSharedVitestConfig } from '../../vitest.shared';

export default mergeConfig(getSharedVitestConfig({ __dirname }), {
  test: {
    exclude: [
      // Drives the insights services through Fastify; ported with them.
      'src/routes/insights.router.test.ts',
      'e2e/**',
    ],
  },
});
