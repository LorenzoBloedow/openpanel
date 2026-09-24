import { describe, expect, it } from 'vitest';
import { and, anyOf, compile, empty, ident, join, or, prop, raw, sql } from './sql';

describe('sql', () => {
  it('binds values as numbered parameters', () => {
    const query = sql`SELECT * FROM t WHERE a = ${1} AND b = ${'x'}`;
    expect(compile(query)).toEqual({
      text: 'SELECT * FROM t WHERE a = $1 AND b = $2',
      values: [1, 'x'],
    });
  });

  it('splices nested fragments and renumbers their parameters', () => {
    const inner = sql`b = ${'x'} OR c = ${'y'}`;
    const query = sql`WHERE a = ${1} AND (${inner}) LIMIT ${10}`;
    expect(compile(query)).toEqual({
      text: 'WHERE a = $1 AND (b = $2 OR c = $3) LIMIT $4',
      values: [1, 'x', 'y', 10],
    });
  });

  it('never inlines strings, whatever they contain', () => {
    const hostile = "x'; DROP TABLE analytics.events; --";
    const { text, values } = compile(sql`name = ${hostile}`);
    expect(text).toBe('name = $1');
    expect(values).toEqual([hostile]);
  });

  it('quotes identifiers and rejects anything else', () => {
    expect(compile(sql`SELECT * FROM ${ident('analytics', 'events')}`).text).toBe(
      'SELECT * FROM "analytics"."events"',
    );
    expect(() => ident('events"; DROP')).toThrow(/Invalid SQL identifier/);
  });

  it('joins values and fragments', () => {
    expect(compile(join([1, 2, 3])).text).toBe('$1, $2, $3');
    expect(compile(join([raw('a'), raw('b')], ' + ')).text).toBe('a + b');
    expect(compile(join([])).text).toBe('');
  });

  it('combines conditions, skipping empty ones', () => {
    expect(compile(and([sql`a = ${1}`, empty, null, false, sql`b = ${2}`])).text).toBe(
      '(a = $1) AND (b = $2)',
    );
    expect(compile(and([])).text).toBe('TRUE');
    expect(compile(or([])).text).toBe('FALSE');
    expect(compile(or([sql`a = ${1}`])).text).toBe('a = $1');
  });

  it('builds ClickHouse-compatible helpers', () => {
    expect(compile(anyOf(raw('e.name'), ['a', 'b']))).toEqual({
      text: 'e.name = ANY($1::text[])',
      values: [['a', 'b']],
    });
    expect(compile(prop('plan', raw('e.properties')))).toEqual({
      text: "COALESCE(e.properties->>$1, '')",
      values: ['plan'],
    });
  });
});
