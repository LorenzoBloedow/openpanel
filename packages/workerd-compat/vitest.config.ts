import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [
    cloudflareTest(({ inject }) => {
      const databaseUrl = inject('databaseUrl');
      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          hyperdrives: { HYPERDRIVE: databaseUrl },
          bindings: { DATABASE_URL: databaseUrl },
        },
      };
    }),
  ],
  test: {
    name: 'workerd-compat',
    include: ['test/**/*.workerd.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
  },
});
