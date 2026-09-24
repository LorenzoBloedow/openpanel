/**
 * Property keys reach the chart queries as free text: a filter name, a
 * breakdown name or a math-metric property from a saved report or an API
 * call. A key carrying a quote must never become SQL, or it could escape the
 * `project_id` predicate that scopes the query to one project: the Postgres
 * chart queries bind every key as a parameter.
 *
 * Assertions on the compiled SQL; no database needed.
 */
import { describe, expect, it } from 'vitest';

import { type Sql, compile } from '../analytics/sql';
import {
  getAggregateChartSql as _getAggregateChartSql,
  getChartSql as _getChartSql,
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
