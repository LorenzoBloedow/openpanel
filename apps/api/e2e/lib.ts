/**
 * Shared building blocks for the session E2E + stress harnesses: config, an
 * HTTP track client, the reaper trigger, Postgres helpers, fixtures,
 * polling, and a tiny check/report framework.
 *
 * The stack runs under `wrangler dev` (see README.md); the harness reads the
 * results straight from Postgres (`analytics.*`).
 */

import pg from 'pg';

// ── Config ──────────────────────────────────────────────────────────────────
export const API_URL = process.env.E2E_API_URL || 'http://127.0.0.1:3333';
export const WORKER_URL = process.env.E2E_WORKER_URL || 'http://127.0.0.1:9999';
export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/openpanel_dev';
export const ORG_ID = 'openpanel-dev';
export const PROJECT_ID = 'e2e-sessions';
export const CLIENT_ID = 'e2e1e2e1-0000-4000-8000-000000000001';
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

export const SESSION_TIMEOUT_MS = Number.parseInt(
  process.env.SESSION_TIMEOUT_MS || String(1000 * 60 * 30),
  10,
);
/** How long to wait for a session to fall outside its idle window before closing. */
export const IDLE_WAIT_MS = SESSION_TIMEOUT_MS + 2000;

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
export const runId = Date.now();

export async function query<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, values);
  return result.rows;
}

// ── Timing ──────────────────────────────────────────────────────────────────
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value or the timeout elapses. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  { timeoutMs = 30_000, intervalMs = 500 } = {},
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await fn();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(intervalMs);
  }
}

// ── Report framework ──────────────────────────────────────────────────────
interface Result {
  scenario: string;
  name: string;
  ok: boolean;
  detail?: string;
}
const results: Result[] = [];
let currentScenario = 'setup';

export function scenario(name: string) {
  currentScenario = name;
  console.log(`\n▶ ${name}`);
}
export function check(name: string, ok: boolean, detail?: string) {
  results.push({ scenario: currentScenario, name, ok, detail });
  console.log(`   ${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}
/** Print the summary and return the number of failed checks. */
export function summarize(): number {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) {
      console.log(`  ✗ [${f.scenario}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    }
  }
  return failed.length;
}

// ── HTTP ────────────────────────────────────────────────────────────────────
export interface TrackResponse {
  deviceId: string;
  sessionId: string;
}

export async function track(body: unknown, ip: string): Promise<TrackResponse> {
  const res = await fetch(`${API_URL}/track`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'openpanel-client-id': CLIENT_ID,
      'user-agent': UA,
      'x-client-ip': ip,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST /track ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TrackResponse;
}

export const screenView = (
  ip: string,
  path: string,
  extra: Record<string, unknown> = {},
) =>
  track(
    {
      type: 'track',
      payload: {
        name: 'screen_view',
        properties: { __path: `https://e2e.test${path}`, __ip: ip, ...extra },
      },
    },
    ip,
  );

/**
 * Run the worker's minute cron (the session reaper) now, through
 * `wrangler dev --test-scheduled`.
 */
export async function triggerReaper() {
  const res = await fetch(`${WORKER_URL}/__scheduled?cron=${encodeURIComponent('* * * * *')}`);
  if (!res.ok) {
    throw new Error(`trigger reaper ${res.status}: ${await res.text()}`);
  }
}

// ── Counting (scoped to a set of session ids for run isolation) ──────────────
export async function countByName(
  sessionIds: string[],
  name: string,
): Promise<number> {
  if (sessionIds.length === 0) {
    return 0;
  }
  const rows = await query<{ c: number }>(
    `SELECT count(*)::int AS c FROM analytics.events
     WHERE project_id = $1 AND name = $2 AND session_id = ANY($3::text[])`,
    [PROJECT_ID, name, sessionIds],
  );
  return rows[0]?.c ?? 0;
}

export async function getLiveSession(deviceId: string) {
  const rows = await query<{ session_id: string; profile_id: string }>(
    `SELECT session_id, profile_id FROM analytics.live_sessions
     WHERE project_id = $1 AND device_id = $2`,
    [PROJECT_ID, deviceId],
  );
  return rows[0] ?? null;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
export async function ensureFixtures() {
  scenario('setup: project + client');
  try {
    await query(
      `INSERT INTO organizations (id, name, "createdAt", "updatedAt")
       VALUES ($1, 'OpenPanel Dev', now(), now()) ON CONFLICT (id) DO NOTHING`,
      [ORG_ID],
    );
    await query(
      `INSERT INTO projects (id, name, "organizationId", "createdAt", "updatedAt")
       VALUES ($1, 'E2E Sessions', $2, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [PROJECT_ID, ORG_ID],
    );
    await query(
      `INSERT INTO clients (id, name, "organizationId", "projectId", type, "ignoreCorsAndSecret", secret, "createdAt", "updatedAt")
       VALUES ($1, 'e2e', $2, $3, 'write', true, NULL, now(), now())
       ON CONFLICT (id) DO UPDATE SET "ignoreCorsAndSecret" = true, "projectId" = EXCLUDED."projectId"`,
      [CLIENT_ID, ORG_ID, PROJECT_ID],
    );
    check('fixtures ready', true);
  } catch (error) {
    check('fixtures ready', false, (error as Error).message);
    throw error;
  }
}

export async function preflight() {
  scenario('preflight');
  const api = await fetch(`${API_URL}/`)
    .then((r) => r.ok)
    .catch(() => false);
  check(`api reachable at ${API_URL}`, !!api);
  const worker = await fetch(`${WORKER_URL}/`)
    .then(() => true)
    .catch(() => false);
  check(`worker reachable at ${WORKER_URL}`, !!worker);
  if (!(api && worker)) {
    throw new Error('Stack not reachable — start it with `wrangler dev` first (see README.md).');
  }
  if (SESSION_TIMEOUT_MS > 60_000) {
    console.warn(
      `\n⚠ SESSION_TIMEOUT_MS=${SESSION_TIMEOUT_MS}ms — this run will be slow.\n` +
        '  Re-run the stack AND the harness with e.g. SESSION_TIMEOUT_MS=4000.',
    );
  }
}

/** Run `fn` over `items` with at most `concurrency` in flight. */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) {
          return;
        }
        await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
}

export async function shutdown(failed: number): Promise<never> {
  await pool.end().catch(() => undefined);
  process.exit(failed ? 1 : 0);
}
