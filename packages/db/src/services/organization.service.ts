import { DateTime } from '@openpanel/common';
import { cacheable } from '@openpanel/redis';
import { anQuery, anQueryOne } from '../analytics/client';
import { gapFill } from '../analytics/fill';
import { sql } from '../analytics/sql';
import type { Invite, Prisma, ProjectAccess, User } from '../prisma-client';
import { db } from '../prisma-client';
import { getOrganizationAccess, getProjectAccess } from './access.service';
import type { IServiceProject } from './project.service';
export type IServiceOrganization = Awaited<
  ReturnType<typeof db.organization.findUniqueOrThrow>
>;
export type IServiceInvite = Invite;
export type IServiceMember = Prisma.MemberGetPayload<{
  include: { user: true };
}> & { access: ProjectAccess[] };
export type IServiceProjectAccess = ProjectAccess;

export async function getOrganizations(userId: string | null) {
  if (!userId) {
    return [];
  }

  const organizations = await db.organization.findMany({
    where: {
      members: {
        some: {
          userId,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return organizations;
}

export function getOrganizationById(slug: string) {
  return db.organization.findUniqueOrThrow({
    where: {
      id: slug,
    },
  });
}

export async function getOrganizationByProjectId(projectId: string) {
  const project = await db.project.findUniqueOrThrow({
    where: {
      id: projectId,
    },
    include: {
      organization: true,
    },
  });

  if (!project.organization) {
    return null;
  }

  return project.organization;
}

export const getOrganizationByProjectIdCached = cacheable(
  getOrganizationByProjectId,
  60 * 5
);

export async function getInvites(organizationId: string) {
  return db.invite.findMany({
    where: {
      organizationId,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

export async function getInviteById(inviteId: string) {
  const res = await db.invite.findUnique({
    where: {
      id: inviteId,
    },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  return {
    ...res,
    isExpired: res?.expiresAt && res.expiresAt < new Date(),
  };
}

export async function getMembers(organizationId: string) {
  const [members, access] = await Promise.all([
    db.member.findMany({
      where: {
        organizationId,
        userId: {
          not: null,
        },
      },
      include: {
        user: true,
      },
    }),
    db.projectAccess.findMany({
      where: {
        organizationId,
      },
    }),
  ]);

  return members.map((member) => ({
    ...member,
    access: access.filter((a) => a.userId === member.userId),
  }));
}

export async function getMember(organizationId: string, userId: string) {
  return db.member.findFirst({
    where: {
      organizationId,
      userId,
    },
  });
}

export async function connectUserToOrganization({
  user,
  inviteId,
}: {
  user: User;
  inviteId: string;
}) {
  // Use primary since before this we might have just created the invite
  // If we use replica it might not find the invite
  const invite = await db.invite.findUnique({
    where: {
      id: inviteId,
    },
  });

  if (!invite) {
    throw new Error('Invite not found');
  }

  if (process.env.ALLOW_INVITATION === 'false') {
    throw new Error('Invitations are not allowed');
  }

  if (invite.expiresAt < new Date()) {
    throw new Error('Invite expired');
  }

  // The invite might be consumed by a user who is already a member of the
  // organization (e.g. accepting it a second time). Upsert atomically against
  // the (organizationId, userId) unique constraint so concurrent consumption
  // cannot create duplicate membership rows; an existing membership is reused
  // unchanged and the invite is still consumed below.
  const member = await db.member.upsert({
    where: {
      organizationId_userId: {
        organizationId: invite.organizationId,
        userId: user.id,
      },
    },
    update: {},
    create: {
      organizationId: invite.organizationId,
      userId: user.id,
      role: invite.role,
      email: user.email,
      invitedById: invite.createdById,
    },
  });

  await getOrganizationAccess.clear({
    userId: user.id,
    organizationId: invite.organizationId,
  });

  if (invite.projectAccess.length > 0) {
    for (const grant of invite.projectAccess) {
      await getProjectAccess.clear({
        userId: user.id,
        projectId: grant.projectId,
      });
      await db.projectAccess.create({
        data: {
          projectId: grant.projectId,
          userId: user.id,
          organizationId: invite.organizationId,
          // The level the inviting admin chose, not a hardcoded default.
          level: grant.level,
        },
      });
    }
  }

  await db.invite.delete({
    where: {
      id: inviteId,
    },
  });

  return member;
}

/**
 * Get the total number of events during the
 * current subscription period for an organization
 */
export async function getOrganizationBillingEventsCount(
  organization: IServiceOrganization & { projects: IServiceProject[] }
) {
  // Trials have no Polar billing period; fall back to the trial window
  // (creation → trial end). Status stays 'trialing' even once expired.
  const isTrialStatus = organization.subscriptionStatus === 'trialing';
  const periodStart =
    organization.subscriptionCurrentPeriodStart ??
    (isTrialStatus ? organization.createdAt : null);
  const periodEnd =
    organization.subscriptionCurrentPeriodEnd ??
    (isTrialStatus ? organization.subscriptionEndsAt : null);

  if (!(periodStart && periodEnd) || organization.projects.length === 0) {
    return 0;
  }

  // Whole seconds, as the ClickHouse DateTime comparison had them.
  const row = await anQueryOne<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM analytics.events
    WHERE project_id = ANY(${organization.projects.map((project) => project.id)}::text[])
      AND created_at BETWEEN date_trunc('second', ${periodStart.toISOString()}::timestamptz)
        AND date_trunc('second', ${periodEnd.toISOString()}::timestamptz)
      AND name NOT IN ('session_start', 'session_end')
  `);
  return row?.count ?? 0;
}

// Lifetime event count for a set of projects (excluding session bookkeeping
// events). The onboarding emails use this instead of subscriptionPeriodEventsCount,
// which only refreshes when sessions end.
export async function getOrganizationEventsCount(projectIds: string[]) {
  if (projectIds.length === 0) {
    return 0;
  }

  const row = await anQueryOne<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM analytics.events
    WHERE project_id = ANY(${projectIds}::text[])
      AND name NOT IN ('session_start', 'session_end')
  `);
  return row?.count ?? 0;
}

// Events in a recent window, for organizations whose trial lapsed but whose
// SDKs never stopped. The lifetime count above says "you once used this"; this
// one says "you are using this right now", which is the only number that
// actually argues for a subscription.
export async function getOrganizationEventsCountSince(
  projectIds: string[],
  since: Date
) {
  if (projectIds.length === 0) {
    return 0;
  }

  // From the start of `since`'s UTC day, as before.
  const row = await anQueryOne<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM analytics.events
    WHERE project_id = ANY(${projectIds}::text[])
      AND name NOT IN ('session_start', 'session_end')
      AND created_at >= (${since.toISOString().slice(0, 10)}::date::timestamp AT TIME ZONE 'UTC')
  `);
  return row?.count ?? 0;
}

export async function getOrganizationBillingEventsCountSerie(
  organization: IServiceOrganization & { projects: { id: string }[] },
  {
    startDate,
    endDate,
  }: {
    startDate: Date;
    endDate: Date;
  }
) {
  // UTC days from startDate's day through endDate's day. Empty days are
  // filled up to, but not including, the end day (ClickHouse WITH FILL).
  const startDay = startDate.toISOString().slice(0, 10);
  const endDay = endDate.toISOString().slice(0, 10);
  const rows = await anQuery<{ count: number; day: string }>(sql`
    SELECT count(*)::int AS count, to_char(e.day, 'YYYY-MM-DD') AS day
    FROM (
      SELECT (created_at AT TIME ZONE 'UTC')::date AS day
      FROM analytics.events
      WHERE project_id = ANY(${organization.projects.map((project) => project.id)}::text[])
        AND name NOT IN ('session_start', 'session_end')
        AND created_at >= (${startDay}::date::timestamp AT TIME ZONE 'UTC')
        AND created_at < ((${endDay}::date + 1)::timestamp AT TIME ZONE 'UTC')
    ) e
    GROUP BY e.day
    ORDER BY e.day
  `);
  return gapFill(rows, {
    key: 'day',
    from: startDay,
    to: endDay,
    unit: 'day',
    format: 'date',
    fill: (day) => ({ count: 0, day }),
  });
}

export const getOrganizationBillingEventsCountSerieCached = cacheable(
  getOrganizationBillingEventsCountSerie,
  60 * 10
);

export async function getOrganizationSubscriptionChartEndDate(
  projectId: string,
  endDate: string
) {
  const organization = await getOrganizationByProjectIdCached(projectId);
  if (!organization) {
    return null;
  }
  // If the current period end date is after the subscription chart end date, we need to use the subscription chart end date
  if (
    organization.subscriptionChartEndDate &&
    new Date(endDate) > organization.subscriptionChartEndDate
  ) {
    return DateTime.fromJSDate(organization.subscriptionChartEndDate)
      .setZone(organization.timezone || DEFAULT_TIMEZONE)
      .toFormat('yyyy-MM-dd HH:mm:ss');
  }

  return endDate;
}

const DEFAULT_TIMEZONE = 'UTC';

export async function getSettingsForOrganization(organizationId: string) {
  const organization = await db.organization.findUniqueOrThrow({
    where: {
      id: organizationId,
    },
  });

  return {
    timezone: organization.timezone || DEFAULT_TIMEZONE,
  };
}

export async function getSettingsForProject(projectId: string) {
  const project = await db.project.findUniqueOrThrow({
    where: {
      id: projectId,
    },
    include: {
      organization: true,
    },
  });

  return {
    timezone: project.organization.timezone || DEFAULT_TIMEZONE,
  };
}
