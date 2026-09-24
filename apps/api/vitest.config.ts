import { mergeConfig } from 'vitest/config';

import { getSharedVitestConfig } from '../../vitest.shared';

export default mergeConfig(getSharedVitestConfig({ __dirname }), {
  test: {
    exclude: ['e2e/**'],
  },
});
