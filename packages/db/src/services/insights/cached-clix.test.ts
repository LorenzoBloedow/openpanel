import { describe, expect, it } from 'vitest';

import { Query } from '../../analytics/query-builder';
import { sql } from '../../analytics/sql';
import { createCachedClix } from './cached-clix';

/** A query factory whose queries record their runs instead of executing. */
function recordingFactory(fail = () => false) {
  const runs: unknown[][] = [];
  class RecordingQuery extends Query {
    override async execute(): Promise<Record<string, unknown>[]> {
      runs.push([this.toSQL(), this.ctx.timezone]);
      if (fail()) {
        throw new Error('query failed');
      }
      return [{ run: runs.length }];
    }
  }
  const factory = (timezone?: string) => new RecordingQuery({ timezone: timezone ?? 'UTC' });
  return { factory, runs };
}

const countFor = (clix: ReturnType<typeof createCachedClix>, projectId: string) =>
  clix()
    .select(['count(*) AS n'])
    .from('analytics.sessions')
    .rawWhere(sql`project_id = ${projectId}`)
    .execute();

describe('createCachedClix', () => {
  it('runs a query once per module/window cache, keyed by text and parameters', async () => {
    const { factory, runs } = recordingFactory();
    const clix = createCachedClix(factory, new Map());

    const first = await countFor(clix, 'p1');
    expect(await countFor(clix, 'p1')).toBe(first);
    // Same text, another parameter: not the same query.
    expect(await countFor(clix, 'p2')).toEqual([{ run: 2 }]);
    expect(runs).toHaveLength(2);
  });

  it('shares one run between identical queries in flight', async () => {
    const { factory, runs } = recordingFactory();
    const clix = createCachedClix(factory, new Map());

    const [a, b] = await Promise.all([countFor(clix, 'p1'), countFor(clix, 'p1')]);
    expect(a).toBe(b);
    expect(runs).toHaveLength(1);
  });

  it('does not remember a failed query', async () => {
    let failing = true;
    const { factory, runs } = recordingFactory(() => failing);
    const clix = createCachedClix(factory, new Map());

    await expect(countFor(clix, 'p1')).rejects.toThrow('query failed');
    failing = false;
    expect(await countFor(clix, 'p1')).toEqual([{ run: 2 }]);
    expect(runs).toHaveLength(2);
  });

  it('runs every query without a cache, in the given time zone', async () => {
    const { factory, runs } = recordingFactory();
    const clix = createCachedClix(factory, undefined, 'Europe/Stockholm');

    await countFor(clix, 'p1');
    await countFor(clix, 'p1');
    expect(runs).toHaveLength(2);
    expect(runs[0]![1]).toBe('Europe/Stockholm');
  });
});
