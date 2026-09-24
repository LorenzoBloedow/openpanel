import { type DbRoute, withRoute } from '@openpanel/runtime';

/**
 * Which connection route a call site uses when it differs from its entry
 * point's default (Hyperdrive for API requests, direct for queue consumers,
 * crons and workflows). Moving a call site between routes is a one-line
 * change here.
 *
 * The rule: Hyperdrive only where a user is waiting on the data. Writes that
 * don't have to be realtime take the direct connection to Neon's pooler, even
 * when they start in an API request.
 */
export const DB_ROUTES = {
  /** /track: dedupe + live-session lookup. The SDK waits on the session id. */
  trackLookup: 'hyperdrive',
  /** /track replay chunks: up to 2 MB, too big for a queue message. */
  replayInsert: 'direct',
  /** /import/events bulk inserts. */
  importEvents: 'direct',
} as const satisfies Record<string, DbRoute>;

export type DbRouteSite = keyof typeof DB_ROUTES;

/** Run `fn` on the route this call site is assigned to. */
export function withDbRoute<T>(site: DbRouteSite, fn: () => T): T {
  return withRoute(DB_ROUTES[site], fn);
}
