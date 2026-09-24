/**
 * Realtime fan-out without Redis pub/sub.
 *
 * Publishers (the events queue consumer, notification jobs) call
 * `publishEvent`, which forwards the message over RPC to the `LiveHub`
 * Durable Object for the project or organization. The hub holds the
 * dashboard's WebSockets (hibernation API) and broadcasts to them. It keeps
 * no data of its own — everything durable lives in Postgres.
 */
import type { Prisma } from '@openpanel/db';
import { getEnv } from '@openpanel/runtime';

export type IPublishChannels = {
  organization: {
    subscription_updated: {
      organizationId: string;
    };
  };
  events: {
    batch: { projectId: string; count: number };
  };
  notification: {
    created: Prisma.NotificationUncheckedCreateInput;
  };
};

/** Messages delivered to a LiveHub; the hub maps them onto socket channels. */
export type LiveHubMessage =
  | { channel: 'events'; projectId: string; count: number }
  | {
      channel: 'notifications';
      projectId: string;
      notification: Prisma.NotificationUncheckedCreateInput;
    }
  | { channel: 'organization'; organizationId: string };

/** The RPC surface of the LiveHub Durable Object (apps/api/src/durable/live-hub.ts). */
export interface LiveHubRpc {
  publish(message: LiveHubMessage): Promise<void>;
}

interface LiveHubNamespaceLike {
  idFromName(name: string): unknown;
  get(id: any): LiveHubRpc;
}

export function getLiveHubName(
  scope: 'project' | 'org',
  id: string,
): string {
  return `${scope}:${id}`;
}

export function getSubscribeChannel<Channel extends keyof IPublishChannels>(
  channel: Channel,
  type: keyof IPublishChannels[Channel],
) {
  return `${channel}:${String(type)}`;
}

function toLiveHubMessage<Channel extends keyof IPublishChannels>(
  channel: Channel,
  event: IPublishChannels[Channel][keyof IPublishChannels[Channel]],
): { hub: string; message: LiveHubMessage } | null {
  switch (channel) {
    case 'events': {
      const { projectId, count } =
        event as IPublishChannels['events']['batch'];
      return {
        hub: getLiveHubName('project', projectId),
        message: { channel: 'events', projectId, count },
      };
    }
    case 'notification': {
      const notification =
        event as IPublishChannels['notification']['created'];
      return {
        hub: getLiveHubName('project', notification.projectId),
        message: {
          channel: 'notifications',
          projectId: notification.projectId,
          notification,
        },
      };
    }
    case 'organization': {
      const { organizationId } =
        event as IPublishChannels['organization']['subscription_updated'];
      return {
        hub: getLiveHubName('org', organizationId),
        message: { channel: 'organization', organizationId },
      };
    }
    default:
      return null;
  }
}

/**
 * Forward an event to the LiveHub that owns its sockets. Best effort: live
 * updates are a UX nicety, so failures are logged and swallowed. Without a
 * `LIVE_HUB` binding (Node scripts, tests) this is a no-op.
 */
export async function publishEvent<Channel extends keyof IPublishChannels>(
  channel: Channel,
  type: keyof IPublishChannels[Channel],
  event: IPublishChannels[Channel][typeof type],
): Promise<void> {
  const namespace = getEnv<{ LIVE_HUB?: LiveHubNamespaceLike }>().LIVE_HUB;
  if (!namespace) {
    return;
  }
  const target = toLiveHubMessage(channel, event);
  if (!target) {
    return;
  }
  try {
    const stub = namespace.get(namespace.idFromName(target.hub));
    await stub.publish(target.message);
  } catch (error) {
    console.error('Failed to publish live event', {
      channel: getSubscribeChannel(channel, type),
      error,
    });
  }
}
