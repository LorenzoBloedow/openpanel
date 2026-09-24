/**
 * SQL-shape tests for the shared event query (insights API / MCP). Its
 * results are compared with the ClickHouse service in
 * test/golden/events.golden.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compile } from '../analytics/sql';
import { buildQueryEventsQuery } from './event.service';

const PROJECT_ID = 'test-sql-validation';

const build = (input: Omit<Parameters<typeof buildQueryEventsQuery>[0], 'projectId'>) =>
  compile(buildQueryEventsQuery({ projectId: PROJECT_ID, ...input }).toSql());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-24T03:25:00Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildQueryEventsQuery', () => {
  // Callers label these rows `created_at desc` and call them recent events, so
  // the cut has to happen after the sort rather than wherever the scan starts.
  it('takes the newest rows, not an arbitrary slice', () => {
    const { text } = build({});
    expect(text).toContain('ORDER BY created_at DESC');
    expect(text.indexOf('ORDER BY')).toBeLessThan(text.indexOf('LIMIT'));
  });

  it('keeps the default and the caller limit', () => {
    expect(build({}).text).toMatch(/LIMIT 20$/);
    expect(build({ limit: 100 }).text).toMatch(/LIMIT 100$/);
  });

  it('defaults to the 30 days before today 00:00 UTC', () => {
    const { values } = build({});
    expect(values).toEqual(
      expect.arrayContaining(['2026-08-25 00:00:00', '2026-09-24 00:00:00', 'UTC']),
    );
  });

  it('skips the default window for a session, but honours an explicit one', () => {
    expect(build({ sessionId: 's1' }).text).not.toContain('created_at BETWEEN');
    expect(build({ sessionId: 's1', startDate: '2026-09-01' }).text).toContain(
      'created_at BETWEEN',
    );
  });

  it('binds the filters', () => {
    const hostile = "x' OR '1'='1";
    const { text, values } = build({
      profileId: 'profile-1',
      eventNames: ['session_start'],
      path: hostile,
      properties: { [hostile]: hostile },
      filters: [{ id: 'f', name: 'profile.properties.plan', operator: 'is', value: [hostile] }],
    });
    expect(text).toContain('profile_id = $');
    expect(text).toContain('name = ANY(');
    expect(text).not.toContain(hostile);
    expect(values).toEqual(expect.arrayContaining(['profile-1', ['session_start'], hostile]));
  });
});
