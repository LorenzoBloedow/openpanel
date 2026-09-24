import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeFallbackScope,
  getEnv,
  getRoute,
  getScopedResource,
  hasScope,
  runWithScope,
  setFallbackEnv,
  waitUntil,
  withRoute,
} from './scope';

function createCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        promises.push(promise);
      },
    },
    settle: () => Promise.all(promises),
  };
}

describe('runtime scope', () => {
  afterEach(async () => {
    setFallbackEnv(undefined);
    await disposeFallbackScope();
  });

  it('exposes env and route inside the scope', async () => {
    const env = { FOO: 'bar' };
    await runWithScope({ env, route: 'hyperdrive' }, () => {
      expect(hasScope()).toBe(true);
      expect(getEnv()).toBe(env);
      expect(getRoute()).toBe('hyperdrive');
    });
    expect(hasScope()).toBe(false);
  });

  it('falls back to the fallback env outside a scope', () => {
    setFallbackEnv({ A: '1' });
    expect(getEnv()).toEqual({ A: '1' });
    expect(getRoute()).toBe('direct');
  });

  it('withRoute overrides the route but shares resources', async () => {
    let created = 0;
    await runWithScope({ env: {}, route: 'hyperdrive' }, () => {
      const outer = getScopedResource('thing', () => ++created);
      withRoute('direct', () => {
        expect(getRoute()).toBe('direct');
        expect(getScopedResource('thing', () => ++created)).toBe(outer);
      });
      expect(getRoute()).toBe('hyperdrive');
    });
    expect(created).toBe(1);
  });

  it('creates resources once per scope and disposes them at the end', async () => {
    const disposed: string[] = [];
    for (const name of ['a', 'b']) {
      await runWithScope({ env: {}, route: 'direct' }, () => {
        const first = getScopedResource(
          'pool',
          () => ({ name }),
          (value) => {
            disposed.push(value.name);
          },
        );
        const second = getScopedResource('pool', () => ({ name: 'other' }));
        expect(second).toBe(first);
      });
    }
    expect(disposed).toEqual(['a', 'b']);
  });

  it('keeps resources open until waitUntil work settles', async () => {
    const { ctx, settle } = createCtx();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await runWithScope({ env: {}, ctx, route: 'direct' }, () => {
      getScopedResource(
        'pool',
        () => 'pool',
        () => {
          events.push('disposed');
        },
      );
      waitUntil(
        gate.then(() => {
          events.push('background done');
        }),
      );
    });

    expect(events).toEqual([]);
    release();
    await settle();
    expect(events).toEqual(['background done', 'disposed']);
  });

  it('refuses to create resources from detached work after the scope closed', async () => {
    const { ctx, settle } = createCtx();
    let lateError: unknown;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    await runWithScope({ env: {}, ctx, route: 'direct' }, () => {
      // Not registered with waitUntil, so it runs after the scope closed but
      // still inside its async context.
      setTimeout(() => {
        try {
          getScopedResource('late', () => 1);
        } catch (error) {
          lateError = error;
        }
        done();
      }, 20);
    });
    await settle();
    await finished;
    expect(String(lateError)).toMatch(/already closed/);
  });
});
