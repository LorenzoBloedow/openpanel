import { DurableObject } from 'cloudflare:workers';
import { anQueryOne } from '@openpanel/db/src/analytics/client';
import { sql } from '@openpanel/db/src/analytics/sql';
import { setSuperJson } from '@openpanel/json';
import type { LiveHubApi, LiveMessage } from '@openpanel/queue/src/live';
import { runWithScope } from '@openpanel/runtime';

/**
 * The only Durable Object: WebSocket fan-out for the dashboard's live
 * views, replacing Redis pub/sub. One hub per project (`project:<id>`) and
 * per organization (`org:<id>`). It holds connections only — no data — and
 * uses the hibernation API, so idle sockets cost nothing.
 *
 * The API authenticates the upgrade and forwards it here with the channel;
 * the ingest consumer and jobs call `publish` over RPC.
 */

export const LIVE_CHANNELS = [
  'visitors',
  'events',
  'notifications',
  'organization',
] as const;

export type LiveChannel = (typeof LIVE_CHANNELS)[number];

export function isLiveChannel(value: unknown): value is LiveChannel {
  return (LIVE_CHANNELS as readonly unknown[]).includes(value);
}

const VISITOR_WINDOW_MS = 5 * 60 * 1000;
/** One visitor-count query per hub per few seconds, shared by all sockets. */
const VISITOR_COUNT_TTL_MS = 5 * 1000;

export class LiveHub extends DurableObject<Env> implements LiveHubApi {
  private visitorCount: { value: number; at: number } | undefined;

  override fetch(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const channel = new URL(request.url).searchParams.get('channel');
    if (!isLiveChannel(channel)) {
      return new Response('Unknown channel', { status: 400 });
    }
    // biome-ignore lint/correctness/noUndeclaredVariables: a workerd global
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [channel]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async publish(message: LiveMessage): Promise<void> {
    switch (message.type) {
      case 'events': {
        this.broadcast('events', setSuperJson({ count: message.count }));
        if (this.ctx.getWebSockets('visitors').length > 0) {
          const count = await this.getVisitorCount(message.projectId);
          this.broadcast('visitors', String(count));
        }
        return;
      }
      case 'notification':
        this.broadcast('notifications', setSuperJson(message.notification));
        return;
      case 'organization':
        this.broadcast('organization', setSuperJson(message.message));
        return;
      default:
        return;
    }
  }

  /** Number of open sockets per channel (health and tests). */
  connections(): Record<LiveChannel, number> {
    return Object.fromEntries(
      LIVE_CHANNELS.map((channel) => [
        channel,
        this.ctx.getWebSockets(channel).length,
      ]),
    ) as Record<LiveChannel, number>;
  }

  private broadcast(channel: LiveChannel, data: string) {
    for (const socket of this.ctx.getWebSockets(channel)) {
      try {
        socket.send(data);
      } catch {
        // The socket is closing; the runtime drops it.
      }
    }
  }

  private async getVisitorCount(projectId: string): Promise<number> {
    const now = Date.now();
    if (this.visitorCount && now - this.visitorCount.at < VISITOR_COUNT_TTL_MS) {
      return this.visitorCount.value;
    }
    try {
      const row = await runWithScope(
        { env: this.env, ctx: this.ctx, route: 'hyperdrive' },
        () =>
          anQueryOne<{ count: number }>(sql`
            SELECT COUNT(DISTINCT profile_id)::int AS count
            FROM analytics.events
            WHERE project_id = ${projectId}
              AND profile_id <> ''
              AND created_at >= ${new Date(now - VISITOR_WINDOW_MS).toISOString()}::timestamptz
          `),
      );
      this.visitorCount = { value: row?.count ?? 0, at: now };
      return this.visitorCount.value;
    } catch {
      return 0;
    }
  }

  override webSocketMessage(): void {
    // The dashboard never sends anything.
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string) {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  override webSocketError(socket: WebSocket) {
    try {
      socket.close(1011, 'error');
    } catch {
      // Already closed.
    }
  }
}
