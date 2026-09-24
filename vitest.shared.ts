import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// Absolute path to the root test-setup — used as setupFiles so every package
// gets connection-pool cleanup without needing a per-package file.
const rootTestSetup = (dirname: string) => path.resolve(dirname, '../../test/test-setup.ts');

const LOCAL_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/postgres?schema=public';

export const getSharedVitestConfig = ({
  __dirname: dirname,
}: {
  __dirname: string;
}) => {
  return defineConfig({
    resolve: {
      alias: {
        '@': path.resolve(dirname, 'src'),
      },
    },
    test: {
      setupFiles: [rootTestSetup(dirname)],
      env: {
        // Always point at the local Postgres — never production, regardless
        // of .env. Both connection routes (Hyperdrive / direct) resolve to it
        // in Node.
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL,
        DATABASE_URL_DIRECT: process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL,
        SELF_HOSTED: 'true',
      },
      include: ['**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.workerd.test.ts'],
      fakeTimers: { toFake: undefined },
    },
  });
};
