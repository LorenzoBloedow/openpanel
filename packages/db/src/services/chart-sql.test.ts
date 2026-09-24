/**
 * The chart engine's Postgres queries (getChartSql / getAggregateChartSql).
 *
 * Every query is planned with `EXPLAIN` on a freshly migrated database: that
 * parses it, resolves every column (an ambiguous or unknown one fails) and
 * type-checks the parameters, without needing data. Shape assertions pin the
 * ClickHouse behaviour each query keeps; a few queries run on small data to
 * check the fill rows and `total_count`. The results themselves are
 * compared with ClickHouse in test/golden/chart*.golden.test.ts.
 */
import { disposeFallbackScope, setFallbackEnv } from '@openpanel/runtime';
import type { IChartBreakdown, IChartEvent } from '@openpanel/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { anQuery } from '../analytics/client';
import { type CompiledSql, type Sql, compile, sql } from '../analytics/sql';
import { type EventWriteRow, insertEvents } from '../analytics/writers';
import { db } from '../prisma-client';
import { type TestDatabase, createTestDatabase } from '../testing/database';
import {
  getAggregateChartSql as _getAggregateChartSql,
  getChartSql as _getChartSql,
} from './chart.service';

// IGetChartDataInput has display-only fields (metric, chartType, previous,
// etc.) that the SQL builders ignore. Tests only care about the SQL, so
// loosen the input type here.
const getChartSql: (input: any) => Promise<Sql> = _getChartSql as any;
const getAggregateChartSql: (input: any) => Promise<Sql> =
  _getAggregateChartSql as any;

const PROJECT_ID = 'test-sql-validation';
const COHORT_PROJECT_ID = 'test-sql-cohorts';
/** Holds the few events the executed tests read. */
const DATA_PROJECT_ID = 'test-sql-data';
const COHORT_ID = '6b0f3d2e-1c4a-4e8b-9f1d-2a3b4c5d6e7f';
const START = '2026-04-14 00:00:00';
const END = '2026-05-15 00:00:00';

const base = {
  interval: 'day',
  startDate: START,
  endDate: END,
  projectId: PROJECT_ID,
  timezone: 'UTC',
};

const event = (overrides: Partial<IChartEvent> = {}): IChartEvent => ({
  id: 'A',
  name: 'screen_view',
  segment: 'event',
  filters: [],
  ...overrides,
});

const breakdown = (name: string): IChartBreakdown => ({ id: name, name });

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  setFallbackEnv({ DATABASE_URL: testDb.url, SELF_HOSTED: 'true' });
  // A project with a cohort, for the all-cohorts breakdown.
  await db.organization.create({
    data: { id: 'test-sql-org', name: 'Test', timezone: 'UTC' },
  });
  await db.project.create({
    data: { id: COHORT_PROJECT_ID, name: 'Test', organizationId: 'test-sql-org' },
  });
  await db.cohort.create({
    data: { id: COHORT_ID, name: 'Power users', projectId: COHORT_PROJECT_ID },
  });
}, 120_000);

afterAll(async () => {
  await disposeFallbackScope();
  setFallbackEnv(undefined);
  await testDb?.drop();
});

/** Plan the query: fails on unknown or ambiguous columns and bad types. */
async function explain(query: Sql): Promise<void> {
  await anQuery(sql`EXPLAIN ${query}`);
}

function text(query: Sql): string {
  return compile(query).text;
}

/** The compiled query with runs of whitespace collapsed. */
function flat(query: Sql): CompiledSql {
  const compiled = compile(query);
  return { ...compiled, text: compiled.text.replace(/\s+/g, ' ') };
}

describe('chart.service / getChartSql', () => {
  it('reads event properties through the events alias next to the groups join', async () => {
    const query = await getChartSql({
      ...base,
      event: event({
        segment: 'session',
        filters: [
          { name: 'group.plan', operator: 'is', value: ['pro'] },
          { name: 'properties.__query.utm_source', operator: 'is', value: ['awn'] },
        ],
      }),
      breakdowns: [breakdown('country'), breakdown('properties.__query.utm_source')],
    });
    const { text: sqlText, values } = flat(query);

    // analytics.groups (`_g`) has a properties column too, so an unqualified
    // one would be ambiguous: EXPLAIN catches it.
    expect(sqlText).toContain('CROSS JOIN LATERAL unnest(e.groups) AS _group_id');
    expect(sqlText).toContain('e.properties ->>');
    expect(sqlText).toContain('count(DISTINCT e.session_id) AS count');
    expect(values).toContain('__query.utm_source');
    await explain(query);
  });

  it('works without the groups join', async () => {
    const query = await getChartSql({
      ...base,
      event: event({
        filters: [
          { name: 'properties.__query.utm_source', operator: 'is', value: ['awn'] },
        ],
      }),
      breakdowns: [breakdown('properties.__query.utm_source')],
    });
    expect(text(query)).not.toContain('unnest(e.groups)');
    await explain(query);
  });

  it('drops the all-cohorts breakdown when the project has no cohorts', async () => {
    const query = await getChartSql({
      ...base,
      event: event({ segment: 'user' }),
      breakdowns: [breakdown('cohort')],
    });
    expect(text(query)).not.toContain('_all_cohorts');
    expect(text(query)).not.toContain('label_1');
    await explain(query);
  });

  it('labels each cohort of the profile with the all-cohorts breakdown', async () => {
    const query = await getChartSql({
      ...base,
      projectId: COHORT_PROJECT_ID,
      event: event(),
      breakdowns: [breakdown('cohort'), breakdown(`cohort:${COHORT_ID}`)],
    });
    const { text: sqlText, values } = flat(query);
    expect(sqlText).toContain(
      'INNER JOIN (SELECT profile_id, cohort_id FROM analytics.cohort_members WHERE project_id = $',
    );
    expect(sqlText).toContain('(CASE _all_cohorts.cohort_id WHEN $');
    expect(values).toEqual(
      expect.arrayContaining([COHORT_ID, 'Power users', 'Not Power users']),
    );
    await explain(query);
  });

  it('skips the fill when endDate < startDate', async () => {
    const query = await getChartSql({
      ...base,
      event: event(),
      breakdowns: [],
      startDate: END, // inverted
      endDate: START,
    });
    expect(text(query)).not.toContain('generate_series');
    await explain(query);
    expect(await anQuery(query)).toEqual([]);
  });

  it('skips the fill for an inverted week range', async () => {
    const query = await getChartSql({
      ...base,
      event: event(),
      breakdowns: [],
      interval: 'week',
      startDate: END,
      endDate: START,
    });
    expect(text(query)).not.toContain('generate_series');
  });

  it('fills every bucket of a valid range, rows or not', async () => {
    const query = await getChartSql({ ...base, event: event(), breakdowns: [] });
    expect(text(query)).toContain('generate_series');
    // An anti-join: `NOT IN` would rescan the rows for every bucket.
    expect(flat(query).text).toContain(
      'WHERE NOT EXISTS (SELECT 1 FROM _rows WHERE _rows.date = _fill.date)',
    );
    await explain(query);

    // ClickHouse's WITH FILL returned the fill rows for an empty result too.
    const rows = await anQuery(query);
    expect(rows).toHaveLength(31);
    expect(rows[0]).toEqual({
      label_0: null,
      date: '2026-04-14 00:00:00',
      count: 0,
      total_count: 0,
    });
    expect(rows.at(-1)?.date).toBe('2026-05-14 00:00:00');
  });

  it('fills minutes and hours in absolute time, so a DST gap has no bucket', async () => {
    const query = await getChartSql({
      ...base,
      event: event({ name: '*' }),
      breakdowns: [],
      interval: 'hour',
      startDate: '2026-03-29 00:00:00',
      endDate: '2026-03-29 04:59:59',
      timezone: 'Europe/Stockholm',
    });
    const rows = await anQuery<{ date: string }>(query);
    expect(rows.map((row) => row.date)).toEqual([
      '2026-03-29 00:00:00',
      '2026-03-29 01:00:00',
      '2026-03-29 03:00:00',
    ]);
  });

  it('fills weeks from the Monday of the start, as dates', async () => {
    const query = await getChartSql({
      ...base,
      event: event(),
      breakdowns: [],
      interval: 'week',
    });
    const rows = await anQuery<{ date: string }>(query);
    // 2026-04-14 is a Tuesday; the week holding the end is not filled.
    expect(rows.map((row) => row.date)).toEqual([
      '2026-04-13',
      '2026-04-20',
      '2026-04-27',
      '2026-05-04',
    ]);
  });

  it('property metric (property_sum) next to the groups join', async () => {
    const query = await getChartSql({
      ...base,
      event: event({
        segment: 'property_sum',
        property: 'properties.revenue_amount',
        filters: [{ name: 'group.plan', operator: 'is', value: ['pro'] }],
      }),
      breakdowns: [],
    });
    const { text: sqlText, values } = flat(query);
    expect(sqlText).toContain(
      "sum(analytics.to_float_or_null((COALESCE(e.properties ->> $",
    );
    expect(values).toContain('revenue_amount');
    await explain(query);
  });

  it('property metric on a numeric column aggregates the column itself', async () => {
    const query = await getChartSql({
      ...base,
      event: event({ segment: 'property_max', property: 'duration' }),
      breakdowns: [],
    });
    const { text: sqlText } = flat(query);
    expect(sqlText).toContain('max(e.duration) AS count');
    expect(sqlText).toContain('(e.duration IS NOT NULL)');
    await explain(query);
  });

  // Filter value type casting (filter.type). A date property compared with
  // `gte` crashed ClickHouse's `toFloat64('2019-01-01')`; the declared type
  // routes both sides through the date parse instead.
  it('date-typed gte filter compares parsed dates, not floats', async () => {
    const query = await getChartSql({
      ...base,
      event: event({
        filters: [
          { name: 'properties.cook', operator: 'gte', value: ['2019-01-01'], type: 'date' },
        ],
      }),
      breakdowns: [],
    });
    const { text: sqlText, values } = flat(query);
    expect(sqlText).toContain("pg_input_is_valid(_ts.v, 'timestamp')");
    expect(sqlText).toContain('::date');
    expect(sqlText).not.toContain('to_float_or_null');
    expect(values).toContain('2019-01-01');
    await explain(query);
  });

  it('number-typed gte filter casts both sides to floats', async () => {
    const query = await getChartSql({
      ...base,
      event: event({
        filters: [
          { name: 'properties.age', operator: 'gte', value: ['5'], type: 'number' },
        ],
      }),
      breakdowns: [],
    });
    expect(flat(query).text).toContain(
      "analytics.to_float_or_null(COALESCE(e.properties ->> $9::text, '')) >= analytics.to_float_or_null($10::text)",
    );
    await explain(query);
  });

  it('untyped gte filter reads a non-number property as 0 (toFloat64OrZero)', async () => {
    const query = await getChartSql({
      ...base,
      event: event({
        filters: [{ name: 'properties.age', operator: 'gte', value: ['5'] }],
      }),
      breakdowns: [],
    });
    expect(flat(query).text).toContain(
      "COALESCE(analytics.to_float_or_null(COALESCE(e.properties ->> $9::text, '')), 0) >=",
    );
    await explain(query);
  });

  it('one_event_per_user buckets the latest event of each profile', async () => {
    const query = await getChartSql({
      ...base,
      event: event({ segment: 'one_event_per_user' }),
      breakdowns: [],
    });
    const { text: sqlText } = flat(query);
    expect(sqlText).toContain('SELECT DISTINCT ON (e.profile_id)');
    expect(sqlText).toContain('ORDER BY e.profile_id, e.created_at DESC');
    expect(sqlText).not.toContain('total_count');
    await explain(query);
  });

  it('one_event_per_user + property breakdown computes the label on the latest event', async () => {
    const query = await getChartSql({
      ...base,
      event: event({ segment: 'one_event_per_user' }),
      breakdowns: [breakdown('properties.linked')],
    });
    await explain(query);
  });

  // Saved reports / older clients send field names that don't match the
  // events schema; they must never reach the SQL as identifiers.
  it('normalizes a camelCase filter alias (referrerName → referrer_name)', async () => {
    const query = await getChartSql({
      ...base,
      event: event({
        filters: [{ name: 'referrerName', operator: 'is', value: ['email'] }],
      }),
      breakdowns: [],
    });
    expect(text(query)).toContain('e.referrer_name = $');
    expect(text(query)).not.toContain('referrerName');
    await explain(query);
  });

  it('routes a bare utm_source filter through the properties map', async () => {
    const query = await getChartSql({
      ...base,
      event: event({
        filters: [{ name: 'utm_source', operator: 'is', value: ['awn'] }],
      }),
      breakdowns: [],
    });
    const { text: sqlText, values } = flat(query);
    expect(values).toContain('__query.utm_source');
    expect(sqlText).not.toMatch(/(?<![._\w])utm_source/);
    await explain(query);
  });

  it('drops an unknown breakdown rather than emitting it', async () => {
    // `temple_name` is a custom property saved as a top-level breakdown.
    const query = await getChartSql({
      ...base,
      event: event(),
      breakdowns: [breakdown('temple_name')],
    });
    const { text: sqlText, values } = flat(query);
    expect(sqlText).not.toContain('temple_name');
    expect(values).not.toContain('temple_name');
    expect(sqlText).not.toContain('label_1');
    await explain(query);
  });

  it('drops an unknown filter rather than emitting it', async () => {
    const query = await getChartSql({
      ...base,
      event: event({
        filters: [{ name: 'totally_made_up_column', operator: 'is', value: ['x'] }],
      }),
      breakdowns: [],
    });
    const { text: sqlText, values } = flat(query);
    expect(sqlText).not.toContain('totally_made_up_column');
    expect(values).not.toContain('x');
    await explain(query);
  });

  it('reads the range bounds and buckets as project wall-clock time', async () => {
    const query = await getChartSql({
      ...base,
      event: event(),
      breakdowns: [],
      interval: 'hour',
      timezone: 'America/New_York',
    });
    const { text: sqlText, values } = flat(query);
    // Grouped by the wall-clock bucket, rendered like ClickHouse's DateTime.
    expect(sqlText).toContain(
      "date_trunc('hour', (e.created_at AT TIME ZONE $2::text)) AS date",
    );
    expect(sqlText).toContain("to_char(_chart.date, 'YYYY-MM-DD HH24:MI:SS') AS date");
    expect(sqlText).toContain('e.created_at >= ($5::timestamp AT TIME ZONE $6::text)');
    expect(values.slice(1, 6)).toEqual([
      'America/New_York',
      PROJECT_ID,
      'screen_view',
      START,
      'America/New_York',
    ]);
  });
});

describe('chart.service / getAggregateChartSql', () => {
  it('drops the all-cohorts breakdown on a project without cohorts', async () => {
    const query = await getAggregateChartSql({
      ...base,
      event: event({ segment: 'user' }),
      breakdowns: [breakdown('cohort')],
    });
    expect(text(query)).not.toContain('_all_cohorts');
    await explain(query);
  });

  it('properties + group breakdown is unambiguous', async () => {
    const query = await getAggregateChartSql({
      ...base,
      event: event({
        filters: [{ name: 'group.plan', operator: 'is', value: ['pro'] }],
      }),
      breakdowns: [breakdown('properties.__query.utm_source')],
    });
    expect(text(query)).toContain('e.properties ->>');
    await explain(query);
  });

  it('one_event_per_user applies a group filter inside the latest-event scan', async () => {
    const query = await getAggregateChartSql({
      ...base,
      event: event({
        segment: 'one_event_per_user',
        filters: [{ name: 'group.plan', operator: 'is', value: ['pro'] }],
      }),
      breakdowns: [],
    });
    expect(flat(query).text).toMatch(
      /FROM \(SELECT DISTINCT ON \(e\.profile_id\) .* unnest\(e\.groups\) .* \(_group_id = \$\d+::text\) ORDER BY e\.profile_id, e\.created_at DESC\) AS _latest/,
    );
    await explain(query);
  });

  it('one_event_per_user + property breakdown resolves the events alias', async () => {
    const query = await getAggregateChartSql({
      ...base,
      event: event({ segment: 'one_event_per_user' }),
      breakdowns: [breakdown('properties.linked')],
    });
    await explain(query);
  });

  it('orders the biggest groups first and applies the limit', async () => {
    const query = await getAggregateChartSql({
      ...base,
      limit: 5,
      event: event(),
      breakdowns: [breakdown('device')],
    });
    const { text: sqlText, values } = flat(query);
    expect(sqlText).toContain('ORDER BY count DESC, label_1 LIMIT $');
    expect(values.at(-1)).toBe(5);
    // The range start stands in for the bucket.
    expect(values[1]).toBe(START);
    await explain(query);
  });

  it('truncates a fractional limit and ignores one that is not positive', async () => {
    const fractional = flat(
      await getAggregateChartSql({ ...base, limit: 2.5, event: event(), breakdowns: [] }),
    );
    expect(fractional.values.at(-1)).toBe(2);
    const negative = flat(
      await getAggregateChartSql({ ...base, limit: -1, event: event(), breakdowns: [] }),
    );
    expect(negative.text).not.toContain('LIMIT');
  });
});

describe('chart.service / profile-property narrowing', () => {
  const profileFilter = {
    id: 'f1',
    name: 'profile.properties.plan',
    operator: 'is' as const,
    value: ['pro'],
  };

  it('selects only the referenced keys in the profile join', async () => {
    const query = await getChartSql({
      ...base,
      event: event({ filters: [profileFilter] }),
      breakdowns: [breakdown('profile.properties.experiment')],
    });
    const { text: sqlText, values } = flat(query);

    // One column per referenced key...
    expect(sqlText).toContain(
      'LEFT JOIN (SELECT id, properties ->> $3::text AS pp_0, properties ->> $4::text AS pp_1 FROM analytics.profiles WHERE project_id = $5) AS profile ON profile.id = e.profile_id',
    );
    expect(values.slice(2, 4)).toEqual(['plan', 'experiment']);
    // ...and every reference reads those columns.
    expect(sqlText).toContain("COALESCE(profile.pp_1, '') AS label_1");
    expect(sqlText).toContain("COALESCE(profile.pp_0, '') = $");
    await explain(query);
  });

  it('falls back to the full map for wildcard refs', async () => {
    const query = await getChartSql({
      ...base,
      event: event({
        filters: [
          {
            id: 'f1',
            name: 'profile.properties.experiments.*.name',
            operator: 'is' as const,
            value: ['a'],
          },
        ],
      }),
      breakdowns: [],
    });
    expect(flat(query).text).toContain(
      'LEFT JOIN (SELECT id, properties FROM analytics.profiles WHERE project_id = $',
    );
    await explain(query);
  });

  it('binds keys ClickHouse could not alias (quotes, backticks) like any other', async () => {
    const key = "plan`tier'x";
    const query = await getChartSql({
      ...base,
      event: event({
        filters: [
          { id: 'f1', name: `profile.properties.${key}`, operator: 'is' as const, value: ['a'] },
        ],
      }),
      breakdowns: [],
    });
    const { text: sqlText, values } = flat(query);
    expect(values).toContain(key);
    expect(sqlText).not.toContain('tier');
    expect(sqlText).toContain('properties ->> $3::text AS pp_0');
    await explain(query);
  });

  it('collects the math-metric property too', async () => {
    const query = await getChartSql({
      ...base,
      event: event({
        segment: 'property_average',
        property: 'profile.properties.age',
        filters: [profileFilter],
      }),
      breakdowns: [],
    });
    const { text: sqlText, values } = flat(query);
    // The metric's key is narrowed alongside the filter's.
    expect(values.slice(2, 4)).toEqual(['plan', 'age']);
    expect(sqlText).toContain(
      "avg(analytics.to_float_or_null((COALESCE(profile.pp_1, ''))::text)) AS count",
    );
    await explain(query);
  });

  it('joins the profile for a metric-only profile property', async () => {
    // No profile filter or breakdown: the metric alone needs the join.
    const query = await getChartSql({
      ...base,
      event: event({
        segment: 'property_average',
        property: 'profile.properties.age',
      }),
      breakdowns: [],
    });
    expect(flat(query).text).toContain(
      'LEFT JOIN (SELECT id, properties ->> $3::text AS pp_0 FROM analytics.profiles WHERE project_id = $4) AS profile ON profile.id = e.profile_id',
    );
    await explain(query);
  });

  it('selects the profile columns a breakdown reads', async () => {
    const query = await getChartSql({
      ...base,
      event: event({ segment: 'user' }),
      breakdowns: [breakdown('profile.last_name')],
    });
    const { text: sqlText } = flat(query);
    expect(sqlText).toContain('"last_name" FROM analytics.profiles');
    expect(sqlText).toContain("COALESCE(profile.last_name, '') AS label_1");
    await explain(query);
  });

  it('narrowed aggregate chart SQL plans', async () => {
    const query = await getAggregateChartSql({
      ...base,
      event: event({ filters: [profileFilter] }),
      breakdowns: [breakdown('profile.properties.experiment')],
    });
    expect(text(query)).not.toContain('profile.properties');
    await explain(query);
  });
});

describe('chart.service / total_count in the same pass', () => {
  it('scans events once and counts distinct profiles over the whole range (no breakdown)', async () => {
    const query = await getChartSql({ ...base, event: event(), breakdowns: [] });
    const { text: sqlText } = flat(query);
    expect(sqlText.match(/FROM analytics\.events/g)).toHaveLength(1);
    expect(sqlText).toContain('GROUP BY GROUPING SETS ((date), ())');
    expect(sqlText).toContain('max(_uc) FILTER (WHERE date IS NULL) OVER () AS total_count');
  });

  it('partitions the distinct profiles by the breakdown labels', async () => {
    const query = await getChartSql({
      ...base,
      event: event(),
      breakdowns: [breakdown('properties.experiment')],
    });
    const { text: sqlText } = flat(query);
    expect(sqlText.match(/FROM analytics\.events/g)).toHaveLength(1);
    expect(sqlText).toContain('GROUP BY GROUPING SETS ((date, label_1), (label_1))');
    expect(sqlText).toContain('OVER (PARTITION BY label_1) AS total_count');
    await explain(query);
  });

  it('counts per bucket and distinct profiles per label across buckets', async () => {
    const at = (day: number, hour: number) =>
      `2026-04-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00:00.000`;
    const row = (
      id: number,
      profileId: string,
      createdAt: string,
      device: string,
    ): EventWriteRow => ({
      id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      name: 'screen_view',
      project_id: DATA_PROJECT_ID,
      profile_id: profileId,
      device_id: profileId,
      session_id: `s-${profileId}`,
      properties: {},
      created_at: createdAt,
      device,
    });
    await insertEvents([
      row(1, 'p1', at(14, 10), 'desktop'),
      row(2, 'p1', at(14, 11), 'desktop'),
      row(3, 'p2', at(14, 12), 'desktop'),
      row(4, 'p1', at(15, 10), 'desktop'),
      row(5, 'p3', at(15, 10), 'mobile'),
      // Outside the range.
      row(6, 'p4', at(13, 10), 'desktop'),
    ]);

    const query = await getChartSql({
      ...base,
      projectId: DATA_PROJECT_ID,
      event: event(),
      breakdowns: [breakdown('device')],
      endDate: '2026-04-16 00:00:00',
    });
    expect(await anQuery(query)).toEqual([
      {
        label_0: 'screen_view',
        date: '2026-04-14 00:00:00',
        label_1: 'desktop',
        count: 3,
        total_count: 2,
      },
      {
        label_0: 'screen_view',
        date: '2026-04-15 00:00:00',
        label_1: 'desktop',
        count: 1,
        total_count: 2,
      },
      {
        label_0: 'screen_view',
        date: '2026-04-15 00:00:00',
        label_1: 'mobile',
        count: 1,
        total_count: 1,
      },
    ]);

    const aggregate = await getAggregateChartSql({
      ...base,
      projectId: DATA_PROJECT_ID,
      event: event({ segment: 'user' }),
      breakdowns: [breakdown('device')],
      endDate: '2026-04-16 00:00:00',
    });
    expect(await anQuery(aggregate)).toEqual([
      { label_0: 'screen_view', label_1: 'desktop', count: 2, date: START },
      { label_0: 'screen_view', label_1: 'mobile', count: 1, date: START },
    ]);
  });
});
