import {
  getOrganizationBillingEventsCount,
  getOrganizationBillingEventsCountSerie,
  getOrganizationEventsCount,
  getOrganizationEventsCountSince,
} from '../../../src/services/organization.service';
import {
  getLastEventPerProject,
  getProjectEventsCount,
  listProjectsCore,
} from '../../../src/services/project.service';
import { GOLDEN_PROJECTS, type GoldenCase, type GoldenContext } from '../harness';
import { pid } from './pages.cases';

const DAY = 86_400_000;
const GOLDEN_IDS: string[] = Object.values(GOLDEN_PROJECTS).map((project) => project.id);

function shift(ctx: GoldenContext, days: number) {
  return new Date(ctx.anchor.getTime() + days * DAY);
}

type BillingOrganization = Parameters<typeof getOrganizationBillingEventsCount>[0];
type SerieOrganization = Parameters<typeof getOrganizationBillingEventsCountSerie>[0];

/**
 * The fields the billing counters read from an organization (the Prisma row
 * with its computed subscription fields, plus its projects). Built in memory:
 * with SELF_HOSTED the stored golden organizations have no billing period.
 */
function organization(fields: {
  projects: string[];
  subscriptionStatus?: string;
  subscriptionCurrentPeriodStart?: Date | null;
  subscriptionCurrentPeriodEnd?: Date | null;
  subscriptionEndsAt?: Date | null;
  createdAt: Date;
}) {
  return {
    id: 'golden-org-billing',
    name: 'Golden billing',
    subscriptionStatus: fields.subscriptionStatus ?? 'active',
    subscriptionCurrentPeriodStart: fields.subscriptionCurrentPeriodStart ?? null,
    subscriptionCurrentPeriodEnd: fields.subscriptionCurrentPeriodEnd ?? null,
    subscriptionEndsAt: fields.subscriptionEndsAt ?? null,
    createdAt: fields.createdAt,
    projects: fields.projects.map((id) => ({ id })),
  } as unknown as BillingOrganization & SerieOrganization;
}

export const group = 'counts';

export const cases: GoldenCase[] = [
  // project.service
  ...(['sthlm', 'ny', 'utc'] as const).map((project) => ({
    name: `getProjectEventsCount ${project}`,
    run: () => getProjectEventsCount(pid(project)),
  })),
  {
    name: 'getProjectEventsCount unknown project',
    run: () => getProjectEventsCount('golden-no-such-project'),
  },
  {
    // Instance-wide; only the golden projects are compared.
    name: 'getLastEventPerProject golden projects',
    run: async () => {
      const lastEvents = await getLastEventPerProject();
      return Object.fromEntries(
        [...lastEvents].filter(([projectId]) => GOLDEN_IDS.includes(projectId)),
      );
    },
  },
  {
    name: 'listProjectsCore root golden-org-sthlm',
    run: () =>
      listProjectsCore({
        clientType: 'root',
        organizationId: 'golden-org-sthlm',
        projectId: null,
      }),
  },
  {
    name: 'listProjectsCore read golden-ny',
    run: () =>
      listProjectsCore({ clientType: 'read', organizationId: 'golden-org-ny', projectId: pid('ny') }),
  },

  // organization.service: lifetime and windowed event counts
  {
    name: 'getOrganizationEventsCount all golden projects',
    run: () => getOrganizationEventsCount(GOLDEN_IDS),
  },
  {
    name: 'getOrganizationEventsCount ny and an unknown project',
    run: () => getOrganizationEventsCount([pid('ny'), 'golden-no-such-project']),
  },
  {
    name: 'getOrganizationEventsCount no projects',
    run: () => getOrganizationEventsCount([]),
  },
  {
    name: 'getOrganizationEventsCountSince all golden projects 7 days',
    run: (ctx) => getOrganizationEventsCountSince(GOLDEN_IDS, shift(ctx, -7)),
  },
  {
    // `since` is cut to its UTC day.
    name: 'getOrganizationEventsCountSince utc 1 day',
    run: (ctx) => getOrganizationEventsCountSince([pid('utc')], shift(ctx, -1)),
  },
  {
    name: 'getOrganizationEventsCountSince sthlm 45 days',
    run: (ctx) => getOrganizationEventsCountSince([pid('sthlm')], shift(ctx, -45)),
  },

  // Billing period counts
  {
    name: 'getOrganizationBillingEventsCount active period last 30 days',
    run: (ctx) =>
      getOrganizationBillingEventsCount(
        organization({
          projects: GOLDEN_IDS,
          subscriptionCurrentPeriodStart: shift(ctx, -30),
          subscriptionCurrentPeriodEnd: shift(ctx, 0),
          createdAt: shift(ctx, -90),
        }),
      ),
  },
  {
    name: 'getOrganizationBillingEventsCount trial window',
    run: (ctx) =>
      getOrganizationBillingEventsCount(
        organization({
          projects: [pid('sthlm'), pid('ny')],
          subscriptionStatus: 'trialing',
          subscriptionEndsAt: shift(ctx, 7),
          createdAt: shift(ctx, -14.5),
        }),
      ),
  },
  {
    name: 'getOrganizationBillingEventsCount without a period',
    run: (ctx) =>
      getOrganizationBillingEventsCount(
        organization({ projects: GOLDEN_IDS, createdAt: shift(ctx, -90) }),
      ),
  },
  {
    name: 'getOrganizationBillingEventsCount without projects',
    run: (ctx) =>
      getOrganizationBillingEventsCount(
        organization({
          projects: [],
          subscriptionCurrentPeriodStart: shift(ctx, -30),
          subscriptionCurrentPeriodEnd: shift(ctx, 0),
          createdAt: shift(ctx, -90),
        }),
      ),
  },
  {
    name: 'getOrganizationBillingEventsCountSerie all golden projects 30 days',
    run: (ctx) =>
      getOrganizationBillingEventsCountSerie(
        organization({ projects: GOLDEN_IDS, createdAt: shift(ctx, -90) }),
        { startDate: shift(ctx, -30), endDate: shift(ctx, 0) },
      ),
  },
  {
    name: 'getOrganizationBillingEventsCountSerie utc 7 days',
    run: (ctx) =>
      getOrganizationBillingEventsCountSerie(
        organization({ projects: [pid('utc')], createdAt: shift(ctx, -90) }),
        { startDate: shift(ctx, -7), endDate: shift(ctx, 0) },
      ),
  },
  {
    name: 'getOrganizationBillingEventsCountSerie sthlm before the data',
    run: (ctx) =>
      getOrganizationBillingEventsCountSerie(
        organization({ projects: [pid('sthlm')], createdAt: shift(ctx, -200) }),
        { startDate: shift(ctx, -90), endDate: shift(ctx, -80) },
      ),
  },
];
