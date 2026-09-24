import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest 4 replaced vitest.workspace.ts with `test.projects`. apps/start
    // has its own toolchain. Everything here runs in Node against the local
    // Postgres; packages/workerd-compat is the suite that runs in workerd.
    projects: [
      'packages/*',
      // Runs inside workerd from its own directory (see the root `test`
      // script): started from here, the pool resolves pg-cloudflare to its
      // non-workerd stub and every database test fails.
      '!packages/workerd-compat',
      'apps/*',
      '!apps/start',
      'tooling/cloudflare',
    ],
    globalSetup: ['./test/global-setup.ts'],
  },
});
