/**
 * Session correctness E2E.
 *
 * Drives the REAL stack (wrangler dev: openpanel-api + openpanel-worker)
 * over HTTP and asserts the resulting state in Postgres through the full
 * lifecycle — open, extend, close (via reaper AND via boundary), replay,
 * identify — including live-session cleanup.
 *
 * Run (shrink the idle window; start the stack with the SAME value): see
 * README.md.
 *
 * For a high-volume drain test see session-stress.ts (`e2e:sessions:stress`).
 */

import {
  API_URL,
  CLIENT_ID,
  check,
  countByName,
  ensureFixtures,
  getLiveSession,
  IDLE_WAIT_MS,
  PROJECT_ID,
  pollUntil,
  preflight,
  query,
  runId,
  SESSION_TIMEOUT_MS,
  scenario,
  screenView,
  shutdown,
  sleep,
  summarize,
  track,
  triggerReaper,
  UA,
  WORKER_URL,
} from './lib';

const ipFor = (block: number) =>
  `10.${Math.floor(runId / 65_536) % 256}.${block}.${runId % 256 || 1}`;

async function scenarioSingleSession() {
  scenario('single session → reaper close → cleanup');
  const ip = ipFor(1);

  const first = await screenView(ip, '/a');
  await screenView(ip, '/b');
  await screenView(ip, '/c');
  const { deviceId, sessionId } = first;
  check('track returned a sessionId', !!sessionId, `got '${sessionId}'`);

  const live = await pollUntil(async () => {
    const row = await getLiveSession(deviceId);
    return row?.session_id === sessionId ? row : null;
  });
  check('postgres: live session row with matching id', !!live);

  const starts = await pollUntil(async () => {
    const c = await countByName([sessionId], 'session_start');
    return c > 0 ? c : null;
  });
  check('postgres: exactly one session_start', starts === 1, `got ${starts}`);
  const views = await pollUntil(async () => {
    const c = await countByName([sessionId], 'screen_view');
    return c >= 3 ? c : null;
  });
  check('postgres: 3 screen_views ingested', views === 3, `got ${views}`);

  console.log(`   …waiting ${IDLE_WAIT_MS}ms for idle window, then reaping`);
  await sleep(IDLE_WAIT_MS);
  await triggerReaper();

  const ends = await pollUntil(async () => {
    const c = await countByName([sessionId], 'session_end');
    return c > 0 ? c : null;
  });
  check('postgres: exactly one session_end', ends === 1, `got ${ends}`);

  const sessionRow = await pollUntil(async () => {
    const rows = await query<{ is_bounce: boolean; screen_view_count: number }>(
      'SELECT is_bounce, screen_view_count FROM analytics.sessions WHERE project_id = $1 AND id = $2',
      [PROJECT_ID, sessionId],
    );
    return rows[0] ?? null;
  });
  check('postgres: sessions row present', !!sessionRow);
  check(
    'postgres: session not a bounce (3 screen_views)',
    sessionRow?.is_bounce === false,
    `is_bounce=${sessionRow?.is_bounce}`,
  );
  check(
    'postgres: screen_view_count is 3',
    sessionRow?.screen_view_count === 3,
    `${sessionRow?.screen_view_count}`,
  );

  const cleaned = await pollUntil(async () =>
    (await getLiveSession(deviceId)) === null ? true : null,
  );
  check('postgres: live session removed after close', !!cleaned);

  await triggerReaper();
  await sleep(1000);
  check(
    'postgres: a second reaper run emits no second session_end',
    (await countByName([sessionId], 'session_end')) === 1,
  );
}

async function scenarioBoundary() {
  scenario('boundary split → first session closes, second opens');
  const ip = ipFor(2);

  const a = await screenView(ip, '/x');
  // Let the consumer apply the first event before the gap.
  await pollUntil(async () =>
    (await countByName([a.sessionId], 'session_start')) > 0 ? true : null,
  );
  console.log(`   …waiting ${IDLE_WAIT_MS}ms so the next event crosses the boundary`);
  await sleep(IDLE_WAIT_MS);
  const b = await screenView(ip, '/y');

  check(
    'second event opened a NEW session id',
    a.sessionId !== b.sessionId && !!b.sessionId,
    `${a.sessionId} vs ${b.sessionId}`,
  );

  const startsB = await pollUntil(async () =>
    (await countByName([b.sessionId], 'session_start')) > 0 ? true : null,
  );
  check('postgres: session_start for second session', !!startsB);
  const endsA = await pollUntil(async () =>
    (await countByName([a.sessionId], 'session_end')) > 0 ? true : null,
  );
  check('postgres: first session got a session_end', !!endsA);
  check(
    'postgres: exactly one session_end for the first session',
    (await countByName([a.sessionId], 'session_end')) === 1,
  );
}

async function scenarioNonScreenViewFirst() {
  scenario('session opened by a non-screen_view event');
  const ip = ipFor(5);

  // First (and only) event is a custom event with no __path.
  const { deviceId, sessionId } = await track(
    { type: 'track', payload: { name: 'purchase', properties: { __ip: ip } } },
    ip,
  );
  check('track returned a sessionId for a non-screen_view first event', !!sessionId);

  const starts = await pollUntil(async () =>
    (await countByName([sessionId], 'session_start')) > 0 ? true : null,
  );
  check('postgres: session_start emitted for a custom-event session', !!starts);

  console.log(`   …waiting ${IDLE_WAIT_MS}ms for idle window, then reaping`);
  await sleep(IDLE_WAIT_MS);
  await triggerReaper();

  const ends = await pollUntil(async () =>
    (await countByName([sessionId], 'session_end')) > 0 ? true : null,
  );
  check('postgres: session_end emitted (closes normally)', !!ends);

  const row = await pollUntil(async () => {
    const rows = await query<{
      screen_view_count: number;
      event_count: number;
      is_bounce: boolean;
    }>(
      'SELECT screen_view_count, event_count, is_bounce FROM analytics.sessions WHERE project_id = $1 AND id = $2',
      [PROJECT_ID, sessionId],
    );
    return rows[0] ?? null;
  });
  check('postgres: screen_view_count is 0', row?.screen_view_count === 0, `${row?.screen_view_count}`);
  check('postgres: event_count is 1', row?.event_count === 1, `${row?.event_count}`);
  check('postgres: is_bounce is true (no pageviews)', row?.is_bounce === true, `is_bounce=${row?.is_bounce}`);

  const cleaned = await pollUntil(async () =>
    (await getLiveSession(deviceId)) === null ? true : null,
  );
  check('postgres: live session cleaned up after close', !!cleaned);
}

async function scenarioReplay() {
  scenario('replay chunk files under the echoed session id');
  const ip = ipFor(3);

  const { sessionId } = await screenView(ip, '/replay');
  await track(
    {
      type: 'replay',
      payload: {
        sessionId,
        chunk_index: 0,
        events_count: 1,
        is_full_snapshot: true,
        started_at: new Date(runId).toISOString(),
        ended_at: new Date(runId + 1000).toISOString(),
        payload: '[]',
      },
    },
    ip,
  );

  // Replay chunks are written synchronously on the direct route.
  const rows = await query<{ c: number }>(
    'SELECT count(*)::int AS c FROM analytics.session_replay_chunks WHERE project_id = $1 AND session_id = $2',
    [PROJECT_ID, sessionId],
  );
  check('postgres: replay chunk stored under the session id', rows[0]?.c === 1, `got ${rows[0]?.c}`);
}

async function scenarioIdentify() {
  scenario('identified visit → live session profile + profile_id on events');
  const ip = ipFor(4);
  const profileId = `e2e-user-${runId}`;

  const { deviceId, sessionId } = await screenView(ip, '/account');
  await track(
    {
      type: 'track',
      payload: { name: 'signed_in', profileId, properties: { __ip: ip } },
    },
    ip,
  );

  const stitched = await pollUntil(async () =>
    (await getLiveSession(deviceId))?.profile_id === profileId ? true : null,
  );
  check('postgres: live session carries the profile id', !!stitched);

  const profiled = await pollUntil(async () => {
    const rows = await query<{ c: number }>(
      'SELECT count(*)::int AS c FROM analytics.events WHERE project_id = $1 AND session_id = $2 AND profile_id = $3',
      [PROJECT_ID, sessionId, profileId],
    );
    return (rows[0]?.c ?? 0) > 0 ? true : null;
  });
  check('postgres: event carries the identified profile_id', !!profiled);

  await track(
    {
      type: 'identify',
      payload: { profileId, firstName: 'Ada', email: 'ada@example.com' },
    },
    ip,
  );
  const profile = await pollUntil(async () => {
    const rows = await query<{ first_name: string; email: string }>(
      'SELECT first_name, email FROM analytics.profiles WHERE project_id = $1 AND id = $2',
      [PROJECT_ID, profileId],
    );
    return rows[0]?.first_name === 'Ada' ? rows[0] : null;
  });
  check('postgres: identify upserted the profile', profile?.email === 'ada@example.com');
}

async function scenarioDuplicate() {
  scenario('duplicate request within 100 ms is dropped');
  // A public address: private ones don't count as a client IP, and the
  // dedupe only applies to browser requests with an IP, origin and client id.
  const ip = `203.0.113.${runId % 250 || 1}`;
  const body = {
    type: 'track',
    payload: {
      name: 'dup_check',
      properties: { __path: 'https://e2e.test/dup', __ip: ip, run: runId },
    },
  };
  const headers = {
    'content-type': 'application/json',
    'openpanel-client-id': CLIENT_ID,
    'user-agent': UA,
    'x-client-ip': ip,
    origin: 'https://e2e.test',
  };
  const [r1, r2] = await Promise.all([
    fetch(`${API_URL}/track`, { method: 'POST', headers, body: JSON.stringify(body) }),
    fetch(`${API_URL}/track`, { method: 'POST', headers, body: JSON.stringify(body) }),
  ]);
  const texts = [await r1.text(), await r2.text()];
  check(
    'one of two identical concurrent requests is a duplicate',
    texts.filter((text) => text === 'Duplicate event').length === 1,
    texts.join(' | '),
  );
}

async function main() {
  console.log(
    `Session E2E — api=${API_URL} worker=${WORKER_URL} timeout=${SESSION_TIMEOUT_MS}ms project=${PROJECT_ID}`,
  );
  await preflight();
  await ensureFixtures();
  await scenarioSingleSession();
  await scenarioBoundary();
  await scenarioNonScreenViewFirst();
  await scenarioReplay();
  await scenarioIdentify();
  await scenarioDuplicate();
  await shutdown(summarize());
}

main().catch(async (error) => {
  console.error('\nFATAL:', error);
  await shutdown(1);
});
