import { db, getAnalyticsOverviewCore } from '@openpanel/db';
import { type EmailData, sendEmail } from '@openpanel/email';
import type { ILogger } from '@openpanel/logger';

/**
 * The weekly digest (Mondays): week-over-week stats and the project's
 * email-worthy insights, mailed to the organization's members. Self-hosted
 * on Cloudflare: every project with enough events qualifies (no billing
 * state), and there is no AI-written narrative.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// The digest is the main "value without logging in" touchpoint; quiet
// projects are still skipped per send (zero visitors).
const MIN_EVENTS = 100;
const MAX_INSIGHTS = 5;

type DigestData = EmailData<'weekly-digest'>;
interface ProjectRow {
  id: string;
  name: string;
  organizationId: string;
}

function formatCount(n: number): string {
  return Math.round(n).toLocaleString();
}

function pctDelta(
  current: number,
  previous: number
): { delta?: string; direction: 'up' | 'down' | 'flat' } {
  if (previous <= 0) {
    return { direction: 'flat' };
  }
  const pct = ((current - previous) / previous) * 100;
  const direction = pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat';
  const sign = pct >= 0 ? '+' : '';
  return { delta: `${sign}${pct.toFixed(0)}%`, direction };
}

function ppDelta(
  current: number,
  previous: number
): { delta?: string; direction: 'up' | 'down' | 'flat' } {
  const diff = current - previous;
  const direction = diff > 0.5 ? 'up' : diff < -0.5 ? 'down' : 'flat';
  const sign = diff >= 0 ? '+' : '';
  return { delta: `${sign}${diff.toFixed(0)}pp`, direction };
}

function formatRange(startMs: number, endMs: number): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const start = new Date(startMs).toLocaleDateString('en-US', opts);
  const end = new Date(endMs).toLocaleDateString('en-US', {
    ...opts,
    year: 'numeric',
  });
  return `${start} – ${end}`;
}

/**
 * Assemble the digest payload for one project (no sending). Returns `skipped`
 * with a reason when there's nothing worth mailing — unless `force` is set.
 */
async function buildDigestData(
  project: ProjectRow,
  dashboardBaseUrl: string,
  opts: { force?: boolean } = {}
): Promise<{ skipped?: string; data?: DigestData }> {
  const now = Date.now();
  const curStart = now - 7 * DAY_MS;
  const prevStart = now - 14 * DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString();

  const [cur, prev] = await Promise.all([
    getAnalyticsOverviewCore({
      projectId: project.id,
      startDate: iso(curStart),
      endDate: iso(now),
      interval: 'day',
    }),
    getAnalyticsOverviewCore({
      projectId: project.id,
      startDate: iso(prevStart),
      endDate: iso(curStart),
      interval: 'day',
    }),
  ]);

  const c = cur.summary;
  const p = prev.summary;

  if (!opts.force && c.unique_visitors === 0) {
    return { skipped: 'no visitors in the last 7 days' };
  }

  const stats = [
    {
      label: 'visitors',
      value: formatCount(c.unique_visitors),
      ...pctDelta(c.unique_visitors, p.unique_visitors),
    },
    {
      label: 'sessions',
      value: formatCount(c.total_sessions),
      ...pctDelta(c.total_sessions, p.total_sessions),
    },
    {
      label: 'pageviews',
      value: formatCount(c.total_screen_views),
      ...pctDelta(c.total_screen_views, p.total_screen_views),
    },
    {
      label: 'bounce rate',
      value: `${Math.round(c.bounce_rate)}%`,
      ...ppDelta(c.bounce_rate, p.bounce_rate),
    },
  ];

  const insightRows = await db.projectInsight.findMany({
    where: {
      projectId: project.id,
      state: 'active',
      emailWorthy: true,
      windowKind: { in: ['rolling_7d'] },
    },
    orderBy: [
      { relevanceScore: { sort: 'desc', nulls: 'last' } },
      { impactScore: 'desc' },
    ],
    take: MAX_INSIGHTS,
    select: { title: true, aiSummary: true, summary: true },
  });

  const insights = insightRows.map((i) => ({
    title: i.aiSummary ?? i.title,
    summary: i.summary ?? undefined,
  }));

  const dateRange = formatRange(curStart, now);

  const dashboardUrl = `${dashboardBaseUrl}/${project.organizationId}/${project.id}`;

  return {
    data: {
      projectName: project.name,
      dashboardUrl,
      dateRange,
      stats,
      insights,
    },
  };
}

async function recipientsForOrg(organizationId: string): Promise<string[]> {
  const members = await db.member.findMany({
    where: { organizationId },
    select: { email: true },
  });
  return [...new Set(members.map((member) => member.email).filter(Boolean))];
}

/** Projects the Monday cron fans a digest job out to. */
export async function listDigestProjects(): Promise<string[]> {
  const projects = await db.project.findMany({
    where: { deleteAt: null, eventsCount: { gt: MIN_EVENTS } },
    select: { id: true },
  });
  return projects.map((project) => project.id);
}

/** One project's digest. `sendEmail` skips unsubscribed recipients. */
export async function weeklyDigestProjectJob(
  projectId: string,
  env: Env,
  logger: ILogger,
): Promise<void> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, organizationId: true },
  });
  if (!project) {
    return;
  }
  const { skipped, data } = await buildDigestData(project, env.DASHBOARD_URL);
  if (skipped || !data) {
    logger.info({ projectId, skipped }, 'Weekly digest skipped');
    return;
  }
  const emails = await recipientsForOrg(project.organizationId);
  for (const to of emails) {
    await sendEmail('weekly-digest', { to, data });
  }
  logger.info({ projectId, recipients: emails.length }, 'Weekly digest sent');
}
