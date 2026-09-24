# Session E2E

Two harnesses over a shared foundation (`lib.ts`). Both drive the **real stack**
(`openpanel-api` + `openpanel-worker` under `wrangler dev`) over HTTP and assert
the resulting state in **Postgres** (`analytics.*`):

- `session-e2e.ts` (`e2e:sessions`) — **correctness**: the full lifecycle for one
  session per scenario (open/extend/close via reaper + boundary, replay,
  identify, duplicate suppression), including live-session cleanup.
- `session-stress.ts` (`e2e:sessions:stress`) — **volume + drain**: ramps out many
  sessions, then drives the reaper until *everything* has drained (every
  `session_end` emitted, no live session left) and reconciles the event counts.

## What it covers

| Scenario | Asserts |
|----------|---------|
| Single session → reaper close | a `live_sessions` row with the returned id; one `session_start` + N events; after the reaper closes it: one `session_end`, the `sessions` row, the live row gone, and no second `session_end` on the next run. |
| Boundary split | a >idle-window gap opens a NEW session id and emits exactly one `session_end` for the first + a `session_start` for the second. |
| Non-screen_view first | a custom event opens a session that closes as a bounce with `screen_view_count` 0. |
| Replay | a replay chunk lands in `session_replay_chunks` under the echoed session id (written synchronously on the direct route). |
| Identify | the live session and the events carry the profile id; identify upserts the profile. |
| Duplicate | of two identical concurrent browser requests, one is answered `Duplicate event`. |

## Running

Sessions idle out after 30 min by default. Shrink that in both workers'
`.dev.vars` (`SESSION_TIMEOUT_MS=4000`, see `.dev.vars.example`) and start the
stack against a migrated database (`pnpm migrate:deploy`, or a copy of the test
template):

```bash
# 1. API (Hyperdrive → local Postgres) and worker (queues, crons)
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://postgres:postgres@localhost:5432/openpanel_dev \
  pnpm --filter @openpanel/api exec wrangler dev --port 3333
pnpm --filter @openpanel/worker exec wrangler dev --port 9999 --test-scheduled

# 2. In another terminal, run the harness with the SAME timeout
SESSION_TIMEOUT_MS=4000 pnpm --filter @openpanel/api e2e:sessions

# …or the stress + drain test (500 sessions by default)
SESSION_TIMEOUT_MS=4000 pnpm --filter @openpanel/api e2e:sessions:stress
```

The two `wrangler dev` sessions find each other through the local dev
registry: the API's queue feeds the worker's consumer, and the worker publishes
to the API's LiveHub. The harness runs the reaper on demand through the
worker's `/__scheduled` endpoint (`--test-scheduled`), so it never waits for
the minute cron.

Stress tunables (env): `E2E_SESSIONS` (500), `E2E_CONCURRENCY` (25),
`E2E_EVENTS_PER_SESSION` (3), `E2E_DRAIN_TIMEOUT_MS` (120000).

### Notes
- Uses a dedicated project (`e2e-sessions`) and a throwaway client
  (`ignoreCorsAndSecret`), created automatically under org `openpanel-dev`.
- Each run uses fresh device IPs, so reruns don't collide with prior state.
- Overridable: `E2E_API_URL` (default `:3333`), `E2E_WORKER_URL` (default
  `:9999`), `E2E_DATABASE_URL` (default the local `openpanel_dev` database).
- The harness and the stack **must share the same `SESSION_TIMEOUT_MS`** — the
  harness derives its idle waits from it.
