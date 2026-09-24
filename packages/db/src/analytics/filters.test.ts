import type { IChartEventFilter } from '@openpanel/validation';
import { describe, expect, it } from 'vitest';

import {
  collectBreakdownCohortIds,
  collectProfilePropertyKeys,
  extractCohortId,
  isAllCohortsBreakdown,
  isKnownEventField,
  isProfileColumn,
  normalizeEventField,
  profileJoinColumns,
  wildcardKeyPattern,
} from './fields';
import {
  type EventFilterScope,
  GROUP_JOIN,
  allCohortsLabelExpr,
  cohortAlias,
  cohortJoin,
  eventFilterClauses,
  eventPropertyExpr,
  groupJoin,
  prefixedFilterClauses,
  profileJoin,
} from './filters';
import { type Sql, and, compile } from './sql';

const scope: EventFilterScope = { projectId: 'p1', timezone: 'UTC', alias: 'e' };

let seq = 0;
const filter = (
  name: string,
  operator: IChartEventFilter['operator'],
  value: IChartEventFilter['value'],
  extra: Partial<IChartEventFilter> = {},
): IChartEventFilter => ({ id: `t${++seq}`, name, operator, value, ...extra });

const text = (fragment: Sql) => compile(fragment).text;
const events = (filters: IChartEventFilter[], s: EventFilterScope = scope) =>
  compile(and(eventFilterClauses(filters, s)));

describe('field names', () => {
  it('normalizes aliases and bare UTM names', () => {
    expect(normalizeEventField('referrerName')).toBe('referrer_name');
    expect(normalizeEventField('utm_source')).toBe('properties.__query.utm_source');
    expect(normalizeEventField('country')).toBe('country');
    // Prototype keys are not aliases.
    expect(normalizeEventField('constructor')).toBe('constructor');
    expect(normalizeEventField('toString')).toBe('toString');
  });

  it('knows the names the builders accept', () => {
    for (const name of ['has_profile', 'cohort', 'cohort:abc', 'properties.x', 'profile.email', 'group.name', 'createdAt', 'utm_term', 'revenue']) {
      expect(isKnownEventField(name), name).toBe(true);
    }
    for (const name of ['temple_name', 'constructor', 'groups', 'properties', '']) {
      expect(isKnownEventField(name), name).toBe(false);
    }
  });

  it('turns wildcard names into LIKE patterns like transformPropertyKey', () => {
    expect(wildcardKeyPattern('properties.items[*]')).toBe('items.%');
    expect(wildcardKeyPattern('properties.items.*.sku')).toBe('items.%.sku');
    expect(wildcardKeyPattern('properties.items[*].sku')).toBe('items.%.sku');
    // A trailing .* stays literal, and only a leading `properties.` goes.
    expect(wildcardKeyPattern('properties.a.*')).toBe('a.*');
    expect(wildcardKeyPattern('profile.properties.a[*]')).toBe('profile.properties.a.%');
  });

  it('collects cohort ids and profile property keys', () => {
    expect(extractCohortId('cohort:abc')).toBe('abc');
    expect(extractCohortId('cohort')).toBeNull();
    expect(isAllCohortsBreakdown('cohort')).toBe(true);
    expect(collectBreakdownCohortIds([{ name: 'cohort:a' }, { name: 'country' }, { name: 'cohort:a' }, { name: 'cohort:b' }])).toEqual(['a', 'b']);
    expect(
      collectProfilePropertyKeys([
        { name: 'profile.properties.plan' },
        { name: "profile.properties.it's\\`" },
        { name: 'profile.email' },
        { name: 'properties.plan' },
      ]),
    ).toEqual({ keys: ['plan', "it's\\`"], needsFullMap: false });
    expect(collectProfilePropertyKeys([{ name: 'profile.properties.items[*]' }]).needsFullMap).toBe(true);
  });

  it('allowlists profile columns (GHSA-pc3q-gw7f-p2x2, GHSA-4j6c-j6vc-xq96)', () => {
    expect(profileJoinColumns(['profile.email', 'profile.properties.plan', 'first_name', 'properties.tier'])).toEqual(['id', 'email', 'properties', 'first_name']);
    expect(profileJoinColumns(['profile.email, project_id FROM profiles', 'profile.password'])).toEqual(['id']);
    expect(isProfileColumn('profile.last_seen_at')).toBe(true);
    expect(isProfileColumn('properties')).toBe(false);
  });
});

describe('eventFilterClauses', () => {
  it('binds every value and property key', () => {
    const hostile = "x'] = '' OR 1 = 1 OR properties['y";
    const { text: sql, values } = events([
      filter(`properties.${hostile}`, 'is', [hostile]),
      filter(`profile.properties.${hostile}`, 'contains', [hostile]),
      filter(`group.properties.${hostile}`, 'regex', [hostile]),
      filter('country', 'isNot', [hostile, 'SE']),
      filter('path', 'regex', [`/${hostile}/`]),
    ]);
    expect(sql).not.toContain('OR 1 = 1');
    expect(sql).not.toContain(hostile);
    expect(values).toContain(hostile);
    expect(values).toContain(`%${hostile}%`);
  });

  it('qualifies columns with the alias and keeps the ClickHouse operators', () => {
    expect(events([filter('country', 'is', ['SE'])]).text).toBe('e.country = $1::text');
    expect(events([filter('country', 'is', ['SE', 'US'])]).text).toBe('e.country IN ($1::text, $2::text)');
    expect(events([filter('path', 'doesNotContain', ['a', 'b'])]).text).toBe(
      '((e.path NOT LIKE $1::text) OR (e.path NOT LIKE $2::text))',
    );
    expect(events([filter('duration', 'gt', ['10'])]).text).toBe(
      '((e.duration)::double precision > analytics.to_float_or_null($1::text))',
    );
    expect(events([filter('name', 'gt', ['a'])]).text).toBe('((e.name COLLATE "C") > $1::text)');
    expect(events([filter('has_profile', 'is', ['true'])]).text).toBe('e.profile_id <> e.device_id');
    expect(events([filter('country', 'is', ['SE'])], { projectId: 'p1', timezone: 'UTC' }).text).toBe(
      'country = $1::text',
    );
  });

  it('strips slashes from column regexes only', () => {
    expect(events([filter('path', 'regex', ['/^a/'])]).values).toContain('^a');
    expect(events([filter('properties.x', 'regex', ['/^a/'])]).values).toContain('/^a/');
  });

  it('drops what ClickHouse dropped', () => {
    for (const dropped of [
      filter('temple_name', 'is', ['x']),
      filter('profile.email', 'is', ['x']),
      filter('country', 'is', []),
      filter('cohort', 'inCohort', []),
      filter('cohort:abc', 'is', ['x']),
      filter('properties.x', 'inCohort', []),
    ]) {
      expect(eventFilterClauses([dropped], scope), dropped.name).toEqual([]);
    }
  });

  it('keeps rows with groups for any group.* filter, as the ARRAY JOIN did', () => {
    expect(events([filter('group.name', 'gt', ['a'])]).text).toBe('cardinality(e.groups) > 0');
    expect(events([filter('group.name', 'is', [])]).text).toBe('cardinality(e.groups) > 0');
    expect(events([filter('group.name', 'is', ['Acme'])]).text).toContain(
      'EXISTS (SELECT 1 FROM unnest(e.groups) AS _fgid LEFT JOIN analytics.groups AS _fg ON _fg.project_id = $1',
    );
    // With a group join the joined row is filtered directly.
    const joined = { ...scope, groupJoin: GROUP_JOIN };
    expect(events([filter('group.name', 'is', ['Acme'])], joined).text).toBe("COALESCE(_g.name, '') = $1::text");
    expect(eventFilterClauses([filter('group.name', 'gt', ['a'])], joined)).toEqual([]);
    expect(text(groupJoin(scope))).toBe(
      'CROSS JOIN LATERAL unnest(e.groups) AS _group_id LEFT JOIN analytics.groups AS _g ON _g.project_id = $1 AND _g.id = _group_id',
    );
  });

  it('reads profile properties from the joined profile or a lookup', () => {
    const joined = { ...scope, profileAlias: 'profile' };
    expect(events([filter('profile.properties.plan', 'is', ['pro'])], joined).text).toBe(
      "COALESCE(profile.properties ->> $1::text, '') = $2::text",
    );
    expect(events([filter('profile.properties.plan', 'is', ['pro'])]).text).toBe(
      "COALESCE((SELECT _fp.properties FROM analytics.profiles AS _fp WHERE _fp.project_id = $1 AND _fp.id = e.profile_id) ->> $2::text, '') = $3::text",
    );
    expect(text(profileJoin(scope))).toBe(
      'LEFT JOIN analytics.profiles AS profile ON profile.project_id = $1 AND profile.id = e.profile_id',
    );
  });

  it('casts both sides for typed filters', () => {
    expect(events([filter('properties.price', 'gte', [19], { type: 'number' })]).text).toBe(
      "(analytics.to_float_or_null(COALESCE(e.properties ->> $1::text, '')) >= analytics.to_float_or_null($2::text))",
    );
    const isNot = events([filter('properties.flag', 'isNot', ['a', 'b'], { type: 'boolean' })]).text;
    expect(isNot).toContain(') AND (');
    // A timestamp column's date is its UTC date (ClickHouse's column zone).
    const date = events([filter('created_at', 'is', ['2024-01-01'], { type: 'date' })], { ...scope, timezone: 'Asia/Tokyo' });
    expect(date.text.startsWith('(((e.created_at AT TIME ZONE $1::text))::date = ')).toBe(true);
    expect(date.values[0]).toBe('UTC');
  });

  it('rejects aliases that are not identifiers', () => {
    expect(() => eventFilterClauses([filter('country', 'is', ['SE'])], { ...scope, alias: 'e; DROP' })).toThrow(/Invalid SQL alias/);
    expect(() => cohortAlias("x') OR (1=1")).toThrow(/Invalid SQL alias/);
  });
});

describe('eventPropertyExpr', () => {
  it('renders the ClickHouse getSelectPropertyKey expressions', () => {
    expect(text(eventPropertyExpr('country', scope))).toBe('e.country');
    expect(text(eventPropertyExpr('referrerName', scope))).toBe('e.referrer_name');
    expect(compile(eventPropertyExpr('utm_source', scope)).values).toEqual(['__query.utm_source']);
    expect(text(eventPropertyExpr('properties.items[*]', scope))).toBe(
      'ARRAY(SELECT btrim(_kv.value) FROM jsonb_each_text(e.properties) AS _kv(key, value) WHERE _kv.key LIKE $1::text)',
    );
    expect(compile(eventPropertyExpr('cohort:c1', scope, { name: "Power's" }))).toEqual({
      text: '(CASE WHEN e.profile_id IN (SELECT profile_id FROM analytics.cohort_members WHERE cohort_id = ANY($1::text[]) AND project_id = $2) THEN $3::text ELSE $4::text END)',
      values: [['c1'], 'p1', "Power's", "Not Power's"],
    });
    expect(compile(eventPropertyExpr('cohort:c1', scope)).values.slice(2)).toEqual([
      'In Cohort',
      'Not In Cohort',
    ]);
  });

  it('refuses names it cannot resolve', () => {
    expect(() => eventPropertyExpr('temple_name', scope)).toThrow(/Unknown event field/);
    expect(() => eventPropertyExpr('profile.password', scope)).toThrow(/Unknown profile field/);
    expect(() => eventPropertyExpr('group.name', scope)).toThrow(/group join/);
  });
});

describe('prefixedFilterClauses', () => {
  const prefixed = (filters: IChartEventFilter[], table: 'events' | 'sessions' | 'profiles') =>
    compile(and(prefixedFilterClauses(filters, { projectId: 'p1', timezone: 'UTC', table })));

  it('only handles cohort, group, profile and session names', () => {
    for (const table of ['events', 'sessions', 'profiles'] as const) {
      expect(prefixedFilterClauses([filter('country', 'is', ['SE']), filter('properties.plan', 'is', ['pro']), filter('profile.not a column', 'is', ['x'])], { projectId: 'p1', timezone: 'UTC', table })).toEqual([]);
    }
    expect(prefixedFilterClauses([filter('session.is_bounce', 'is', ['true'])], { projectId: 'p1', timezone: 'UTC', table: 'events' })).toEqual([]);
  });

  it('reads profiles through a subquery outside the profiles table', () => {
    expect(prefixed([filter('profile.email', 'contains', ['a'])], 'sessions').text).toBe(
      'profile_id IN (SELECT _fp.id FROM analytics.profiles AS _fp WHERE _fp.project_id = $1 AND (_fp.email ILIKE $2::text))',
    );
    expect(prefixed([filter('profile.email', 'contains', ['a'])], 'profiles').text).toBe('(email ILIKE $1::text)');
    expect(prefixed([filter('profile.created_at', 'gt', ['1'])], 'profiles').text).toBe(
      '(extract(epoch from created_at)::double precision > analytics.to_float_or_null($1::text))',
    );
  });

  it('ANDs doesNotContain and ORs numeric isNot, as before', () => {
    expect(prefixed([filter('profile.email', 'doesNotContain', ['a', 'b'])], 'profiles').text).toBe(
      '((email NOT ILIKE $1::text) AND (email NOT ILIKE $2::text))',
    );
    expect(prefixed([filter('session.event_count', 'isNot', ['1', '2'])], 'sessions').text).toBe(
      '(((event_count)::double precision <> analytics.to_float_or_null($1::text)) OR ((event_count)::double precision <> analytics.to_float_or_null($2::text)))',
    );
  });

  it('matches groups and cohorts by bound ids', () => {
    expect(prefixed([filter('group.name', 'is', ['Acme'])], 'profiles').text).toBe(
      'EXISTS (SELECT 1 FROM analytics.groups AS _fg WHERE _fg.project_id = $1 AND _fg.id = ANY(groups) AND _fg.name = $2::text)',
    );
    const cohort = prefixed([filter('cohort:c1', 'notInCohort', [])], 'profiles');
    expect(cohort.text).toBe(
      'id NOT IN (SELECT profile_id FROM analytics.cohort_members WHERE cohort_id = ANY($1::text[]) AND project_id = $2)',
    );
    expect(cohort.values).toEqual([['c1'], 'p1']);
  });
});

describe('cohort helpers', () => {
  it('builds joins and labels with bound ids and names', () => {
    expect(cohortAlias('0b4c6f1e-2f0a')).toBe('cohort_0b4c6f1e_2f0a');
    expect(text(cohortJoin('a-b', 'p1', 'e'))).toBe(
      'LEFT JOIN analytics.cohort_members AS cohort_a_b ON cohort_a_b.project_id = $1 AND cohort_a_b.cohort_id = $2 AND cohort_a_b.profile_id = e.profile_id',
    );
    const label = compile(allCohortsLabelExpr([{ id: 'a', name: "It's" }, { id: 'b', name: 'B' }]));
    expect(label.text).toBe(
      "(CASE _all_cohorts.cohort_id WHEN $1::text THEN $2::text WHEN $3::text THEN $4::text ELSE 'Unknown' END)",
    );
    expect(label.values).toEqual(['a', "It's", 'b', 'B']);
    expect(text(allCohortsLabelExpr([]))).toBe("'Unknown'::text");
  });
});
