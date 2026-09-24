# Deploying OpenPanel on Cloudflare

OpenPanel runs as four Workers on your Cloudflare account, with a Neon
Postgres database holding all of its data.

| Worker | App | Does |
|---|---|---|
| `openpanel-api` | `apps/api` (Hono) | Event ingestion (`/track`), the dashboard's API (`/trpc`), the public API (`/export`, `/insights`, `/manage`), OAuth callbacks, realtime WebSockets (the `LiveHub` Durable Object), rate limiting |
| `openpanel-worker` | `apps/worker` | The ingest queue consumer (writes events and sessions), background jobs, crons, and the Backup, ProjectDelete and GscBackfill Workflows |
| `openpanel-dashboard` | `apps/start` | The dashboard. It calls the API through a service binding |
| `openpanel-public` | `apps/public` | The website and docs (optional) |

**Data paths:**
- **Neon Postgres** holds everything: the Prisma tables (`public` schema) and the events (`analytics` schema).
- Requests where someone waits on the answer go through **Hyperdrive**. Hyperdrive connects to Neon's direct endpoint, with query caching off.
- Background work (the queue consumers, crons and Workflows) connects to **Neon's pooled endpoint** over TCP, using the `DATABASE_URL` secret.
- **R2** stores the nightly backups.

## Requirements

- **Workers Paid plan.** It's needed for the CPU limits of the queue consumers and Workflows, for Queues and Workflows themselves, and because the API bundle is about 3 MB gzipped.
- **A Neon project running Postgres 16 or newer.**
- **A domain on Cloudflare.** Email Service sends from it, and it's recommended for custom domains.
- **Node 22 and pnpm** on the machine you deploy from, and a checkout of this repository with `pnpm install` done.

## 1. Neon

1. Create a project in the region closest to your users, and note its region id, e.g. `aws-us-east-2`. The API Worker is placed in the same region.
2. Copy both connection strings from the project's **Connect** dialog:
   - **Direct** (host without `-pooler`): Hyperdrive's origin, migrations and the backup/restore scripts. This is `DATABASE_URL_DIRECT`.
   - **Pooled** (host with `-pooler`): the Workers' background connection, stored as the `DATABASE_URL` secret. Background work opens a short connection per invocation, and PgBouncer absorbs that.
3. Cap statement run time for the app's role. Hyperdrive stops queries at 60 s anyway:
   ```sql
   ALTER ROLE neondb_owner SET statement_timeout = '30s';
   ```
4. For production, turn off scale-to-zero, or set a minimum compute, so the first request after a quiet period doesn't wait for the database to wake up. Size the compute for your event volume. Analytics queries run on Postgres, so start at 1–2 CU and watch the query times.
5. Neon's history retention (point-in-time restore) is your first line of defense. The R2 backups cover losing the account and give you a portable copy.

## 2. Cloudflare API token

Create an account API token (**My Profile → API Tokens → Create Token**):

1. Start from the **Edit Cloudflare Workers** template.
2. Add **Hyperdrive: Edit**, **Queues: Edit** and **Workers R2 Storage: Edit**.
3. If you use custom domains, keep **Zone → Workers Routes: Edit** for their zones.
4. Export the token and your account id:

```bash
export CLOUDFLARE_ACCOUNT_ID=…
export CLOUDFLARE_API_TOKEN=…
```

Both scripts below and wrangler read them.

## 3. Email Service

Onboard your sending domain in **Email → Email Service**. Cloudflare adds the SPF, DKIM and DMARC records. Then pick a sender address on that domain, e.g. `hello@example.com`.

Without Email Service, invites, password resets and alerts aren't sent. The rest of OpenPanel works.

## 4. Configure: `pnpm cf:setup`

If you use GitHub or Google sign-in, or Search Console, export their credentials first:
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- `GSC_GOOGLE_REDIRECT_URI`

The redirect URIs are:
- `https://<api>/oauth/github/callback`
- `https://<api>/oauth/google/callback`
- `https://<api>/gsc/callback`

```bash
pnpm cf:setup \
  --database-url "$NEON_DIRECT_URL" \
  --pooled-url "$NEON_POOLED_URL" \
  --neon-region aws-us-east-2 \
  --api-domain api.example.com \
  --dashboard-domain analytics.example.com \
  --email-sender hello@example.com
```

It does the following. Running it again is safe: existing resources and generated keys are kept.

1. **Creates or reuses:**
   - the Hyperdrive config `openpanel`, with the direct URL as its origin and caching off;
   - the queues `op-events`, `op-jobs` and their dead-letter queues;
   - the R2 bucket `openpanel-backups`, plus a lifecycle rule that expires leftover backup objects.
2. **Writes the account-specific values into `apps/*/wrangler.jsonc`:**
   - the Hyperdrive id and the API's placement region;
   - the public URLs;
   - the allowed email sender;
   - the custom-domain routes.

   Commit these changes. They hold no secrets.
3. **Writes the secrets** to `tooling/cloudflare/.secrets/{api,worker}.json`. These files are gitignored; keep them safe.
   - `DATABASE_URL`, the pooled URL.
   - `COOKIE_SECRET` and `ENCRYPTION_KEY`, generated once. Losing `ENCRYPTION_KEY` makes stored tokens unreadable, and changing `COOKIE_SECRET` signs everyone out.
   - The OAuth credentials.

**Options:**
- Without `--*-domain`, the Workers use your `workers.dev` subdomain.
- `--cors-origins` adds origins allowed to call the dashboard API.
- `--r2-location` sets the backup bucket's location hint.
- `--backup-retention-days` defaults to 30.
- `--hyperdrive-connections` sets Hyperdrive's origin connection limit.
- `--dry-run` shows the changes without making them.

## 5. Deploy: `pnpm cf:deploy`

```bash
export DATABASE_URL_DIRECT="$NEON_DIRECT_URL"
pnpm cf:deploy
```

It runs the migrations (Prisma's, then the `analytics` schema's), then deploys, in this order:

1. the API;
2. the worker, which binds the API's Durable Object;
3. the dashboard, which binds the API;
4. the website.

Each Worker gets its secrets with the upload.

- `--only api,worker` deploys a subset.
- `--skip-migrations` skips the migration step.
- `--dry-run` builds and bundles everything without uploading, and prints the bundle sizes.

Open the dashboard and sign up. The first account can register freely. After that, sign-up needs an invite (`ALLOW_REGISTRATION` / `ALLOW_INVITATION` in `apps/api/wrangler.jsonc`). Create a project, then point the SDK's `apiUrl` at your API URL.

## Operating it

- **Backups:** nightly at 03:00 UTC. See [README.md](./README.md) for the format, `pnpm cf:backup` and `pnpm cf:restore`.
- **Crons** (worker):
  - every minute: the session reaper;
  - daily: salt rotation and retention sweeps;
  - hourly: counters and scheduled deletions;
  - every 30 minutes: cohort refresh;
  - daily: insights;
  - nightly: Search Console sync;
  - Mondays: the weekly digest.
- **Logs:** Workers Observability is on for every Worker.
- **Tuning:**
  - `max_concurrency` of the `op-events` consumer (`apps/worker/wrangler.jsonc`);
  - Hyperdrive's origin connection limit;
  - Neon's compute size;
  - `EVENTS_RETENTION_DAYS` and `INSIGHTS_RETENTION_DAYS` (worker);
  - `SESSION_TIMEOUT_MS` (api and worker; default 30 minutes).
- **Deleting projects and organizations** is scheduled. The hourly cron hands them to the ProjectDelete workflow, which removes the analytics rows in chunks.

## Differences from the Docker version

**Not available on Cloudflare yet.** The API answers 501 and the dashboard hides these:
- AI (chat, insight explanations, the filter command, digest narratives);
- MCP;
- importers from other tools;
- Slack, Discord and webhook integrations;
- S3/GCS exports;
- `/tools`;
- billing.

**Behavior changes:**
- Geo (country, city, ASN) comes from Cloudflare's view of the connecting IP. Events sent with a forwarded IP (`openpanel-client-ip`, `__ip`) get no geo.
- Unique counts are exact (`COUNT(DISTINCT)`) rather than approximate.
- Sessions close within about a minute of going idle, where before it could take up to five. At a session boundary, the closing `session_end` takes its properties from the session.
- An `increment`/`decrement` sent right after an `identify` can return 404 for a few seconds, while the queue consumer writes the profile.
- The rate limits of auth endpoints count per 60 seconds, not 30. All rate limits are counted per Cloudflare location, so they are approximate.
