import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest 4 replaced vitest.workspace.ts with `test.projects`. apps/start
    // has its own toolchain. apps/api and apps/worker run inside workerd via
    // @cloudflare/vitest-plugin and are picked up through their own configs.
    projects: ['packages/*', 'apps/*', '!apps/start', 'tooling/cloudflare'],
    globalSetup: ['./test/global-setup.ts'],
  },
});
