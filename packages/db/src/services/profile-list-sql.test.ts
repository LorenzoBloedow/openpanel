/**
 * SQL-shape tests for the profile list and its count. Their results are
 * compared with the ClickHouse service in test/golden/profiles.golden.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { compile } from '../analytics/sql';
import { buildProfileListCountSql, buildProfileListSql } from './profile.service';

const PROJECT_ID = 'test-sql-validation';

const whereOf = (text: string) => text.slice(text.indexOf('WHERE'), text.indexOf('ORDER BY') === -1 ? undefined : text.indexOf('ORDER BY')).trim();

describe('buildProfileListCountSql', () => {
  it('applies the same filters as the list', () => {
    const options = {
      projectId: PROJECT_ID,
      search: 'john smith',
      isExternal: true,
      filters: [
        { id: 'a', name: 'profile.properties.plan', operator: 'is' as const, value: ['pro'] },
        { id: 'b', name: 'group.name', operator: 'contains' as const, value: ['acme'] },
      ],
    };
    const list = compile(buildProfileListSql({ ...options, take: 50 }));
    const count = compile(buildProfileListCountSql(options));
    expect(whereOf(count.text)).toBe(whereOf(list.text));
    // The list binds its LIMIT after the shared conditions.
    expect(list.values).toEqual([...count.values, 50]);
    expect(list.text).toContain('is_external = true');
    expect(list.values).toEqual(expect.arrayContaining(['%john%', '%smith%', 'pro', '%acme%']));
  });

  it('counts profiles (one row per profile)', () => {
    expect(compile(buildProfileListCountSql({ projectId: PROJECT_ID })).text).toContain(
      'SELECT count(*) AS count',
    );
  });

  it('binds the project id', () => {
    const { text, values } = compile(buildProfileListCountSql({ projectId: "x'--" }));
    expect(text).not.toContain("x'--");
    expect(values).toEqual(["x'--"]);
  });
});

describe('buildProfileListSql', () => {
  it('pages with offset = cursor * take', () => {
    const first = compile(buildProfileListSql({ projectId: PROJECT_ID, take: 50 }));
    expect(first.text).not.toContain('OFFSET');
    const third = compile(buildProfileListSql({ projectId: PROJECT_ID, take: 50, cursor: 2 }));
    expect(third.text).toMatch(/LIMIT \$\d+\s+OFFSET \$\d+/);
    expect(third.values.slice(-2)).toEqual([50, 100]);
  });

  it('orders the newest profiles first', () => {
    expect(compile(buildProfileListSql({ projectId: PROJECT_ID, take: 50 })).text).toContain(
      'ORDER BY created_at DESC',
    );
  });
});
