/**
 * pnpm cf:setup — prepare a Cloudflare account for OpenPanel.
 *
 * Creates (or reuses) the Hyperdrive config, queues and backup bucket, fills
 * the account-specific values into the Workers' wrangler.jsonc files, and
 * writes the secrets `pnpm cf:deploy` uploads. Safe to run again: existing
 * resources and generated keys are kept.
 */
import { join } from 'node:path';
import arg from 'arg';

import { UsageError, main, REPO_ROOT, redact } from './cli';
import { apiFromEnv } from './cloudflare-api';
import {
  ensureBackupBucket,
  ensureHyperdrive,
  ensureQueues,
  originFromUrl,
  placementRegion,
  workersSubdomain,
} from './provision';
import { mergeSecrets, readSecrets, secretsPath, writeSecrets } from './secrets';
import { type ConfigEdit, editConfigFile, routesEdit } from './wrangler-config';

const HELP = `Prepare a Cloudflare account for OpenPanel.

Usage: pnpm cf:setup [options]

Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (see tooling/cloudflare/DEPLOY.md).

Database (Neon):
  --database-url <url>     the direct (unpooled) connection string: Hyperdrive's origin
                           (default DATABASE_URL_DIRECT)
  --pooled-url <url>       the pooled connection string (…-pooler…): the Workers'
                           DATABASE_URL secret (default DATABASE_URL_POOLED)
  --neon-region <id>       the Neon project's region, e.g. aws-us-east-2: the API runs there

URLs (default: the account's workers.dev URLs):
  --api-domain <host>        custom domain for the API, e.g. api.example.com
  --dashboard-domain <host>  custom domain for the dashboard
  --public-domain <host>     custom domain for the website

Other:
  --email-sender <address>   the From address (its domain must be onboarded to Email Service)
  --cors-origins <list>      extra origins allowed to call the dashboard API (comma-separated)
  --r2-location <hint>       R2 location hint for the backup bucket (e.g. enam, weur)
  --backup-retention-days <n>  (default 30)
  --hyperdrive-connections <n> Hyperdrive's origin connection limit (default: Cloudflare's)
  --dry-run                  show what would change, change nothing`;

const APPS = {
  api: join(REPO_ROOT, 'apps/api/wrangler.jsonc'),
  worker: join(REPO_ROOT, 'apps/worker/wrangler.jsonc'),
  dashboard: join(REPO_ROOT, 'apps/start/wrangler.jsonc'),
  public: join(REPO_ROOT, 'apps/public/wrangler.jsonc'),
};

const SECRETS_ROOT = join(REPO_ROOT, 'tooling/cloudflare');

function requireUrl(value: string | undefined, name: string) {
  if (!value) {
    throw new UsageError(`Missing ${name}`);
  }
  return value;
}

async function setup() {
  const flags = arg({
    '--database-url': String,
    '--pooled-url': String,
    '--neon-region': String,
    '--api-domain': String,
    '--dashboard-domain': String,
    '--public-domain': String,
    '--email-sender': String,
    '--cors-origins': String,
    '--r2-location': String,
    '--backup-retention-days': Number,
    '--hyperdrive-connections': Number,
    '--dry-run': Boolean,
    '--help': Boolean,
    '-h': '--help',
  });
  if (flags['--help']) {
    console.log(HELP);
    return;
  }
  const dryRun = flags['--dry-run'] ?? false;
  const log = (message: string) => console.log(`${dryRun ? '[dry run] ' : ''}${message}`);

  const directUrl = requireUrl(
    flags['--database-url'] ?? process.env.DATABASE_URL_DIRECT,
    '--database-url (Neon direct connection string)',
  );
  const pooledUrl = requireUrl(
    flags['--pooled-url'] ?? process.env.DATABASE_URL_POOLED,
    '--pooled-url (Neon pooled connection string)',
  );
  if (new URL(directUrl).hostname.includes('-pooler.')) {
    throw new UsageError(
      "--database-url is Neon's pooled endpoint; Hyperdrive needs the direct (unpooled) one",
    );
  }
  if (!new URL(pooledUrl).hostname.includes('-pooler.')) {
    log(
      `Note: ${redact(pooledUrl)} doesn't look like Neon's pooled endpoint (…-pooler…); background work opens a connection per invocation and should go through PgBouncer`,
    );
  }
  const neonRegion = flags['--neon-region'];
  if (!neonRegion) {
    throw new UsageError('Missing --neon-region (e.g. aws-us-east-2)');
  }
  const region = placementRegion(neonRegion);
  const retentionDays = flags['--backup-retention-days'] ?? 30;

  if (!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN)) {
    throw new UsageError('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  }
  const api = apiFromEnv();
  log(`Account ${api.accountId}`);

  const hyperdriveId = await ensureHyperdrive(
    api,
    {
      origin: originFromUrl(directUrl),
      connectionLimit: flags['--hyperdrive-connections'],
      dryRun,
    },
    log,
  );
  await ensureQueues(api, { dryRun }, log);
  await ensureBackupBucket(
    api,
    { retentionDays, fullEveryDays: 7, locationHint: flags['--r2-location'], dryRun },
    log,
  );

  const subdomain = await workersSubdomain(api);
  const urlFor = (domain: string | undefined, worker: string, flag: string) => {
    if (domain) {
      return `https://${domain}`;
    }
    if (subdomain) {
      return `https://${worker}.${subdomain}.workers.dev`;
    }
    throw new UsageError(
      `No workers.dev subdomain on this account: pass ${flag}, or register a subdomain in the dashboard (Workers & Pages)`,
    );
  };
  const apiUrl = urlFor(flags['--api-domain'], 'openpanel-api', '--api-domain');
  const dashboardUrl = urlFor(
    flags['--dashboard-domain'],
    'openpanel-dashboard',
    '--dashboard-domain',
  );
  const sender = flags['--email-sender'];
  const sendEmail: ConfigEdit[] = sender
    ? [
        { path: ['vars', 'EMAIL_SENDER'], value: sender },
        { path: ['send_email'], value: [{ name: 'EMAIL', allowed_sender_addresses: [sender] }] },
      ]
    : [];

  const edits: Record<keyof typeof APPS, ConfigEdit[]> = {
    api: [
      { path: ['hyperdrive', 0, 'id'], value: hyperdriveId },
      { path: ['placement'], value: { mode: 'targeted', region } },
      { path: ['vars', 'API_URL'], value: apiUrl },
      { path: ['vars', 'DASHBOARD_URL'], value: dashboardUrl },
      ...(flags['--cors-origins']
        ? [{ path: ['vars', 'API_CORS_ORIGINS'], value: flags['--cors-origins'] }]
        : []),
      ...sendEmail,
      ...routesEdit(flags['--api-domain']),
    ],
    worker: [
      { path: ['vars', 'API_URL'], value: apiUrl },
      { path: ['vars', 'DASHBOARD_URL'], value: dashboardUrl },
      { path: ['vars', 'BACKUP_RETENTION_DAYS'], value: String(retentionDays) },
      ...sendEmail,
    ],
    dashboard: [
      { path: ['vars', 'API_URL'], value: apiUrl },
      { path: ['vars', 'DASHBOARD_URL'], value: dashboardUrl },
      ...routesEdit(flags['--dashboard-domain']),
    ],
    public: [
      { path: ['vars', 'API_URL'], value: apiUrl },
      ...routesEdit(flags['--public-domain']),
    ],
  };
  for (const [app, file] of Object.entries(APPS) as [keyof typeof APPS, string][]) {
    const changed = await editConfigFile(file, edits[app], { dryRun });
    log(`${changed ? 'Updated' : 'Unchanged'}: ${file.slice(REPO_ROOT.length + 1)}`);
  }

  const current = {
    api: await readSecrets(secretsPath(SECRETS_ROOT, 'api')),
    worker: await readSecrets(secretsPath(SECRETS_ROOT, 'worker')),
  };
  const secrets = mergeSecrets(current, { pooledDatabaseUrl: pooledUrl, env: process.env });
  for (const app of ['api', 'worker'] as const) {
    const file = secretsPath(SECRETS_ROOT, app);
    log(`Secrets for ${app}: ${Object.keys(secrets[app]).sort().join(', ')} → ${file.slice(REPO_ROOT.length + 1)}`);
    if (!dryRun) {
      await writeSecrets(file, secrets[app]);
    }
  }

  log('');
  log(`API:       ${apiUrl}`);
  log(`Dashboard: ${dashboardUrl}`);
  log('Next: onboard the sender domain to Email Service, then run `pnpm cf:deploy`.');
}

await main(setup, HELP);
