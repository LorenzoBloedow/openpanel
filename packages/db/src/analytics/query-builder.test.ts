import { describe, expect, it } from 'vitest';
import { clix } from './query-builder';
import { compile, sql } from './sql';

const compiled = (query: ReturnType<typeof clix>) => compile(query.toSql());

describe('clix (Postgres)', () => {
  it('binds where values and reads wall-clock strings in the project zone', () => {
    const query = clix('Europe/Stockholm')
      .select(['name', 'count(*) AS count'])
      .from('analytics.events e')
      .where('e.project_id', '=', 'p1')
      .where('e.created_at', 'BETWEEN', ['2024-01-01 00:00:00', '2024-01-31 23:59:59'])
      .where('e.name', 'IN', ['a', 'b'])
      .groupBy(['name'])
      .orderBy('count', 'DESC')
      .limit(10);
    expect(compiled(query)).toEqual({
      text:
        'SELECT name, count(*) AS count FROM analytics.events e WHERE e.project_id = $1 ' +
        'AND e.created_at BETWEEN ($2::timestamp AT TIME ZONE $3::text) AND ($4::timestamp AT TIME ZONE $5::text) ' +
        'AND e.name IN ($6, $7) GROUP BY name ORDER BY count DESC LIMIT 10',
      values: ['p1', '2024-01-01 00:00:00', 'Europe/Stockholm', '2024-01-31 23:59:59', 'Europe/Stockholm', 'a', 'b'],
    });
  });

  it('supports CTEs, joins, groups, rollup and unions', () => {
    const inner = clix().select(['id']).from('analytics.profiles').where('project_id', '=', 'p1');
    const query = clix()
      .with('p', inner)
      .select(['e.name'])
      .from('analytics.events e')
      .leftJoin('p', 'p.id = e.profile_id')
      .whereGroup()
      .where('e.name', '=', 'x')
      .orWhere('e.name', '=', 'y')
      .end()
      .rawWhere(sql`e.path LIKE ${'/a%'}`)
      .groupBy(['e.name'])
      .rollup()
      .union(clix().select(['1']).from('t'));
    const { text, values } = compiled(query);
    expect(text).toBe(
      '(WITH p AS (SELECT id FROM analytics.profiles WHERE project_id = $1) SELECT e.name ' +
        'FROM analytics.events e LEFT JOIN p ON p.id = e.profile_id ' +
        'WHERE (e.name = $2 OR e.name = $3) AND e.path LIKE $4 GROUP BY ROLLUP (e.name)) ' +
        'UNION ALL (SELECT 1 FROM t)',
    );
    expect(values).toEqual(['p1', 'x', 'y', '/a%']);
  });

  it('skips clauses between if/endIf and renders empty IN lists safely', () => {
    const query = clix()
      .select(['*'])
      .from('t')
      .if(false)
      .where('a', '=', 1)
      .endIf()
      .where('b', 'IN', []);
    expect(compiled(query).text).toBe('SELECT * FROM t WHERE b IN (NULL)');
  });

  it('buckets by the project zone and renders ClickHouse bucket text', () => {
    const ctx = { timezone: 'Asia/Kathmandu' };
    const bucket = clix.toStartOf('e.created_at', 'week', ctx);
    expect(compile(clix.formatBucket(bucket, 'week')).text).toBe(
      "to_char(date_trunc('week', (e.created_at AT TIME ZONE $1::text)), 'YYYY-MM-DD')",
    );
    expect(compile(clix.formatBucket(clix.toStartOf('e.created_at', 'hour', ctx), 'hour')).text).toBe(
      "to_char(date_trunc('hour', (e.created_at AT TIME ZONE $1::text)), 'YYYY-MM-DD HH24:MI:SS')",
    );
  });
});
