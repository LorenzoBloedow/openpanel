/**
 * Property keys reach the SQL builders as free text: a filter name, a
 * breakdown name or a math-metric property from a saved report or an API
 * call. In the ClickHouse helpers they end up inside a Map access, so a key
 * carrying a quote must stay one string literal — otherwise it closes the
 * literal and the rest of the key is parsed as SQL, next to the `project_id`
 * predicate that scopes the query to one project. The Postgres chart
 * queries bind them as parameters.
 *
 * String assertions only; no database needed.
 */
import { describe, expect, it } from 'vitest';

import { type Sql, compile } from '../analytics/sql';
import { createSqlBuilder } from '../sql-builder';
import {
  collectProfilePropertyKeys,
  getAggregateChartSql as _getAggregateChartSql,
  getChartSql as _getChartSql,
  getSelectPropertyKey,
  profilePropertiesCteSelect,
  rewriteProfilePropertyRefs,
} from './chart.service';

const getChartSql: (input: any) => Promise<Sql> = _getChartSql as any;
const getAggregateChartSql: (input: any) => Promise<Sql> =
  _getAggregateChartSql as any;

const PROJECT_ID = 'test-sql-validation';
const START = '2026-04-14 00:00:00';
const END = '2026-05-15 00:00:00';

// A key that closes the literal, appends its own predicate, and reopens a
// literal so the tail of the original render still parses.
const BREAKOUT_KEY = "x'] = '' OR 1 = 1 OR properties['y";
const BREAKOUT_PROPERTY = `properties.${BREAKOUT_KEY}`;

/**
 * How a Postgres chart query carries the hostile key: it must keep one
 * project predicate, and the key must only be among the parameters.
 */
function keyBinding(query: Sql) {
  const { text, values } = compile(query);
  return {
    projectPredicates: text.match(/e\.project_id = \$\d+/g)?.length ?? 0,
    injected: text.includes('OR 1 = 1'),
    bound: values.includes(BREAKOUT_KEY),
  };
}

const BOUND_KEY = { projectPredicates: 1, injected: false, bound: true };

describe('getSelectPropertyKey / key escaping', () => {
  it('renders a key with a quote as a single escaped literal', () => {
    expect(getSelectPropertyKey(BREAKOUT_PROPERTY, undefined, undefined, undefined, 'e')).toBe(
      "e.properties['x\\'] = \\'\\' OR 1 = 1 OR properties[\\'y']",
    );
  });

  it('escapes backslashes and leaves ] alone', () => {
    expect(getSelectPropertyKey('properties.a\\b]c')).toBe(
      "properties['a\\\\b]c']",
    );
  });

  it('escapes profile property keys the same way', () => {
    expect(getSelectPropertyKey("profile.properties.pl'an")).toBe(
      "profile.properties['pl\\'an']",
    );
  });

  it('renders ordinary keys unchanged', () => {
    expect(getSelectPropertyKey('properties.foo')).toBe("properties['foo']");
    expect(getSelectPropertyKey('properties.foo', undefined, undefined, undefined, 'e')).toBe(
      "e.properties['foo']",
    );
    expect(getSelectPropertyKey('profile.properties.plan')).toBe(
      "profile.properties['plan']",
    );
    expect(getSelectPropertyKey('properties.a.*')).toBe(
      "arrayMap(x -> trim(x), mapValues(mapExtractKeyLike(properties, 'a.*')))",
    );
    expect(getSelectPropertyKey('country')).toBe('country');
  });
});

describe('sql-builder / getWhere', () => {
  it('parenthesises each clause so an OR cannot re-group its neighbours', () => {
    const { sb, getWhere } = createSqlBuilder();
    sb.where.project = "project_id = 'p'";
    sb.where.f0 = "name = 'a' OR 1 = 1";
    expect(getWhere()).toBe("WHERE (project_id = 'p') AND (name = 'a' OR 1 = 1)");
  });

  it('is empty when there are no clauses', () => {
    const { getWhere } = createSqlBuilder();
    expect(getWhere()).toBe('');
  });
});

// The chart queries are Postgres queries: a key is a bind parameter, never
// part of the SQL text.
describe('chart SQL with a hostile property key', () => {
  const base = {
    interval: 'day',
    startDate: START,
    endDate: END,
    projectId: PROJECT_ID,
    timezone: 'UTC',
  };
  const event = (overrides: Record<string, unknown> = {}) => ({
    id: 'A',
    name: 'screen_view',
    segment: 'event',
    filters: [],
    ...overrides,
  });

  it('keeps the project scope for a filter name', async () => {
    const query = await getChartSql({
      event: event({
        filters: [
          {
            id: 'f1',
            name: BREAKOUT_PROPERTY,
            operator: 'is',
            value: ['pro'],
          },
        ],
      }),
      breakdowns: [],
      ...base,
    });
    expect(keyBinding(query)).toEqual(BOUND_KEY);
  });

  it('keeps the project scope for a breakdown name', async () => {
    const query = await getChartSql({
      event: event(),
      breakdowns: [{ id: 'b', name: BREAKOUT_PROPERTY }],
      ...base,
    });
    expect(keyBinding(query)).toEqual(BOUND_KEY);
  });

  it('keeps the project scope for a math-metric property', async () => {
    const query = await getChartSql({
      event: event({
        segment: 'property_average',
        property: BREAKOUT_PROPERTY,
      }),
      breakdowns: [],
      ...base,
    });
    expect(keyBinding(query)).toEqual(BOUND_KEY);
  });

  it('keeps the project scope in aggregate chart SQL', async () => {
    const query = await getAggregateChartSql({
      event: event({
        segment: 'property_sum',
        property: BREAKOUT_PROPERTY,
      }),
      breakdowns: [{ id: 'b', name: BREAKOUT_PROPERTY }],
      ...base,
    });
    expect(keyBinding(query)).toEqual(BOUND_KEY);
  });
});

// The event list and count are Postgres queries now: see
// list-queries-sql.test.ts.

describe('profile-property narrowing with a quoted key', () => {
  const key = "pl'an";
  const name = `profile.properties.${key}`;

  it('narrows the key and rewrites its reference to the CTE column', () => {
    const { keys, needsFullMap } = collectProfilePropertyKeys([{ name }]);
    expect(keys).toEqual([key]);
    expect(needsFullMap).toBe(false);

    const cteSelect = profilePropertiesCteSelect(keys, needsFullMap);
    expect(cteSelect).toBe(
      "properties['pl\\'an'] as `profile.properties.pl'an`",
    );

    const ref = getSelectPropertyKey(name);
    const rewritten = rewriteProfilePropertyRefs(`SELECT ${ref}`, keys);
    expect(rewritten).toBe('SELECT `profile.properties.pl\'an`');
  });

  it('falls back to the full Map for keys it cannot alias', () => {
    const { keys, needsFullMap } = collectProfilePropertyKeys([
      { name: 'profile.properties.a\\b' },
    ]);
    expect(keys).toEqual([]);
    expect(needsFullMap).toBe(true);
    expect(profilePropertiesCteSelect(keys, needsFullMap)).toBe(
      'properties as "profile.properties"',
    );
  });

  it('leaves ordinary keys narrowing exactly as before', () => {
    const { keys, needsFullMap } = collectProfilePropertyKeys([
      { name: 'profile.properties.plan' },
    ]);
    expect(keys).toEqual(['plan']);
    expect(needsFullMap).toBe(false);
    expect(profilePropertiesCteSelect(keys, needsFullMap)).toBe(
      "properties['plan'] as `profile.properties.plan`",
    );
    expect(
      rewriteProfilePropertyRefs(
        `SELECT ${getSelectPropertyKey('profile.properties.plan')}`,
        keys,
      ),
    ).toBe('SELECT `profile.properties.plan`');
  });
});
