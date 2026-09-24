# Smoke test

One Playwright flow through the whole local stack: the API and the worker
under `wrangler dev`, the dashboard under Vite, and Postgres.

| Step | What it checks |
|---|---|
| Sign-up | A new account, then a website project in onboarding. The client id is read from the connect page, and no MCP token is shown. |
| Verification | Events sent the way the web SDK sends them (`/track`) unlock onboarding's "Your dashboard". |
| Overview | 2 unique visitors, 2 sessions and 7 page views, read from Postgres through tRPC. |
| Realtime | The worker publishes to the `LiveHub` Durable Object after each queue batch, and the header's live counter gets the new count over its WebSocket. |
| Reports | A funnel (screen_view → sign_up: 1 of 3 sessions) and a retention report, created through tRPC with the page's session cookie. |
| Replay | A recorded rrweb chunk plays in the session page's player. |

## Running it

Postgres must be running and migrated (`pnpm dock:up`, `pnpm migrate:deploy`).
Then, from the repository root:

```bash
pnpm --filter start test:e2e
```

- **Reusing a stack:** servers already listening on 3333 (API), 9999
  (worker) and 3000 (dashboard), such as a `pnpm dev`, are reused. The
  API must allow registration (`ALLOW_REGISTRATION=true`, as in
  `apps/api/.dev.vars.example`).
- **Starting one:** Playwright starts any server that isn't running, with
  registration allowed and the production session timeout. To put
  everything in its own database, set `SMOKE_DATABASE_URL`. Both of the
  Workers' database routes (the local Hyperdrive and `DATABASE_URL`) then
  point at it:

  ```bash
  createdb openpanel_smoke
  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/openpanel_smoke \
    SELF_HOSTED=true pnpm migrate:deploy
  SMOKE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/openpanel_smoke \
    pnpm --filter start test:e2e
  ```

Every run signs up a new user with a new project, so runs don't interfere
and the database needn't be empty.

## Output

- `e2e/results/screenshots/`: a full-page screenshot of every step.
- `e2e/results/<test>/`: the trace and a screenshot of a failed step. Open
  the trace with `npx playwright show-trace <trace.zip>`.
- `e2e/report/`: the HTML report (`npx playwright show-report e2e/report`).

Playwright 1.56.1 matches the Chromium build preinstalled in Claude Code's
cloud containers (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). Anywhere
else, install it once with `pnpm --filter start exec playwright install
chromium`.
