import * as path from 'node:path';
import { mergeConfig } from 'vitest/config';

import { getSharedVitestConfig } from '../../vitest.shared';

export default mergeConfig(getSharedVitestConfig({ __dirname }), {
  resolve: {
    alias: {
      // Workflow entrypoints extend cloudflare:workers classes; Node tests
      // run them with a stand-in module.
      'cloudflare:workers': path.resolve(__dirname, 'test/cloudflare-workers.ts'),
    },
  },
});
