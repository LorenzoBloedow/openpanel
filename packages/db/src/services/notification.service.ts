import { stripLeadingAndTrailingSlashes } from '@openpanel/common';
import { notificationQueue } from '@openpanel/queue';
import { cacheable } from '@openpanel/redis';
import type { IChartEvent, IChartEventFilter } from '@openpanel/validation';
import { pathOr } from 'ramda';
import {
  db,
  type Integration,
  type Notification,
  type Prisma,
} from '../prisma-client';
import type {
  IServiceCreateEventPayload,
  IServiceEvent,
} from './event.service';
import { matchEvent } from './event-match';
import { getProfileById } from './profile.service';
import { getProjectByIdCached } from './project.service';

export { matchEvent } from './event-match';

type ICreateNotification = Pick<
  Notification,
  | 'projectId'
  | 'title'
  | 'message'
  | 'integrationId'
  | 'payload'
  | 'notificationRuleId'
>;

export type INotificationPayload =
  | {
      type: 'event';
      event: IServiceCreateEventPayload;
    }
  | {
      type: 'funnel';
      funnel: IServiceEvent[];
    };

export const APP_NOTIFICATION_INTEGRATION_ID = 'app';
export const EMAIL_NOTIFICATION_INTEGRATION_ID = 'email';

export const BASE_INTEGRATIONS: Integration[] = [
  {
    id: APP_NOTIFICATION_INTEGRATION_ID,
    name: 'Website',
    createdAt: new Date(),
    updatedAt: new Date(),
    config: {
      type: APP_NOTIFICATION_INTEGRATION_ID,
    },
    organizationId: '',
    projectId: null,
  },
  {
    id: EMAIL_NOTIFICATION_INTEGRATION_ID,
    name: 'Email',
    createdAt: new Date(),
    updatedAt: new Date(),
    config: {
      type: EMAIL_NOTIFICATION_INTEGRATION_ID,
    },
    organizationId: '',
    projectId: null,
  },
];

export const isBaseIntegration = (id: string) =>
  BASE_INTEGRATIONS.find((i) => i.id === id);

export type INotificationRuleCached = Awaited<
  ReturnType<typeof getNotificationRulesByProjectId>
>[number];
export const getNotificationRulesByProjectId = cacheable(
  'getNotificationRulesByProjectId',
  (projectId: string) => {
    return db.notificationRule.findMany({
      where: {
        projectId,
      },
      select: {
        id: true,
        name: true,
        sendToApp: true,
        sendToEmail: true,
        config: true,
        template: true,
        integrations: {
          select: {
            id: true,
          },
        },
      },
    });
  },
  60 * 24,
  { cacheEmptyArray: true }
);

function getIntegration(integrationId: string | null) {
  if (integrationId === APP_NOTIFICATION_INTEGRATION_ID) {
    return {
      integrationId: null,
      sendToApp: true,
      sendToEmail: false,
    };
  }

  if (integrationId === EMAIL_NOTIFICATION_INTEGRATION_ID) {
    return {
      integrationId: null,
      sendToApp: false,
      sendToEmail: true,
    };
  }

  return {
    sendToApp: false,
    sendToEmail: false,
    integrationId,
  };
}

function stripNullChars<T>(value: T): T {
  if (typeof value === 'string') {
    return value.split('\u0000').join('') as T;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripNullChars) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, stripNullChars(v)])
    ) as T;
  }
  return value;
}

export async function createNotification(notification: ICreateNotification) {
  const data: Prisma.NotificationUncheckedCreateInput = {
    title: notification.title,
    message: notification.message,
    projectId: notification.projectId,
    payload: stripNullChars(notification.payload) || undefined,
    ...getIntegration(notification.integrationId),
    notificationRuleId: notification.notificationRuleId,
  };

  // Only create notifications for app
  if (data.sendToApp) {
    await db.notification.create({
      data,
    });
  }

  return triggerNotification(data);
}

export function triggerNotification(
  notification: Prisma.NotificationUncheckedCreateInput
) {
  return notificationQueue.add('sendNotification', {
    type: 'sendNotification',
    payload: {
      notification,
    },
  });
}

function notificationTemplateEvent({
  payload,
  rule,
}: {
  payload: IServiceCreateEventPayload;
  rule: INotificationRuleCached;
}) {
  if (!rule.template) {
    return `You received a new "${payload.name}" event`;
  }
  let template = rule.template
    .replaceAll('$EVENT_NAME', payload.name)
    .replaceAll('$RULE_NAME', rule.name)
    .replaceAll('{{rule_name}}', rule.name);

  // Replace all {{xxx}} placeholders with their values
  const placeholderMatches = template.match(/{{[^}]+}}/g) || [];
  for (const match of placeholderMatches) {
    const path = match.slice(2, -2); // Remove {{ and }}
    const value = pathOr('', path.split('.'), payload);

    if (value) {
      template = template.replaceAll(
        match,
        typeof value === 'object' ? JSON.stringify(value) : value
      );
    }
  }

  return template;
}

function notificationTemplateFunnel({
  events,
  rule,
}: {
  events: IServiceEvent[];
  rule: INotificationRuleCached;
}) {
  if (!rule.template) {
    return `Funnel "${rule.name}" completed`;
  }
  return rule.template
    .replaceAll('$EVENT_NAME', events.map((e) => e.name).join(' -> '))
    .replaceAll('$RULE_NAME', rule.name);
}

const PROFILE_TEMPLATE_REGEX = /{{profile\.[^}]*}}/;
export async function checkNotificationRulesForEvent(
  payload: IServiceCreateEventPayload
) {
  const project = await getProjectByIdCached(payload.projectId);
  const rules = await getNotificationRulesByProjectId(payload.projectId);

  // If profile is present in the template, add it to the payload (event)
  // so we can use it in the template
  if (
    payload.profileId &&
    rules.some((rule) => rule.template?.match(PROFILE_TEMPLATE_REGEX))
  ) {
    const profile = await getProfileById(payload.profileId, payload.projectId);
    if (profile) {
      (payload as any).profile = profile;
    }
  }

  await Promise.all(
    rules.flatMap((rule) => {
      if (rule.config.type === 'events') {
        const match = rule.config.events.find((event) => {
          return matchEvent(payload, event);
        });

        if (!match) {
          return [];
        }

        const notification = {
          title: notificationTemplateEvent({
            payload,
            rule,
          }),
          message: project?.name ? `Project: ${project?.name}` : '',
          projectId: payload.projectId,
          payload: {
            type: 'event',
            event: payload,
          },
        } as const;

        const promises = rule.integrations.map((integration) =>
          createNotification({
            ...notification,
            integrationId: integration.id,
            notificationRuleId: rule.id,
          })
        );

        if (rule.sendToApp) {
          promises.push(
            createNotification({
              ...notification,
              integrationId: APP_NOTIFICATION_INTEGRATION_ID,
              notificationRuleId: rule.id,
            })
          );
        }

        if (rule.sendToEmail) {
          promises.push(
            createNotification({
              ...notification,
              integrationId: EMAIL_NOTIFICATION_INTEGRATION_ID,
              notificationRuleId: rule.id,
            })
          );
        }

        return promises;
      }

      return [];
    })
  );
}

const isFunnelRule = (rule: INotificationRuleCached) =>
  rule.config.type === 'funnel';

export function getHasFunnelRules(rules: INotificationRuleCached[]) {
  return rules.some(isFunnelRule);
}

export function getFunnelRules(rules: INotificationRuleCached[]) {
  return rules.filter(isFunnelRule);
}

export async function checkNotificationRulesForSessionEnd(
  events: IServiceEvent[]
) {
  const sortedEvents = events.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );
  const projectId = sortedEvents[0]?.projectId;
  if (!projectId) {
    return null;
  }

  const [project, rules] = await Promise.all([
    getProjectByIdCached(projectId),
    getNotificationRulesByProjectId(projectId),
  ]);

  const funnelRules = getFunnelRules(rules);
  const notificationPromises = funnelRules.flatMap((rule) => {
    // Match funnel events
    let funnelIndex = 0;
    const matchedEvents: IServiceEvent[] = [];
    for (const event of sortedEvents) {
      if (matchEvent(event, rule.config.events[funnelIndex]!)) {
        matchedEvents.push(event);
        funnelIndex++;
        if (funnelIndex === rule.config.events.length) {
          break;
        }
      }
    }

    // If funnel not completed, skip this rule
    if (funnelIndex < rule.config.events.length) {
      return [];
    }

    // Create notification object
    const notification = {
      title: notificationTemplateFunnel({
        rule,
        events: matchedEvents,
      }),
      message: project?.name ? `Project: ${project?.name}` : '',
      projectId,
      payload: { type: 'funnel', funnel: matchedEvents } as const,
    };

    // Generate notification promises
    return [
      ...rule.integrations.map((integration) =>
        createNotification({
          ...notification,
          integrationId: integration.id,
          notificationRuleId: rule.id,
        })
      ),
      ...(rule.sendToApp
        ? [
            createNotification({
              ...notification,
              integrationId: APP_NOTIFICATION_INTEGRATION_ID,
              notificationRuleId: rule.id,
            }),
          ]
        : []),
      ...(rule.sendToEmail
        ? [
            createNotification({
              ...notification,
              integrationId: EMAIL_NOTIFICATION_INTEGRATION_ID,
              notificationRuleId: rule.id,
            }),
          ]
        : []),
    ];
  });

  await Promise.all(notificationPromises);
}
