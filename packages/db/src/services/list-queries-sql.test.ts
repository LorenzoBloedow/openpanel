/**
 * The event and session list queries, captured instead of run: parameter
 * binding for hostile filter names, and the empty-window lookback the
 * ClickHouse versions had (their `INTERVAL 0.5 DAY` truncated to 0 days, so
 * the first window is empty, then 1, 2, 4, … days up to the ceiling).
 * Results are compared with ClickHouse in test/golden/{events,sessions}.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { captured } = vi.hoisted(() => ({
  captured: [] as { text: string; values: unknown[] }[],
}));

vi.mock('../analytics/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analytics/client')>();
  const { compile } = await import('../analytics/sql');
  const capture = (query: unknown) => {
    captured.push(
      typeof query === 'string' ? { text: query, values: [] } : compile(query as never),
    );
  };
  return {
    ...actual,
    anQuery: async (query: unknown) => {
      capture(query);
      return [];
    },
    anQueryOne: async (query: unknown) => {
      capture(query);
      return undefined;
    },
  };
});

import { getEventList, getEventsCount } from './event.service';
import { getSessionList } from './session.service';

const PROJECT_ID = 'test-sql-validation';
const NOW = new Date('2026-09-24T03:25:00.500Z');
const DAY = 86_400_000;

beforeEach(() => {
  captured.length = 0;
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

// A key that closes a string literal and appends its own predicate.
const HOSTILE = "x'] = '' OR 1 = 1 OR properties['y";

const hostileFilters = [
  { id: 'a', name: `properties.${HOSTILE}`, operator: 'is' as const, value: ['pro'] },
  { id: 'b', name: `profile.properties.${HOSTILE}`, operator: 'is' as const, value: [HOSTILE] },
  { id: 'c', name: `group.properties.${HOSTILE}`, operator: 'contains' as const, value: [HOSTILE] },
];


/** The lower created_at bound of each captured list query, in days before `at`. */
function windows(at: Date) {
  return captured.map((query) => {
    const bound = query.values.find(
      (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value),
    ) as string;
    return (Math.floor(at.getTime() / 1000) * 1000 - new Date(bound).getTime()) / DAY;
  });
}

describe('event list queries', () => {
  it('bind hostile property keys in the list and the count', async () => {
    await getEventList({
      projectId: PROJECT_ID,
      take: 10,
      cursor: 0,
      filters: hostileFilters,
      startDate: new Date('2026-04-14T00:00:00Z'),
      endDate: new Date('2026-05-15T00:00:00Z'),
    });
    await getEventsCount({
      projectId: PROJECT_ID,
      filters: hostileFilters,
      startDate: new Date('2026-04-14T00:00:00Z'),
      endDate: new Date('2026-05-15T00:00:00Z'),
    });
    expect(captured).toHaveLength(2);
    for (const query of captured) {
      expect(query.text).toMatch(/project_id = \$/);
      expect(query.text).not.toContain('OR 1 = 1');
      expect(query.values).toContain(HOSTILE);
    }
    // `profile.*` filters read the joined profile.
    expect(captured[0]!.text).toContain('LEFT JOIN analytics.profiles AS profile');
  });

  it('widens an empty default window 0, 1, 2, 4, … days up to five years', async () => {
    await getEventList({ projectId: PROJECT_ID, take: 10 });
    expect(windows(NOW)).toEqual([0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 1825]);
  });

  it('widens below a date cursor the same way, at second precision', async () => {
    const cursor = new Date('2026-06-01T12:00:00.999Z');
    await getEventList({ projectId: PROJECT_ID, take: 10, cursor });
    expect(windows(cursor).slice(0, 4)).toEqual([0, 1, 2, 4]);
    expect(captured[0]!.values).toContain('2026-06-01T12:00:00.000Z');
  });

  it('pages by offset without a window', async () => {
    await getEventList({ projectId: PROJECT_ID, take: 25, cursor: 3 });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.text).toMatch(/LIMIT \$\d+\s+OFFSET \$\d+/);
    expect(captured[0]!.values.slice(-2)).toEqual([25, 75]);
  });
});

describe('session list query', () => {
  it('widens an empty default window up to a year', async () => {
    await getSessionList({ projectId: PROJECT_ID, take: 10 });
    expect(windows(NOW)).toEqual([0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 365]);
  });

  it('binds the search as typed', async () => {
    await getSessionList({
      projectId: PROJECT_ID,
      take: 10,
      search: "%o'_",
      startDate: new Date('2026-09-01T00:00:00Z'),
      endDate: new Date('2026-09-24T00:00:00Z'),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.values).toContain("%%o'_%");
    expect(captured[0]!.text).not.toContain("o'_");
  });
});
