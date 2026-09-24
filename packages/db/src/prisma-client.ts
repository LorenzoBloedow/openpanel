import { getSubscriptionState } from '@openpanel/payments/subscription-state';
import { type DbRoute, getRoute, getScopedResource } from '@openpanel/runtime';
import { PrismaPg } from '@prisma/adapter-pg';
// Node or workerd build of the same schema; see "imports" in package.json.
import { PrismaClient } from '#prisma-generated';
import { logger } from './logger';
import { getPool } from './pool';

export * from '#prisma-generated';

const subscriptionStateNeeds = {
  subscriptionStatus: true,
  subscriptionCanceledAt: true,
  subscriptionEndsAt: true,
  subscriptionPauseAtPeriodEnd: true,
} as const;

const createPrismaClient = (route: DbRoute) => {
  // emit: 'event' keeps the client from writing prisma:error lines straight
  // to stderr, so they flow through the structured logger instead.
  const client = new PrismaClient({
    adapter: new PrismaPg(getPool(route)),
    log: [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

  // $on only exists on the base client — keep it before $extends.
  client.$on('error', (event) => {
    logger.error({ target: event.target }, `prisma: ${event.message}`);
  });
  client.$on('warn', (event) => {
    logger.warn({ target: event.target }, `prisma: ${event.message}`);
  });

  const prisma = client.$extends({
    result: {
      organization: {
        subscriptionState: {
          needs: subscriptionStateNeeds,
          compute(org) {
            return getSubscriptionState(org);
          },
        },
        subscriptionStatus: {
          needs: { subscriptionStatus: true, subscriptionCanceledAt: true },
          compute(org) {
            if (process.env.SELF_HOSTED === 'true') {
              return 'active';
            }

            return org.subscriptionStatus || 'trialing';
          },
        },
        hasSubscription: {
          needs: subscriptionStateNeeds,
          compute(org) {
            const state = getSubscriptionState(org);
            return (
              state === 'active' ||
              state === 'canceling' ||
              state === 'pausing' ||
              state === 'paused' ||
              state === 'past_due' ||
              state === 'unpaid' ||
              state === 'incomplete'
            );
          },
        },
        slug: {
          needs: { id: true },
          compute(org) {
            return org.id;
          },
        },
        subscriptionChartEndDate: {
          needs: {
            subscriptionEndsAt: true,
            subscriptionPeriodEventsCountExceededAt: true,
          },
          compute(org) {
            if (process.env.SELF_HOSTED === 'true') {
              return null;
            }

            if (
              org.subscriptionEndsAt &&
              org.subscriptionPeriodEventsCountExceededAt
            ) {
              return org.subscriptionEndsAt >
                org.subscriptionPeriodEventsCountExceededAt
                ? org.subscriptionPeriodEventsCountExceededAt
                : org.subscriptionEndsAt;
            }

            if (org.subscriptionEndsAt) {
              return org.subscriptionEndsAt;
            }

            // Hedge against edge cases :D
            return new Date(Date.now() + 1000 * 60 * 60 * 24);
          },
        },
        isActive: {
          needs: subscriptionStateNeeds,
          compute(org) {
            const state = getSubscriptionState(org);
            return state === 'active' || state === 'self_hosted';
          },
        },
        isTrial: {
          needs: subscriptionStateNeeds,
          compute(org) {
            return getSubscriptionState(org) === 'trialing';
          },
        },
        isCanceled: {
          needs: subscriptionStateNeeds,
          compute(org) {
            return getSubscriptionState(org) === 'canceled';
          },
        },
        isWillBeCanceled: {
          needs: subscriptionStateNeeds,
          compute(org) {
            return getSubscriptionState(org) === 'canceling';
          },
        },
        isExpired: {
          needs: subscriptionStateNeeds,
          compute(org) {
            const state = getSubscriptionState(org);
            return state === 'expired' || state === 'trial_expired';
          },
        },
        isExceeded: {
          needs: {
            subscriptionPeriodEventsCount: true,
            subscriptionPeriodEventsLimit: true,
          },
          compute(org) {
            if (process.env.SELF_HOSTED === 'true') {
              return false;
            }

            return (
              org.subscriptionPeriodEventsCount >
              org.subscriptionPeriodEventsLimit
            );
          },
        },
        subscriptionCurrentPeriodStart: {
          needs: { subscriptionStartsAt: true, subscriptionInterval: true },
          compute(org) {
            if (process.env.SELF_HOSTED === 'true') {
              return null;
            }

            if (!org.subscriptionStartsAt) {
              return null;
            }

            if (org.subscriptionInterval === 'year') {
              const startDay = org.subscriptionStartsAt.getUTCDate();
              const now = new Date();
              return new Date(
                Date.UTC(
                  now.getUTCFullYear(),
                  now.getUTCMonth(),
                  startDay,
                  0,
                  0,
                  0,
                  0
                )
              );
            }

            return org.subscriptionStartsAt;
          },
        },
        subscriptionCurrentPeriodEnd: {
          needs: {
            subscriptionStartsAt: true,
            subscriptionEndsAt: true,
            subscriptionInterval: true,
          },
          compute(org) {
            if (process.env.SELF_HOSTED === 'true') {
              return null;
            }

            if (!org.subscriptionStartsAt) {
              return null;
            }

            if (org.subscriptionInterval === 'year') {
              const startDay = org.subscriptionStartsAt.getUTCDate();
              const now = new Date();
              return new Date(
                Date.UTC(
                  now.getUTCFullYear(),
                  now.getUTCMonth() + 1,
                  startDay - 1,
                  0,
                  0,
                  0,
                  0
                )
              );
            }

            return org.subscriptionEndsAt;
          },
        },
      },
    },
  });

  return prisma;
};

export type Database = ReturnType<typeof createPrismaClient>;

/** The Prisma client of the current scope and route, created on first use. */
export function getPrismaClient(route: DbRoute = getRoute()): Database {
  return getScopedResource(
    `prisma:${route}`,
    () => createPrismaClient(route),
    (client) => client.$disconnect(),
  );
}

/**
 * `db` keeps its old shape — `db.project.findMany(…)`, `db.$transaction(…)` —
 * but resolves the client lazily for the current invocation scope and its
 * connection route: Hyperdrive in API request handlers, the direct pooled
 * connection in queue consumers, crons and workflows (see db-routing.ts for
 * the exceptions). In Node there is one client for the process.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    const client = getPrismaClient();
    const value = Reflect.get(client, property, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
  has(_target, property) {
    return property in getPrismaClient();
  },
});
