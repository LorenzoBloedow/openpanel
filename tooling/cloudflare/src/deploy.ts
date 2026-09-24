/**
 * pnpm cf:deploy — migrate the database, then deploy the Workers.
 *
 * Order matters: the worker binds the API's LiveHub Durable Object and the
 * dashboard binds the API as a service, so the API goes first. With
 * --dry-run nothing is uploaded or migrated: every app is built and bundled
 * as it would be deployed, and the bundle sizes are reported.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import arg from 'arg';

import { UsageError, databaseUrl, main, REPO_ROOT, redact } from './cli';
import { secretsPath } from './secrets';
import { readConfigValue } from './wrangler-config';

const HELP = `Migrate the database and deploy OpenPanel's Workers.

Usage: pnpm cf:deploy [options]

Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, a prior \`pnpm cf:setup\`, and
DATABASE_URL_DIRECT (Neon's direct connection string) for the migrations.

Options:
  --only <apps>        comma-separated subset of: api, worker, dashboard, public
  --skip-migrations    deploy without migrating first
  --database-url <url> the database to migrate (default DATABASE_URL_DIRECT)
  --dry-run            build and bundle everything, upload nothing, report sizes`;

type App = 'api' | 'worker' | 'dashboard' | 'public';

const ORDER: App[] = ['api', 'worker', 'dashboard', 'public'];

const DIRS: Record<App, string> = {
  api: 'apps/api',
  worker: 'apps/worker',
  dashboard: 'apps/start',
  public: 'apps/public',
};

/** The Vite-built apps deploy the config their build generates. */
const BUILT_WITH_VITE = new Set<App>(['dashboard', 'public']);

const SECRETS: Partial<Record<App, 'api' | 'worker'>> = { api: 'api', worker: 'worker' };

const PLACEHOLDER_ID = /^0+$/;

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; capture?: boolean }) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (options.capture) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${options.cwd}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function preflight(apps: App[], dryRun: boolean) {
  if (dryRun) {
    return;
  }
  if (!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN)) {
    throw new UsageError('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  }
  if (apps.includes('api')) {
    const config = readFileSync(join(REPO_ROOT, 'apps/api/wrangler.jsonc'), 'utf8');
    const id = readConfigValue(config, ['hyperdrive', 0, 'id']);
    if (typeof id !== 'string' || PLACEHOLDER_ID.test(id)) {
      throw new UsageError('The Hyperdrive id is still a placeholder: run `pnpm cf:setup` first');
    }
  }
  for (const app of apps) {
    const secrets = SECRETS[app];
    if (secrets && !existsSync(secretsPath(join(REPO_ROOT, 'tooling/cloudflare'), secrets))) {
      throw new UsageError(`No secrets for ${app}: run \`pnpm cf:setup\` first`);
    }
  }
}

function migrate(url: string) {
  console.log(`Migrating ${redact(url)}`);
  run('pnpm', ['--filter', '@openpanel/db', 'run', 'migrate:deploy'], {
    cwd: REPO_ROOT,
    env: { DATABASE_URL: url, DATABASE_URL_DIRECT: url },
  });
}

function deployApp(app: App, dryRun: boolean, outRoot: string): string | undefined {
  const cwd = join(REPO_ROOT, DIRS[app]);
  console.log(`\n── ${app} (${DIRS[app]})`);
  if (BUILT_WITH_VITE.has(app)) {
    run('pnpm', ['run', 'build'], { cwd });
  }
  const args = ['wrangler', 'deploy'];
  if (dryRun) {
    args.push('--dry-run', '--outdir', join(outRoot, app));
  } else {
    const secrets = SECRETS[app];
    if (secrets) {
      args.push('--secrets-file', secretsPath(join(REPO_ROOT, 'tooling/cloudflare'), secrets));
    }
  }
  const output = run('npx', args, { cwd, capture: true });
  return output.match(/Total Upload: ([^\n]+)/)?.[1]?.trim();
}

async function deploy() {
  const flags = arg({
    '--only': String,
    '--skip-migrations': Boolean,
    '--database-url': String,
    '--dry-run': Boolean,
    '--help': Boolean,
    '-h': '--help',
  });
  if (flags['--help']) {
    console.log(HELP);
    return;
  }
  const dryRun = flags['--dry-run'] ?? false;
  const only = flags['--only']?.split(',').map((app) => app.trim());
  for (const app of only ?? []) {
    if (!ORDER.includes(app as App)) {
      throw new UsageError(`Unknown app "${app}"`);
    }
  }
  const apps = ORDER.filter((app) => !only || only.includes(app));

  preflight(apps, dryRun);
  if (dryRun || flags['--skip-migrations']) {
    console.log(dryRun ? 'Dry run: not migrating' : 'Skipping migrations');
  } else {
    migrate(databaseUrl(flags['--database-url']));
  }

  const outRoot = mkdtempSync(join(tmpdir(), 'openpanel-deploy-'));
  const sizes: [App, string | undefined][] = [];
  for (const app of apps) {
    sizes.push([app, deployApp(app, dryRun, outRoot)]);
  }

  console.log(`\n${dryRun ? 'Bundled (not deployed)' : 'Deployed'}:`);
  for (const [app, size] of sizes) {
    console.log(`  ${app.padEnd(10)} ${size ?? ''}`);
  }
}

await main(deploy, HELP);
