import { db } from '@openpanel/db';
import { getSessionEventPayloads } from '@openpanel/db/src/ingest/effects';
import { deserializeEventPayload } from '@openpanel/db/src/ingest/envelope';
import {
  checkNotificationRulesForEvent,
  checkNotificationRulesForSessionEnd,
} from '@openpanel/db/src/services/notification.service';
import type { IServiceEvent } from '@openpanel/db/src/services/event.service';
import { sendEmail } from '@openpanel/email';
import type { NotificationQueuePayload } from '@openpanel/queue';
import { getLiveHub } from '@openpanel/queue/src/live';
import { FeatureUnavailableError } from '@openpanel/runtime';

type Payload<T extends NotificationQueuePayload['type']> = Extract<
  NotificationQueuePayload,
  { type: T }
>['payload'];

/**
 * Deliver a notification: in-app (the project's LiveHub), or by email to
 * the organization's members. Slack, Discord and webhook integrations are
 * compiled out on Cloudflare.
 */
export async function sendNotificationJob(
  { notification }: Payload<'sendNotification'>,
  env: Env,
): Promise<void> {
  if (notification.sendToApp) {
    await getLiveHub(env.LIVE_HUB, 'project', notification.projectId).publish({
      type: 'notification',
      notification: notification as unknown as Record<string, unknown>,
    });
    return;
  }

  if (notification.sendToEmail) {
    const project = await db.project.findUniqueOrThrow({
      where: { id: notification.projectId },
      select: { name: true, organizationId: true },
    });
    const members = await db.member.findMany({
      where: {
        organizationId: project.organizationId,
        user: { deletedAt: null },
      },
      include: { user: { select: { email: true } } },
    });
    const emails = new Set(
      members.flatMap((member) => (member.user?.email ? [member.user.email] : [])),
    );
    for (const to of emails) {
      // Per-recipient unsubscribe (product_alerts) is handled by sendEmail.
      await sendEmail('notification-rule', {
        to,
        data: {
          title: notification.title,
          message: notification.message,
          projectName: project.name,
          dashboardUrl: `${env.DASHBOARD_URL}/${project.organizationId}/${notification.projectId}`,
        },
      });
    }
    return;
  }

  // Slack / Discord / webhook deliveries.
  throw new FeatureUnavailableError('integrations');
}

/** Freshly ingested events against the project's event rules. */
export async function checkEventRulesJob({
  events,
}: Payload<'checkEventRules'>): Promise<void> {
  for (const event of events) {
    const { id: _id, ...payload } = event;
    await checkNotificationRulesForEvent(
      deserializeEventPayload(payload as Parameters<typeof deserializeEventPayload>[0]),
    );
  }
}

/** Closed sessions against the project's funnel rules. */
export async function checkFunnelRulesJob({
  projectId,
  sessionIds,
}: Payload<'checkFunnelRules'>): Promise<void> {
  const sessions = await getSessionEventPayloads(projectId, sessionIds);
  for (const events of sessions.values()) {
    await checkNotificationRulesForSessionEnd(events as unknown as IServiceEvent[]);
  }
}
