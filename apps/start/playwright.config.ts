import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke test of the local stack: the API and the worker under
 * `wrangler dev`, the dashboard under Vite (see e2e/README.md).
 *
 * Servers already running on these ports are reused. Otherwise Playwright
 * starts them the way `pnpm dev` does; with SMOKE_DATABASE_URL set, both of
 * the Workers' database routes (Hyperdrive and DATABASE_URL) point at it.
 */
const DASHBOARD_URL = process.env.SMOKE_DASHBOARD_URL ?? 'http://localhost:3000';
const API_URL = process.env.SMOKE_API_URL ?? 'http://localhost:3333';
const WORKER_PORT = 9999;
const SERVER_START_TIMEOUT_MS = 180_000;

const database = process.env.SMOKE_DATABASE_URL;
// Servers started here sign up a new user per run and keep sessions open as
// in production, whatever the local .dev.vars say.
const SESSION_TIMEOUT_MS = 30 * 60_000;
const workerFlags = [
  ` --var SESSION_TIMEOUT_MS:${SESSION_TIMEOUT_MS}`,
  database ? ` --var DATABASE_URL:${database}` : '',
].join('');
const databaseEnv: Record<string, string> = database
  ? { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: database }
  : {};

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/results',
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  // One serial flow: each step builds on the previous one.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: './e2e/report', open: 'never' }]],
  use: {
    baseURL: DASHBOARD_URL,
    timezoneId: 'Europe/Stockholm',
    viewport: { width: 1400, height: 900 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `pnpm --filter @openpanel/api exec wrangler dev --port 3333 --var ALLOW_REGISTRATION:true${workerFlags}`,
      url: `${API_URL}/healthcheck`,
      env: databaseEnv,
      reuseExistingServer: true,
      timeout: SERVER_START_TIMEOUT_MS,
    },
    {
      command: `pnpm --filter @openpanel/worker exec wrangler dev --port ${WORKER_PORT}${workerFlags}`,
      port: WORKER_PORT,
      env: databaseEnv,
      reuseExistingServer: true,
      timeout: SERVER_START_TIMEOUT_MS,
    },
    {
      command: 'pnpm dev',
      url: DASHBOARD_URL,
      reuseExistingServer: true,
      timeout: SERVER_START_TIMEOUT_MS,
    },
  ],
});
