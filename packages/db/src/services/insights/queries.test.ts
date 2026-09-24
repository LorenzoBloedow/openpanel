import { describe, expect, it } from 'vitest';

import { compile } from '../../analytics/sql';
import { getEndOfDay } from './utils';
import { countCreatedBetween, createdBetween } from './queries';

describe('insight window SQL', () => {
  const start = new Date('2026-09-23T00:00:00.000Z');
  const end = getEndOfDay(start);

  it('bounds windows in whole UTC seconds, as the ClickHouse DateTime text did', () => {
    expect(compile(createdBetween(start, end))).toEqual({
      text: 'created_at BETWEEN $1::timestamptz AND $2::timestamptz',
      values: ['2026-09-23T00:00:00.000Z', '2026-09-23T23:59:59.000Z'],
    });
  });

  it('turns countIf windows into count(*) FILTER with a quoted alias', () => {
    expect(compile(countCreatedBetween(start, end, 'cur_total')).text).toBe(
      'count(*) FILTER (WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz) AS "cur_total"',
    );
    expect(() => countCreatedBetween(start, end, 'cur; DROP TABLE x')).toThrow(
      'Invalid SQL identifier',
    );
  });
});
