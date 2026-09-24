/**
 * Messages for the LiveHub Durable Object (openpanel-api), the WebSocket
 * fan-out that replaced Redis pub/sub. Publishers (the ingest consumer,
 * jobs) call `publish` on the hub over RPC.
 */

export type LiveMessage =
  /** Events were ingested for the project (count of new rows). */
  | { type: 'events'; projectId: string; count: number }
  | { type: 'notification'; notification: Record<string, unknown> }
  | { type: 'organization'; message: Record<string, unknown> };

export type LiveHubScope = 'project' | 'org';

/** The hub's RPC surface. */
export interface LiveHubApi {
  publish(message: LiveMessage): Promise<void>;
}

/** One hub per project and per organization. */
export function liveHubName(scope: LiveHubScope, id: string): string {
  return `${scope}:${id}`;
}

/** The subset of a DurableObjectNamespace binding we use. */
export interface LiveHubNamespace {
  idFromName(name: string): unknown;
  get(id: never): unknown;
}

export function getLiveHub(
  namespace: LiveHubNamespace,
  scope: LiveHubScope,
  id: string,
): LiveHubApi {
  return namespace.get(
    namespace.idFromName(liveHubName(scope, id)) as never,
  ) as LiveHubApi;
}
