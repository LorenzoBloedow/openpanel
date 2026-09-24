# @openpanel/cloudflare

Node scripts for running OpenPanel on Cloudflare.

## Backups

The worker's `Backup` workflow runs nightly (03:00 UTC). It writes every table
of the `public` and `analytics` schemas to the `BACKUPS` R2 bucket:

- Each table becomes gzipped JSON Lines parts under `backups/<date>/<schema>.<table>/`.
- `analytics.events` is exported in full every `BACKUP_FULL_EVERY_DAYS` days
  (default 7). The backups in between are incremental and only hold new events.
- A `manifest.json` is written last. A date without one is incomplete and is
  ignored.
- Backups older than `BACKUP_RETENTION_DAYS` (default 30) are pruned. The
  newest full export of the events is always kept, along with the
  incrementals that build on it.

Neon's point-in-time restore should be the first thing you reach for. Use
these backups when that isn't available, for example after losing the account,
or to move the data somewhere else.

### Restore

```bash
# See what's there
pnpm cf:restore --r2 --list

# Restore the newest backup into an empty database
pnpm cf:restore --r2 --database-url "postgresql://…"   # Neon's direct (unpooled) URL

# A specific date, from a copy on disk (rclone, aws s3 cp, …)
pnpm cf:restore --dir ./openpanel-backups --date 2026-09-20
```

The script:

1. Runs `prisma migrate deploy` and the analytics migrations (skip them with
   `--skip-migrate`).
2. Checks that the database has every migration the backup was taken with.
3. Refuses a database that already has data, unless `--force` is passed. With
   `--force`, rows that already exist win over the backup's.
4. Loads every table in foreign-key order, in a single transaction.
   `analytics.events` is rebuilt from its full export and every incremental
   up to the chosen date.
5. Moves the sequences past the restored rows.

The backup's parts are exported one after another, so a row can reference a
row created after its parent table was exported. Such rows are skipped and
counted. The next backup contains them.

Where the backup is read from:

| Flag | Source |
|------|--------|
| `--r2` | The bucket, over R2's S3 API. Set `R2_ACCOUNT_ID` (or `CLOUDFLARE_ACCOUNT_ID`), `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` from an R2 API token. Optional: `R2_BUCKET` (default `openpanel-backups`) and `R2_JURISDICTION` (`eu`). |
| `--dir <path>` | A directory laid out like the bucket (`<path>/backups/<date>/…`). |
| `--local [worker dir]` | The local R2 state that `wrangler dev` keeps for the worker (default `apps/worker`). |

### Backup from Node

`pnpm cf:backup` writes a backup in the same format to any of these
destinations. Use it before an upgrade, or to copy a database out:

```bash
pnpm cf:backup --dir ./openpanel-backups --full
```

It prunes nothing unless you pass `--prune-days <n>`.

The database URL comes from `--database-url`, then `DATABASE_URL_DIRECT`, then
`DATABASE_URL`. Neon's pooled endpoint is refused: the migration runner needs a
session-level lock.
