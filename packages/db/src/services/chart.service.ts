/** biome-ignore-all lint/style/useDefaultSwitchClause: switch cases are exhaustive by design */
/**
 * Report charts. getChartSql / getAggregateChartSql build the chart engine's
 * queries on the Postgres analytics schema; filters, property expressions
 * and cohort joins come from ../analytics/filters.ts. The field-name helpers
 * are re-exported from ../analytics/fields.ts and ../analytics/cohorts.ts.
 */
import type {
  IChartBreakdown,
  IChartEventSegment,
  IGetChartDataInput,
  IInterval,
} from '@openpanel/validation';
import {
  type CohortMetadata,
  fetchCohortsMetadata,
  fetchProjectCohorts,
} from '../analytics/cohorts';
import { formatClickhouseDate } from '../analytics/dates';
import {
  collectBreakdownCohortIds,
  collectProfilePropertyKeys as collectProfileKeysForPostgres,
  extractCohortId,
  isAllCohortsBreakdown,
  isKnownEventField,
  NUMERIC_FILTER_COLUMNS,
  profileJoinColumns,
} from '../analytics/fields';
import {
  allCohortsLabelExpr,
  allCohortsMembershipQuery,
  type EventFilterScope,
  eventFilterClauses,
  eventPropertyExpr,
  GROUP_JOIN,
  groupJoin,
  narrowedProfileSelect,
  narrowProfileScope,
} from '../analytics/filters';
import { clix } from '../analytics/query-builder';
import { and, empty, ident, join, raw, type Sql, sql } from '../analytics/sql';
import {
  fromLocal,
  interval as intervalOf,
  startOfLocal,
  type TimeCtx,
  toLocal,
} from '../analytics/time';

export {
  type CohortMetadata,
  fetchCohortsMetadata,
  fetchProjectCohorts,
} from '../analytics/cohorts';
export {
  collectBreakdownCohortIds,
  extractCohortId,
  isAllCohortsBreakdown,
  isKnownEventField,
  normalizeEventField,
} from '../analytics/fields';

// --- chart queries (Postgres) ----------------------------------------------------------
//
// The rows are the ones the ClickHouse queries returned, so the engine's
// groupByLabels / compute / format stages are unchanged: `label_0` (the
// event name), `label_1…` (one per breakdown), `date`, `count` and, for the
// time series, `total_count`. Time buckets and the range bounds are project
// wall-clock time, as ClickHouse's `session_timezone` made them.

/** The aggregate of each `property_*` segment. */
const PROPERTY_AGGREGATES: Partial<
  Record<IChartEventSegment, 'sum' | 'avg' | 'max' | 'min'>
> = {
  property_sum: 'sum',
  property_average: 'avg',
  property_max: 'max',
  property_min: 'min',
};

/** Alias of the joined profile (the ClickHouse `profile` CTE). */
const PROFILE_ALIAS = 'profile';

/** Alias of the all-cohorts membership join. */
const ALL_COHORTS_ALIAS = '_all_cohorts';

type ChartSourceInput = Pick<
  IGetChartDataInput,
  'event' | 'projectId' | 'startDate' | 'endDate'
>;

interface ResolvedBreakdowns {
  breakdowns: IChartBreakdown[];
  /** The project's cohorts, when an all-cohorts breakdown is kept. */
  allCohorts: CohortMetadata[];
  /** Names of the `cohort:<id>` breakdowns' cohorts. */
  cohortNames: Map<string, CohortMetadata>;
}

/**
 * The breakdowns a chart query can resolve, and the cohort names their
 * labels need. Unknown field names are dropped: saved reports carry names
 * like `temple_name`, a property saved as if it were a column. So is the
 * all-cohorts breakdown of a project without cohorts, whose every label
 * would be 'Unknown'.
 */
async function resolveBreakdowns(
  breakdowns: IChartBreakdown[],
  projectId: string,
): Promise<ResolvedBreakdowns> {
  let kept = breakdowns.filter((breakdown) => isKnownEventField(breakdown.name));
  const wantsAllCohorts = kept.some((breakdown) =>
    isAllCohortsBreakdown(breakdown.name),
  );
  const allCohorts = wantsAllCohorts ? await fetchProjectCohorts(projectId) : [];
  if (wantsAllCohorts && allCohorts.length === 0) {
    kept = kept.filter((breakdown) => !isAllCohortsBreakdown(breakdown.name));
  }
  const cohortNames = await fetchCohortsMetadata(collectBreakdownCohortIds(kept));
  return { breakdowns: kept, allCohorts, cohortNames };
}

/** What the time series and the aggregate query share. */
interface ChartSource {
  /** `analytics.events AS e` and its joins. */
  from: Sql;
  where: Sql;
  /** One label expression per breakdown (`label_1`, `label_2`, …). */
  labels: Sql[];
  /** The value of a group of rows, `count`. */
  measure: Sql;
}

/**
 * `LEFT JOIN (…) AS profile`: the row's profile with its id, the columns
 * `profile.<column>` names read and only the properties keys the query
 * references (the whole map when a wildcard needs it).
 */
function profileJoinSource(
  refs: readonly { name: string }[],
  projectId: string,
): { join: Sql; columns: Map<string, string> } {
  const profileRefs = refs.filter((ref) => ref.name.startsWith('profile.'));
  const { keys, needsFullMap } = collectProfileKeysForPostgres(profileRefs);
  const { select, columns } = narrowedProfileSelect(keys, needsFullMap);
  const profileColumns = profileJoinColumns(profileRefs.map((ref) => ref.name))
    .filter((column) => column !== 'id' && column !== 'properties')
    .map((column) => ident(column));
  const alias = raw(PROFILE_ALIAS);
  return {
    join: sql`LEFT JOIN (SELECT ${join([select, ...profileColumns])} FROM analytics.profiles WHERE project_id = ${projectId}) AS ${alias} ON ${alias}.id = e.profile_id`,
    columns,
  };
}

/** `count` for the segments that are not `property_*` aggregates. */
function segmentMeasure(segment: IChartEventSegment): Sql {
  switch (segment) {
    case 'user':
      return sql`count(DISTINCT e.profile_id)`;
    case 'session':
      return sql`count(DISTINCT e.session_id)`;
    case 'group':
      return sql`count(DISTINCT ${raw(GROUP_JOIN.idAlias)})`;
    case 'user_average':
      return sql`count(*)::double precision / count(DISTINCT e.profile_id)`;
    default:
      return sql`count(*)`;
  }
}

function chartSource(
  { event, projectId, startDate, endDate }: ChartSourceInput,
  ctx: TimeCtx,
  { breakdowns, allCohorts, cohortNames }: ResolvedBreakdowns,
): ChartSource {
  let scope: EventFilterScope = { ...ctx, projectId, alias: 'e' };
  const refs: { name: string }[] = [
    ...event.filters,
    ...breakdowns,
    // A property_* metric can read a profile or group property on its own.
    ...(event.property ? [{ name: event.property }] : []),
  ];
  const joins: Sql[] = [];

  const hasAllCohortsBreakdown = breakdowns.some((breakdown) =>
    isAllCohortsBreakdown(breakdown.name),
  );
  if (hasAllCohortsBreakdown) {
    // One row per cohort of the event's profile; profiles in none drop out.
    joins.push(
      sql`INNER JOIN (${allCohortsMembershipQuery(projectId)}) AS ${raw(ALL_COHORTS_ALIAS)} ON ${raw(ALL_COHORTS_ALIAS)}.profile_id = e.profile_id`,
    );
  }
  if (
    event.segment === 'group' ||
    refs.some((ref) => ref.name.startsWith('group.'))
  ) {
    // One row per group of the event (ClickHouse's ARRAY JOIN): events
    // without groups drop out, whether or not a group filter applies.
    joins.push(groupJoin(scope));
    scope.groupJoin = GROUP_JOIN;
  }
  if (refs.some((ref) => ref.name.startsWith('profile.'))) {
    const profile = profileJoinSource(refs, projectId);
    joins.push(profile.join);
    scope = narrowProfileScope({ ...scope, profileAlias: PROFILE_ALIAS }, profile.columns);
  }

  const where: Sql[] = [sql`e.project_id = ${projectId}`];
  if (event.name !== '*') {
    where.push(sql`e.name = ${event.name}::text`);
  }
  // `created_at >= toDateTime('<start>')`: the bounds are wall-clock times
  // in the project zone.
  if (startDate) {
    where.push(sql`e.created_at >= ${fromLocal(formatClickhouseDate(startDate), ctx)}`);
  }
  if (endDate) {
    where.push(sql`e.created_at <= ${fromLocal(formatClickhouseDate(endDate), ctx)}`);
  }
  where.push(...eventFilterClauses(event.filters, scope));

  let measure = segmentMeasure(event.segment);
  const aggregate = PROPERTY_AGGREGATES[event.segment];
  if (aggregate && event.property) {
    const value = eventPropertyExpr(event.property, scope);
    if (NUMERIC_FILTER_COLUMNS.has(event.property)) {
      // Sums and averages accumulate in double precision (a real column
      // would otherwise be summed in float4); min/max keep the column type.
      const input =
        aggregate === 'sum' || aggregate === 'avg'
          ? sql`(${value})::double precision`
          : value;
      measure = sql`${raw(aggregate)}(${input})`;
      where.push(sql`${value} IS NOT NULL`);
    } else {
      // toFloat64OrNull: values that are not numbers stay out of the
      // aggregate; empty ones (and rows without the property) are skipped.
      const text = sql`(${value})::text`;
      measure = sql`${raw(aggregate)}(analytics.to_float_or_null(${text}))`;
      where.push(sql`${text} <> ''`);
    }
  }

  const labels = breakdowns.map((breakdown) => {
    if (isAllCohortsBreakdown(breakdown.name)) {
      return allCohortsLabelExpr(allCohorts, ALL_COHORTS_ALIAS);
    }
    const cohortId = extractCohortId(breakdown.name);
    return eventPropertyExpr(
      breakdown.name,
      scope,
      cohortId ? { id: cohortId, name: cohortNames.get(cohortId)?.name } : undefined,
    );
  });

  return {
    from: sql`analytics.events AS e ${join(joins, ' ')}`,
    where: and(where),
    labels,
    measure,
  };
}

/** `label_1`, `label_2`, … and their select-list entries. */
function labelColumns(labels: readonly Sql[]): { names: Sql[]; select: Sql[] } {
  const names = labels.map((_, index) => raw(`label_${index + 1}`));
  return {
    names,
    select: labels.map((label, index) => sql`${label} AS ${names[index]!}`),
  };
}

/**
 * The rows of the latest event of each profile (`one_event_per_user`), with
 * the given select list computed on them.
 */
function latestEventPerProfile(source: ChartSource, select: Sql[]): Sql {
  return sql`SELECT DISTINCT ON (e.profile_id) ${join(select)}
    FROM ${source.from}
    WHERE ${source.where}
    ORDER BY e.profile_id, e.created_at DESC`;
}

/**
 * The buckets of ClickHouse's `ORDER BY date WITH FILL FROM <bucket of the
 * start> TO <bucket of the end> STEP 1 <unit>`: every bucket from the one
 * holding the start up to, not including, the one holding the end, as
 * project wall-clock `timestamp`s like the rows' buckets. Minutes and hours
 * step in absolute time, so a DST gap has no bucket; days, weeks and months
 * step on the calendar.
 */
function fillBuckets(
  interval: IInterval,
  startDate: string,
  endDate: string,
  ctx: TimeCtx,
): Sql {
  const first = startOfLocal(sql`${startDate}::timestamp`, interval);
  const last = startOfLocal(sql`${endDate}::timestamp`, interval);
  const step = intervalOf(1, interval);
  const bucket = raw('_bucket');
  if (interval === 'minute' || interval === 'hour') {
    const from = fromLocal(first, ctx);
    const to = fromLocal(last, ctx);
    return sql`SELECT ${toLocal(bucket, ctx)} AS date
      FROM generate_series(${from}, ${to}, ${step}) AS ${bucket}
      WHERE ${bucket} < ${to}`;
  }
  return sql`SELECT ${bucket} AS date
    FROM generate_series(${first}, ${last}, ${step}) AS ${bucket}
    WHERE ${bucket} < ${last}`;
}

/**
 * The time series of one chart event: a row per bucket and breakdown
 * labels, plus a row without labels and with a zero count for every bucket
 * of the range that has none (WITH FILL; groupByLabels only takes its date).
 * `total_count` is the number of distinct profiles over the whole range for
 * the row's labels (ClickHouse merged uniq states over a window); the
 * grouping sets compute both in one pass over the events. Buckets stay
 * `timestamp`s (cheaper to sort and join than text) until the output
 * renders them like ClickHouse did.
 */
export async function getChartSql(
  input: IGetChartDataInput & { timezone: string },
): Promise<Sql> {
  const { event, interval, startDate, endDate, timezone } = input;
  const ctx: TimeCtx = { timezone };
  const source = chartSource(
    input,
    ctx,
    await resolveBreakdowns(input.breakdowns, input.projectId),
  );
  const labels = labelColumns(source.labels);
  const bucket = clix.toStartOf(raw('e.created_at'), interval, ctx);
  const label0 = sql`${event.name}::text AS label_0`;
  const date = raw('date');
  const withTotal = event.segment !== 'one_event_per_user';

  let rows: Sql;
  if (withTotal) {
    const sets =
      labels.names.length > 0
        ? sql`(date, ${join(labels.names)}), (${join(labels.names)})`
        : sql`(date), ()`;
    const partition =
      labels.names.length > 0 ? sql`PARTITION BY ${join(labels.names)}` : empty;
    rows = sql`SELECT ${join([label0, date, ...labels.names, raw('count'), raw('total_count')])}
      FROM (
        SELECT ${join([date, ...labels.names, raw('count')])},
          max(_uc) FILTER (WHERE date IS NULL) OVER (${partition}) AS total_count
        FROM (
          SELECT ${join([
            sql`${bucket} AS date`,
            ...labels.select,
            sql`${source.measure} AS count`,
            sql`count(DISTINCT e.profile_id) AS _uc`,
          ])}
          FROM ${source.from}
          WHERE ${source.where}
          GROUP BY GROUPING SETS (${sets})
        ) AS _sets
      ) AS _series
      WHERE date IS NOT NULL`;
  } else {
    // The latest event of each profile in the range, bucketed by its time.
    rows = sql`SELECT ${join([label0, date, ...labels.names, raw('count(*) AS count')])}
      FROM (${latestEventPerProfile(source, [sql`${bucket} AS date`, ...labels.select])}) AS _latest
      GROUP BY ${join([date, ...labels.names])}`;
  }

  const output = join([
    raw('label_0'),
    sql`${clix.formatBucket(raw('_chart.date'), interval)} AS date`,
    ...labels.names,
    raw('count'),
    ...(withTotal ? [raw('total_count')] : []),
  ]);
  // Qualified, so the rows sort by the bucket rather than its text.
  const orderBy = join([
    raw('_chart.date'),
    ...labels.names.map((_, index) => raw(`_chart.label_${index + 1}`)),
  ]);
  // No fill for an inverted range, as ClickHouse rejected TO < FROM.
  const hasValidFillRange =
    !!startDate && !!endDate && new Date(endDate) >= new Date(startDate);
  if (!hasValidFillRange) {
    return sql`SELECT ${output} FROM (${rows}) AS _chart ORDER BY ${orderBy}`;
  }
  const fillRow = join([
    raw('NULL'),
    raw('_fill.date'),
    ...labels.names.map(() => raw('NULL')),
    raw('0'),
    ...(withTotal ? [raw('0')] : []),
  ]);
  const fill = fillBuckets(
    interval,
    formatClickhouseDate(startDate),
    formatClickhouseDate(endDate),
    ctx,
  );
  // NOT EXISTS plans as an anti-join; NOT IN would rescan _rows per bucket.
  return sql`WITH _rows AS (${rows})
    SELECT ${output} FROM (
      SELECT * FROM _rows
      UNION ALL
      SELECT ${fillRow} FROM (${fill}) AS _fill
      WHERE NOT EXISTS (SELECT 1 FROM _rows WHERE _rows.date = _fill.date)
    ) AS _chart
    ORDER BY ${orderBy}`;
}

/**
 * One row per event name and breakdown labels over the whole range, biggest
 * first (bar and pie charts). `date` is the range start, which groupByLabels
 * needs as the single data point's date.
 */
export async function getAggregateChartSql(
  input: Omit<IGetChartDataInput, 'interval' | 'chartType'> & {
    timezone: string;
  },
): Promise<Sql> {
  const { event, startDate, limit, timezone } = input;
  const ctx: TimeCtx = { timezone };
  const source = chartSource(
    input,
    ctx,
    await resolveBreakdowns(input.breakdowns, input.projectId),
  );
  const labels = labelColumns(source.labels);
  const label0 = sql`${event.name}::text AS label_0`;
  const date = sql`${startDate}::text AS date`;
  const groupBy = join([...labels.names, raw('label_0')]);

  if (event.segment === 'one_event_per_user') {
    return sql`SELECT ${join([label0, ...labels.names, raw('count(*) AS count'), date])}
      FROM (${latestEventPerProfile(source, [raw('e.profile_id'), ...labels.select])}) AS _latest
      GROUP BY ${groupBy}`;
  }

  return sql`SELECT ${join([label0, ...labels.select, sql`${source.measure} AS count`, date])}
    FROM ${source.from}
    WHERE ${source.where}
    GROUP BY ${groupBy}
    ORDER BY ${join([raw('count DESC'), ...labels.names])}
    ${limit && limit > 0 ? sql`LIMIT ${Math.trunc(limit)}` : empty}`;
}
