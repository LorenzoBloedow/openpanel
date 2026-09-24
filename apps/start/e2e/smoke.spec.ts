/**
 * Smoke test of the whole local stack, in one serial flow:
 *
 * 1. sign up, create a website project and read its client id;
 * 2. send events as the web SDK would, and pass onboarding's verification;
 * 3. the overview counts the visitors, sessions and page views;
 * 4. the realtime counter follows a new visitor over the WebSocket;
 * 5. funnel and retention reports render;
 * 6. a session replay plays.
 *
 * Screenshots of every step go to e2e/results/screenshots.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';

const DASHBOARD_URL = process.env.SMOKE_DASHBOARD_URL ?? 'http://localhost:3000';
const API_URL = process.env.SMOKE_API_URL ?? 'http://localhost:3333';
const SCREENSHOT_DIR = 'e2e/results/screenshots';

const SITE_DOMAIN = 'smoke.example.com';
const SITE_ORIGIN = `https://${SITE_DOMAIN}`;
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'Sm0ke-test-password!';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const REPLAY_TEXT = 'Hello from the smoke test';
/** Queue batches reach Postgres within seconds under wrangler dev. */
const INGEST_TIMEOUT_MS = 90_000;

interface Visitor {
  ip: string;
  userAgent: string;
  profileId?: string;
}

const anonymousVisitor: Visitor = {
  ip: '203.0.113.21',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};
const identifiedVisitor: Visitor = {
  ip: '203.0.113.22',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0',
  profileId: `smoke-user-${RUN_ID}`,
};
const lateVisitor: Visitor = {
  ip: '203.0.113.23',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
};

test.describe.configure({ mode: 'serial' });

let page: Page;
let clientId = '';
let projectId = '';
let projectPath = '';
let identifiedSessionId = '';

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

/**
 * Wait until React has hydrated `element`. Before that, a click submits the
 * server-rendered form natively (a GET that puts the fields in the URL).
 */
async function hydrated(element: Locator) {
  await expect
    .poll(() =>
      element.evaluate((node) =>
        Object.keys(node).some((key) => key.startsWith('__reactProps$')),
      ),
    )
    .toBe(true);
  return element;
}

async function screenshot(name: string) {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

/** POST /track the way the web SDK does. */
async function track(visitor: Visitor, body: unknown) {
  const response = await fetch(`${API_URL}/track`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: SITE_ORIGIN,
      'user-agent': visitor.userAgent,
      'cf-connecting-ip': visitor.ip,
      'openpanel-client-id': clientId,
      'openpanel-sdk-name': 'web',
      'openpanel-sdk-version': '1.0.0',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text) as { deviceId: string; sessionId: string };
}

function screenView(visitor: Visitor, path: string, referrer?: string) {
  return track(visitor, {
    type: 'track',
    payload: {
      name: 'screen_view',
      profileId: visitor.profileId,
      properties: {
        __path: `${SITE_ORIGIN}${path}`,
        __title: `Smoke ${path}`,
        ...(referrer ? { __referrer: referrer } : {}),
      },
    },
  });
}

/** A tRPC call with the signed-in page's session cookie. */
async function trpc<T>(procedure: string, input: unknown): Promise<T> {
  const response = await page.request.post(`${API_URL}/trpc/${procedure}`, {
    data: { json: input },
    headers: { origin: DASHBOARD_URL },
  });
  const text = await response.text();
  expect(response.ok(), text).toBe(true);
  return (JSON.parse(text) as { result: { data: { json: T } } }).result.data
    .json;
}

/**
 * The value of an overview metric card, e.g. "Unique Visitors", or NaN
 * while it loads. The card's lines are the label, the change indicator, the
 * value and the range ("Last 7 days").
 */
async function metric(label: string) {
  const card = page.getByRole('button', { name: new RegExp(`^${label}`) });
  const lines = (await card.innerText()).split('\n').map((line) => line.trim());
  const value = lines.find((line) => /^\d[\d,]*$/.test(line));
  return value ? Number(value.replaceAll(',', '')) : Number.NaN;
}

test('signs up and creates a website project', async () => {
  await page.goto('/onboarding');
  const createAccount = await hydrated(
    page.getByRole('button', { name: 'Create account' }),
  );
  await page.getByLabel('First name').fill('Smoke');
  await page.getByLabel('Last name').fill('Test');
  await page.getByLabel('Email').fill(`smoke-${RUN_ID}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await createAccount.click();

  await page.waitForURL(/\/onboarding\/project/);
  // The time zone picker shows the browser's zone once hydration has run;
  // anything typed before that re-render is lost.
  await expect(page.getByText('Europe/Stockholm').first()).toBeVisible();
  await page.getByPlaceholder('Eg. The Music Company').fill(`Smoke ${RUN_ID}`);
  await page.getByPlaceholder('Eg. The Music App').fill('Smoke Site');
  await page.getByRole('button', { name: 'Website' }).click();
  await page.getByPlaceholder('example.com').fill(SITE_DOMAIN);
  await screenshot('01-project');
  await page.getByRole('button', { name: 'Next' }).click();

  await page.waitForURL(/\/onboarding\/[^/]+\/connect/);
  projectId = page.url().match(/\/onboarding\/([^/]+)\/connect/)?.[1] ?? '';
  const clientButton = page.getByRole('button', { name: /^Client ID/ });
  clientId = (await clientButton.innerText()).match(UUID)?.[0] ?? '';
  expect(projectId).not.toBe('');
  expect(clientId).toMatch(UUID);
  // MCP isn't served on Cloudflare, so there is no token to show.
  await expect(page.getByText('MCP token')).toHaveCount(0);
  await screenshot('02-connect');
});

test('verifies the first events and opens the dashboard', async () => {
  await page.getByRole('link', { name: 'Next' }).click();
  await page.waitForURL(/\/onboarding\/[^/]+\/verify/);

  // An anonymous visitor from Google reads three pages.
  await screenView(anonymousVisitor, '/', 'https://www.google.com/');
  await screenView(anonymousVisitor, '/pricing');
  await screenView(anonymousVisitor, '/docs');

  // An identified visitor reads four pages and signs up.
  await track(identifiedVisitor, {
    type: 'identify',
    payload: {
      profileId: identifiedVisitor.profileId,
      firstName: 'Ada',
      lastName: 'Smoke',
      email: `ada-${RUN_ID}@example.com`,
    },
  });
  for (const path of ['/', '/pricing', '/docs', '/signup']) {
    const { sessionId } = await screenView(identifiedVisitor, path);
    identifiedSessionId = sessionId;
  }
  await track(identifiedVisitor, {
    type: 'track',
    payload: {
      name: 'sign_up',
      profileId: identifiedVisitor.profileId,
      properties: { __path: `${SITE_ORIGIN}/signup` },
    },
  });

  // "Your dashboard" unlocks once the project has received an event: it
  // loses the bare `pointer-events-none` class (`disabled:…` variants stay).
  const dashboardLink = page.getByRole('link', { name: 'Your dashboard' });
  await expect(dashboardLink).not.toHaveClass(/(^|\s)pointer-events-none(\s|$)/, {
    timeout: INGEST_TIMEOUT_MS,
  });
  await screenshot('03-verified');
  projectPath = new URL(
    (await dashboardLink.getAttribute('href')) ?? '',
    DASHBOARD_URL,
  ).pathname;
  await dashboardLink.click();
  await page.waitForURL((url) => url.pathname === projectPath);
});

test('counts visitors, sessions and page views on the overview', async () => {
  // Reload until the queue batch has landed; each load settles in a second.
  await expect(async () => {
    await page.goto(projectPath);
    await expect
      .poll(() => metric('Unique Visitors'), { timeout: 10_000 })
      .not.toBeNaN();
    expect(await metric('Unique Visitors')).toBe(2);
    expect(await metric('Sessions')).toBe(2);
    expect(await metric('Pageviews')).toBe(7);
  }).toPass({ timeout: INGEST_TIMEOUT_MS, intervals: [2000, 5000] });
  await screenshot('04-overview');
});

test('follows a new visitor on the realtime counter', async () => {
  const liveCounts: number[] = [];
  const visitorsSocket = page.waitForEvent('websocket', (socket) =>
    socket.url().includes(`/live/visitors/${projectId}`),
  );
  await page.goto(projectPath);
  (await visitorsSocket).on('framereceived', ({ payload }) => {
    const count = Number(payload);
    if (!Number.isNaN(count)) {
      liveCounts.push(count);
    }
  });

  // The worker publishes to the project's LiveHub Durable Object after each
  // queue batch, and the hub pushes the visitor count to the open sockets.
  // A batch that lands before the socket is accepted goes unseen, so the
  // new visitor keeps browsing until a count arrives.
  let pageViews = 0;
  await expect(async () => {
    pageViews += 1;
    await screenView(lateVisitor, `/blog/${pageViews}`);
    await expect.poll(() => liveCounts.at(-1), { timeout: 15_000 }).toBe(3);
  }).toPass({ timeout: INGEST_TIMEOUT_MS });

  // The header's live counter: a pulsing dot and an animated number, with
  // the exact count in its tooltip.
  const counter = page.locator('button:has(.animate-ping):has(number-flow-react)');
  await counter.hover();
  await expect(
    page.getByText('3 unique visitors last 5 minutes').first(),
  ).toBeVisible();
  await screenshot('05-realtime');
});

test('renders funnel and retention reports', async () => {
  const dashboard = await trpc<{ id: string }>('dashboard.create', {
    name: `Smoke ${RUN_ID}`,
    projectId,
  });
  const event = (id: string, name: string) => ({
    type: 'event',
    id,
    name,
    segment: 'event',
    filters: [],
  });
  const baseReport = {
    interval: 'day',
    range: '30d',
    breakdowns: [],
    previous: false,
    metric: 'sum',
    lineType: 'monotone',
  };

  const funnel = await trpc<{ id: string }>('report.create', {
    dashboardId: dashboard.id,
    report: {
      ...baseReport,
      name: 'Smoke funnel',
      chartType: 'funnel',
      series: [event('A', 'screen_view'), event('B', 'sign_up')],
      options: { type: 'funnel', funnelGroup: 'session_id', funnelWindow: 24 },
    },
  });
  await page.goto(`${projectPath}/reports/${funnel.id}`);
  // Three sessions viewed a page; one of them signed up.
  const funnelMetric = (label: string) =>
    page.getByText(label, { exact: true }).first().locator('..');
  await expect(funnelMetric('Conversion')).toContainText(/33\.3\s*%/);
  await expect(funnelMetric('Completed')).toContainText('1');
  await screenshot('06-funnel');

  const retention = await trpc<{ id: string }>('report.create', {
    dashboardId: dashboard.id,
    report: {
      ...baseReport,
      name: 'Smoke retention',
      chartType: 'retention',
      // A retention series names its events in its first filter.
      series: ['A', 'B'].map((id) => ({
        ...event(id, 'screen_view'),
        filters: [
          { id: `${id}-name`, name: 'name', operator: 'is', value: ['screen_view'] },
        ],
      })),
      options: { type: 'retention', criteria: 'on_or_after' },
    },
  });
  await page.goto(`${projectPath}/reports/${retention.id}`);
  // One identified profile, retained on its first day.
  await expect(page.getByText('Total profiles', { exact: true })).toBeVisible();
  await expect(page.getByText('Weighted Average', { exact: true })).toBeVisible();
  await screenshot('07-retention');
});

test('plays a session replay', async () => {
  // A minimal rrweb recording: meta, a full snapshot of a one-line page, and
  // a mouse move five seconds later so the replay has a length.
  const start = Date.now();
  const events = [
    {
      type: 4,
      data: { href: `${SITE_ORIGIN}/signup`, width: 1280, height: 720 },
      timestamp: start,
    },
    {
      type: 2,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            { type: 1, id: 2, name: 'html', publicId: '', systemId: '' },
            {
              type: 2,
              id: 3,
              tagName: 'html',
              attributes: {},
              childNodes: [
                { type: 2, id: 4, tagName: 'head', attributes: {}, childNodes: [] },
                {
                  type: 2,
                  id: 5,
                  tagName: 'body',
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 6,
                      tagName: 'h1',
                      attributes: {},
                      childNodes: [{ type: 3, id: 7, textContent: REPLAY_TEXT }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        initialOffset: { left: 0, top: 0 },
      },
      timestamp: start + 10,
    },
    {
      type: 3,
      data: { source: 1, positions: [{ x: 200, y: 120, id: 6, timeOffset: 0 }] },
      timestamp: start + 5000,
    },
  ];
  await track(identifiedVisitor, {
    type: 'replay',
    payload: {
      chunk_index: 0,
      events_count: events.length,
      is_full_snapshot: true,
      started_at: new Date(start).toISOString(),
      ended_at: new Date(start + 5000).toISOString(),
      payload: JSON.stringify(events),
      sessionId: identifiedSessionId,
    },
  });

  await page.goto(`${projectPath}/sessions/${identifiedSessionId}`);
  const play = page.getByRole('button', { name: 'Play' });
  await expect(play).toBeEnabled();
  await expect(
    page.frameLocator('#replay iframe').getByText(REPLAY_TEXT),
  ).toBeVisible();
  await play.click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await screenshot('08-replay');
});
