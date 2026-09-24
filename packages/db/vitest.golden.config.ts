import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Golden capture against the original ClickHouse services (porting aid).
 * Not part of the regular test projects: it needs a local ClickHouse.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    include: ['test/golden/**/*.golden-capture.ts'],
    setupFiles: [path.resolve(__dirname, '../../test/test-setup.ts')],
    env: {
      CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123/openpanel',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/postgres?schema=public',
      SELF_HOSTED: 'true',
      LOG_LEVEL: 'warn',
    },
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
