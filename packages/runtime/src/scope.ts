import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which connection path database work in the current scope should use.
 *
 * - `hyperdrive`: interactive, request/response paths where a user is waiting
 *   on the data (dashboard tRPC, public API reads, auth). Goes through the
 *   Cloudflare Hyperdrive pool in front of Neon.
 * - `direct`: analytics ingestion and background work that doesn't have to
 *   be realtime (queue consumers, crons, workflows, replay inserts). Opens a
 *   plain `pg` connection to Neon's pooled endpoint.
 *
 * In Node (scripts, tests) both routes resolve to `DATABASE_URL`.
 */
export type DbRoute = 'hyperdrive' | 'direct';

/**
 * The subset of the Worker `env` the shared packages rely on. Individual
 * packages narrow it further with their own binding types.
 */
export interface RuntimeEnv {
  [key: string]: unknown;
}

/** Anything that can extend the invocation's lifetime (ExecutionContext, DurableObjectState, …). */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

type Disposer = () => Promise<void> | void;

interface ScopeResource {
  value: unknown;
  dispose?: Disposer;
}

/** Lifetime state shared by a scope and the `withRoute` views of it. */
interface ScopeState {
  resources: Map<string, ScopeResource>;
  /** Promises registered through `waitUntil` — resources outlive them. */
  pending: Set<Promise<unknown>>;
  closed: boolean;
}

interface Scope {
  env: RuntimeEnv;
  ctx: WaitUntilContext | undefined;
  route: DbRoute;
  state: ScopeState;
}

function createState(): ScopeState {
  return { resources: new Map(), pending: new Set(), closed: false };
}

const storage = new AsyncLocalStorage<Scope>();

let fallbackEnv: RuntimeEnv | undefined;
let fallbackScope: Scope | undefined;

export interface RunWithScopeOptions {
  /** The Worker's env (any bindings interface; read back through getEnv). */
  env: object;
  ctx?: WaitUntilContext;
  route: DbRoute;
}

/**
 * Runs `fn` inside a runtime scope. Every Worker entry point (fetch, queue,
 * scheduled, Durable Object methods, Workflow steps) must enter one, so that
 * per-invocation resources — database pools, Prisma clients — are created
 * lazily, never shared across requests (a Workers requirement for sockets),
 * and closed once the invocation and everything it `waitUntil`-ed is done.
 */
export async function runWithScope<T>(
  options: RunWithScopeOptions,
  fn: () => T | Promise<T>,
): Promise<T> {
  const scope: Scope = {
    env: options.env as RuntimeEnv,
    ctx: options.ctx,
    route: options.route,
    state: createState(),
  };

  try {
    return await storage.run(scope, fn);
  } finally {
    const closing = closeWhenSettled(scope.state);
    if (scope.ctx) {
      scope.ctx.waitUntil(closing);
    } else {
      await closing;
    }
  }
}

async function closeWhenSettled(state: ScopeState) {
  // Anything registered with waitUntil may still use scoped resources, so
  // wait for it (and for work it registers in turn) before closing them.
  while (state.pending.size > 0) {
    await Promise.allSettled([...state.pending]);
  }
  await closeState(state);
}

async function closeState(state: ScopeState) {
  if (state.closed) {
    return;
  }
  state.closed = true;
  const resources = [...state.resources.values()].reverse();
  state.resources.clear();
  await Promise.allSettled(
    resources.map(async (resource) => {
      await resource.dispose?.();
    }),
  );
}

function getActiveScope(): Scope | undefined {
  return storage.getStore();
}

/** True when the code runs inside workerd (Workers, Miniflare, vitest-plugin). */
export function isWorkerd(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    navigator.userAgent === 'Cloudflare-Workers'
  );
}

/**
 * Sets the env used outside of any scope. Node tests and scripts call this;
 * Workers always run inside `runWithScope`.
 */
export function setFallbackEnv(env: RuntimeEnv | undefined) {
  fallbackEnv = env;
}

/**
 * Returns the env of the current scope. Outside a scope it falls back to the
 * env set by `setFallbackEnv`, then to `process.env` (Node scripts and tests).
 */
export function getEnv<T extends object = RuntimeEnv>(): T {
  const scope = getActiveScope();
  if (scope) {
    return scope.env as T;
  }
  if (fallbackEnv) {
    return fallbackEnv as T;
  }
  return (typeof process !== 'undefined' ? process.env : {}) as unknown as T;
}

export function hasScope(): boolean {
  return getActiveScope() !== undefined;
}

/** The connection route of the current scope (`direct` outside a scope). */
export function getRoute(): DbRoute {
  return getActiveScope()?.route ?? 'direct';
}

/**
 * Runs `fn` with a different default connection route while keeping the
 * current scope's env, context and resources. Used for the few call sites
 * whose route differs from their entry point's default (see db-routing).
 */
export function withRoute<T>(route: DbRoute, fn: () => T): T {
  const scope = getActiveScope();
  if (!scope || scope.route === route) {
    return fn();
  }
  return storage.run({ ...scope, route }, fn);
}

/**
 * Extends the invocation's lifetime until `promise` settles. Scoped
 * resources stay open until it does. Outside a scope the promise is simply
 * observed so rejections are not unhandled.
 */
export function waitUntil(promise: Promise<unknown>): void {
  const scope = getActiveScope();
  const observed = promise.catch((error: unknown) => {
    console.error('waitUntil task failed', error);
  });
  if (!scope) {
    return;
  }
  scope.state.pending.add(observed);
  // `observed` never rejects, so neither does this chain.
  observed.finally(() => scope.state.pending.delete(observed));
  scope.ctx?.waitUntil(observed);
}

/**
 * Returns a resource cached for the lifetime of the current scope, creating
 * it on first use. Outside a scope (Node scripts, tests) the resource is
 * cached process-wide and disposed by `disposeFallbackScope()`.
 */
export function getScopedResource<T>(
  key: string,
  create: () => T,
  dispose?: (value: T) => Promise<void> | void,
): T {
  const { state } = getActiveScope() ?? getFallbackScope();
  if (state.closed) {
    throw new Error(
      `Runtime scope already closed; cannot create "${key}". Register late work with waitUntil().`,
    );
  }
  const existing = state.resources.get(key);
  if (existing) {
    return existing.value as T;
  }
  const value = create();
  state.resources.set(key, {
    value,
    dispose: dispose ? () => dispose(value) : undefined,
  });
  return value;
}

function getFallbackScope(): Scope {
  if (isWorkerd()) {
    // Sockets and other I/O objects cannot be shared across requests in
    // Workers; creating them outside a scope would leak them.
    throw new Error(
      'No runtime scope: wrap Worker entry points in runWithScope() before touching scoped resources.',
    );
  }
  fallbackScope ??= {
    env: fallbackEnv ?? {},
    ctx: undefined,
    route: 'direct',
    state: createState(),
  };
  return fallbackScope;
}

/** Closes resources created outside a scope (Node tests and scripts). */
export async function disposeFallbackScope() {
  const scope = fallbackScope;
  fallbackScope = undefined;
  if (scope) {
    await closeState(scope.state);
  }
}
