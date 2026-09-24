/** biome-ignore-all lint/style/useDefaultSwitchClause: switch cases are exhaustive by design */
/**
 * Report charts. getChartSql / getAggregateChartSql build the chart engine's
 * queries on the Postgres analytics schema (see "chart queries" below).
 *
 * The ClickHouse string builders in this file (getEventFiltersWhereClause,
 * getSelectPropertyKey, the cohort and profile-narrowing helpers, …) are
 * kept for the services that still run on ClickHouse; their Postgres
 * successors live in ../analytics/filters.ts. The field-name helpers that
 * never produced SQL are re-exported from ../analytics/fields.ts and
 * ../analytics/cohorts.ts.
 */
import { stripLeadingAndTrailingSlashes } from '@openpanel/common';
import {
  getCohortIds,
  type IChartBreakdown,
  type IChartEventFilter,
  type IChartEventSegment,
  type IGetChartDataInput,
  type IInterval,
} from '@openpanel/validation';
import sqlstring from 'sqlstring';
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
  normalizeEventField,
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
import { TABLE_NAMES } from '../clickhouse/client';
import { buildTypedClause, hasTypedCast, isTypedOperator } from './filter-cast';

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

// Top-level columns on the events table. Derived from the migration in
// packages/db/code-migrations/3-init-ch.ts (+ revenue added in 6-add-revenue-
// column.ts). Used by `resolveEventColumn` to distinguish real columns from
// property keys and reject unknown identifiers before they reach ClickHouse.
const EVENT_TOP_LEVEL_COLUMNS = new Set<string>([
  'id',
  'name',
  'sdk_name',
  'sdk_version',
  'device_id',
  'profile_id',
  'project_id',
  'session_id',
  'path',
  'origin',
  'referrer',
  'referrer_name',
  'referrer_type',
  'duration',
  'revenue',
  'created_at',
  'country',
  'city',
  'region',
  'longitude',
  'latitude',
  'os',
  'os_version',
  'browser',
  'browser_version',
  'device',
  'brand',
  'model',
  'imported_at',
]);

// Older clients / saved reports send some field names in camelCase. Map them
// to the canonical snake_case ClickHouse column so they don't fall through as
// unknown identifiers. The bare values (`utm_source` etc.) actually live in
// the `properties` map — `normalizeEventField` rewrites those into the
// `properties.__query.utm_*` form.
const EVENT_FIELD_ALIASES: Record<string, string> = {
  referrerName: 'referrer_name',
  referrerType: 'referrer_type',
  sessionId: 'session_id',
  deviceId: 'device_id',
  profileId: 'profile_id',
  projectId: 'project_id',
  osVersion: 'os_version',
  browserVersion: 'browser_version',
  sdkName: 'sdk_name',
  sdkVersion: 'sdk_version',
  createdAt: 'created_at',
  importedAt: 'imported_at',
};

export function getCohortCteName(cohortId: string): string {
  return `\`cohort-${cohortId}\``;
}

export function getCohortAlias(cohortId: string): string {
  return `cohort_${cohortId.replace(/-/g, '_')}`;
}

export function buildCohortMembershipQuery(
  cohortId: string,
  projectId: string,
): string {
  return `
    SELECT profile_id
    FROM ${TABLE_NAMES.cohort_members} FINAL
    WHERE cohort_id = ${sqlstring.escape(cohortId)}
      AND project_id = ${sqlstring.escape(projectId)}
  `;
}

export function buildInlineCohortJoin(
  cohortId: string,
  projectId: string,
  tableAlias: string,
): string {
  const cohortAlias = getCohortAlias(cohortId);
  const cohortQuery = buildCohortMembershipQuery(cohortId, projectId);
  return `LEFT ANY JOIN (${cohortQuery}) AS ${cohortAlias} ON ${cohortAlias}.profile_id = ${tableAlias}.profile_id`;
}

export function buildAllCohortsMembershipQuery(
  projectId: string,
): string {
  return `
    SELECT profile_id, cohort_id
    FROM ${TABLE_NAMES.cohort_members} FINAL
    WHERE project_id = ${sqlstring.escape(projectId)}
  `;
}

export function buildAllCohortsLabelExpr(
  cohorts: CohortMetadata[],
  alias = '_all_cohorts',
): string {
  if (cohorts.length === 0) {
    return "'Unknown'";
  }
  const ids = cohorts.map((c) => sqlstring.escape(c.id)).join(', ');
  const names = cohorts.map((c) => sqlstring.escape(c.name)).join(', ');
  return `transform(${alias}.cohort_id, [${ids}], [${names}], 'Unknown')`;
}

export function transformPropertyKey(property: string) {
  const propertyPatterns = ['properties', 'profile.properties'];
  const match = propertyPatterns.find((pattern) =>
    property.startsWith(`${pattern}.`)
  );

  if (!match) {
    return property;
  }

  if (property.includes('*')) {
    return property
      .replace(/^properties\./, '')
      .replace('.*.', '.%.')
      .replace(/\[\*\]$/, '.%')
      .replace(/\[\*\].?/, '.%.');
  }

  return `${match}['${property.replace(new RegExp(`^${match}.`), '')}']`;
}

// Returns a SQL expression for a group property via the _g JOIN alias
// property format: "group.name", "group.type", "group.properties.plan"
export function getGroupPropertySql(property: string): string {
  const withoutPrefix = property.replace(/^group\./, '');
  if (withoutPrefix === 'name') {
    return '_g.name';
  }
  if (withoutPrefix === 'type') {
    return '_g.type';
  }
  if (withoutPrefix.startsWith('properties.')) {
    const propKey = withoutPrefix.replace(/^properties\./, '');
    return `_g.properties[${sqlstring.escape(propKey)}]`;
  }
  return '_group_id';
}

// Returns the SELECT expression when querying the groups table directly (no join alias).
// Use for fetching distinct values for group.* properties.
export function getGroupPropertySelect(property: string): string {
  const withoutPrefix = property.replace(/^group\./, '');
  if (withoutPrefix === 'name') {
    return 'name';
  }
  if (withoutPrefix === 'type') {
    return 'type';
  }
  if (withoutPrefix === 'id') {
    return 'id';
  }
  if (withoutPrefix.startsWith('properties.')) {
    const propKey = withoutPrefix.replace(/^properties\./, '');
    return `properties[${sqlstring.escape(propKey)}]`;
  }
  return 'id';
}

// Returns the SELECT expression when querying the profiles table directly (no join alias).
// Use for fetching distinct values for profile.* properties.
// Lists the same profiles columns as PROFILE_COLUMNS in filter-where.service.ts,
// which resolves profile.* on the filter side; keep the two in sync.
export function getProfilePropertySelect(property: string): string {
  const withoutPrefix = property.replace(/^profile\./, '');
  if (withoutPrefix === 'id') {
    return 'id';
  }
  if (withoutPrefix === 'first_name') {
    return 'first_name';
  }
  if (withoutPrefix === 'last_name') {
    return 'last_name';
  }
  if (withoutPrefix === 'email') {
    return 'email';
  }
  if (withoutPrefix === 'avatar') {
    return 'avatar';
  }
  if (withoutPrefix === 'created_at') {
    return 'created_at';
  }
  if (withoutPrefix === 'last_seen_at') {
    return 'last_seen_at';
  }
  if (withoutPrefix.startsWith('properties.')) {
    const propKey = withoutPrefix.replace(/^properties\./, '');
    return `properties[${sqlstring.escape(propKey)}]`;
  }
  return 'id';
}

export function getSelectPropertyKey(
  rawProperty: string,
  projectId?: string,
  cohortId?: string,
  cohortName?: string,
  /**
   * When set, the events table's `properties` map is qualified with this
   * alias (e.g. `e.properties[...]`). Required in any query where another
   * joined table also exposes a `properties` column (such as the groups
   * `_g` join), otherwise ClickHouse rejects with "ambiguous identifier".
   */
  eventsAlias?: string,
) {
  // Map camelCase aliases (`referrerName` → `referrer_name`) and bare UTM
  // names (`utm_source` → `properties.__query.utm_source`) into their
  // canonical form before doing any pattern matching. The fallback at the
  // bottom of this function returns `property` verbatim, so without this
  // normalization an alias would leak into the generated SQL and fail with
  // UNKNOWN_IDENTIFIER.
  const property = normalizeEventField(rawProperty);
  const extractedCohortId = cohortId || extractCohortId(property);

  if (extractedCohortId && projectId) {
    const cohortAlias = getCohortAlias(extractedCohortId);
    const inLabel = cohortName
      ? sqlstring.escape(cohortName)
      : "'In Cohort'";
    const notInLabel = cohortName
      ? sqlstring.escape(`Not ${cohortName}`)
      : "'Not In Cohort'";
    return `if(notEmpty(${cohortAlias}.profile_id), ${inLabel}, ${notInLabel})`;
  }

  if (property === 'has_profile') {
    return `if(profile_id != device_id, 'true', 'false')`;
  }

  // Handle group properties — requires ARRAY JOIN + _g JOIN to be present in query
  if (property.startsWith('group.') && projectId) {
    return getGroupPropertySql(property);
  }

  const propertyPatterns = ['properties', 'profile.properties'];

  const match = propertyPatterns.find((pattern) =>
    property.startsWith(`${pattern}.`)
  );
  if (!match) {
    return property;
  }

  // Only the events table's bare `properties` map needs aliasing —
  // `profile.properties` already routes through the profile join alias.
  const aliasPrefix = match === 'properties' && eventsAlias
    ? `${eventsAlias}.`
    : '';

  if (property.includes('*')) {
    return `arrayMap(x -> trim(x), mapValues(mapExtractKeyLike(${aliasPrefix}${match}, ${sqlstring.escape(
      transformPropertyKey(property)
    )})))`;
  }

  return `${aliasPrefix}${match}[${sqlstring.escape(
    property.slice(match.length + 1)
  )}]`;
}


// --- profile-property CTE narrowing (perf) ---------------------------------
// profile.properties.<key> refs render as Map lookups `profile.properties['<key>']`.
// Pulling the whole `properties` Map into the profile CTE makes the LEFT ANY
// JOIN hash carry the full Map per profile — roughly a kilobyte each on real
// data — and OOMs at scale. Instead we project ONLY the referenced keys as
// scalar columns in the CTE and rewrite the refs to those columns — identical
// results at a fraction of the memory. Wildcard refs (mapExtractKeyLike) still
// need the full Map, so those fall back to selecting it.

const PROFILE_PROP_PREFIX = 'profile.properties.';

export function collectProfilePropertyKeys(refs: { name: string }[]): {
  keys: string[];
  needsFullMap: boolean;
} {
  const keys = new Set<string>();
  let needsFullMap = false;
  for (const { name } of refs) {
    if (!name.startsWith(PROFILE_PROP_PREFIX)) {
      continue;
    }
    // Wildcard refs render as mapExtractKeyLike over the whole Map.
    if (name.includes('*')) {
      needsFullMap = true;
      continue;
    }
    const key = name.slice(PROFILE_PROP_PREFIX.length);
    // A backtick or backslash in the key can't be embedded in the
    // backtick-quoted scalar alias. Such keys are never narrowed: the full
    // Map stays selected and their refs keep the original Map access.
    if (/[`\\]/.test(key)) {
      needsFullMap = true;
      continue;
    }
    keys.add(key);
  }
  return { keys: Array.from(keys), needsFullMap };
}

// The profile-CTE SELECT expression for the `properties` field: one scalar
// column per referenced key, plus the full Map only when a wildcard ref needs
// it (or when nothing specific was referenced).
export function profilePropertiesCteSelect(
  keys: string[],
  needsFullMap: boolean,
): string {
  const cols = keys.map(
    (k) => `properties[${sqlstring.escape(k)}] as \`profile.properties.${k}\``,
  );
  if (needsFullMap || cols.length === 0) {
    cols.push('properties as "profile.properties"');
  }
  return cols.join(', ');
}

// Rewrite `profile.properties['<key>']` -> `` `profile.properties.<key>` ``
// for the narrowed keys. Matches the raw render from getSelectPropertyKey /
// the filter builders; never matches the CTE's own `properties['<key>']`,
// which has no `profile.` prefix. No-op when keys is empty.
// The Map-access text a `profile.properties.<key>` ref renders as. Must stay
// identical to what `getSelectPropertyKey` emits for that key: a key whose
// quotes are escaped there but not here would be searched for in a form the
// query never contains, leaving the ref pointing at a Map the CTE dropped.
function profilePropertyRef(key: string): string {
  return `profile.properties[${sqlstring.escape(key)}]`;
}

export function rewriteProfilePropertyRefs(sql: string, keys: string[]): string {
  let out = sql;
  for (const k of keys) {
    out = out
      .split(profilePropertyRef(k))
      .join(`\`profile.properties.${k}\``);
  }
  return out;
}

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
    ${limit ? sql`LIMIT ${limit}` : empty}`;
}

function isNumericColumn(columnName: string): boolean {
  const numericColumns = ['duration', 'revenue', 'longitude', 'latitude'];
  return numericColumns.includes(columnName);
}

export function getEventFiltersWhereClause(
  filters: IChartEventFilter[],
  projectId?: string,
  /**
   * See `getSelectPropertyKey`. When the surrounding query joins another
   * table that has a `properties` column (e.g. the `_g` groups join), the
   * events table must be aliased and passed here so we can emit
   * `e.properties[...]` instead of the ambiguous `properties[...]`.
   */
  eventsAlias?: string,
  /**
   * Which physical table the WHERE clause is being built for. Affects which
   * names count as "top-level columns" and whether bare `utm_*` gets routed
   * into the events-specific `properties.__query.utm_*` map. Defaults to
   * 'events' because that's where the vast majority of callers (chart,
   * funnel, conversion, sankey, event services) target — OverviewService
   * sets it to 'sessions' when querying the sessions table.
   */
  tableScope: 'events' | 'sessions' = 'events',
) {
  const where: Record<string, string> = {};
  filters.forEach((filter, index) => {
    const id = `f${index}`;
    const { value, operator } = filter;
    // Normalize camelCase aliases (`referrerName` → `referrer_name`) on both
    // tables — both events and sessions schemas use snake_case. The bare-
    // utm rewrite only applies to events because sessions stores utm_* as
    // real top-level columns; doing it for sessions would emit
    // `properties['__query.utm_source']` against a table that has no
    // `properties` column.
    const name =
      tableScope === 'sessions'
        ? EVENT_FIELD_ALIASES[filter.name] ?? filter.name
        : normalizeEventField(filter.name);

    if (
      (operator === 'inCohort' || operator === 'notInCohort') &&
      projectId
    ) {
      // Self-contained membership subselect — no caller JOIN wiring needed.
      // Cohort filters and cohort breakdowns are decoupled: the breakdown
      // path (getSelectPropertyKey) still uses a JOIN alias for SELECT
      // expressions, but filters never depend on it.
      const cohortIds = getCohortIds(filter);
      if (cohortIds.length === 0) return;
      const profileIdExpr = eventsAlias
        ? `${eventsAlias}.profile_id`
        : 'profile_id';
      const op = operator === 'notInCohort' ? 'NOT IN' : 'IN';
      const escapedIds = cohortIds
        .map((c) => sqlstring.escape(c))
        .join(', ');
      where[id] = `${profileIdExpr} ${op} (SELECT profile_id FROM ${TABLE_NAMES.cohort_members} FINAL WHERE cohort_id IN (${escapedIds}) AND project_id = ${sqlstring.escape(projectId)})`;
      return;
    }

    if (
      value.length === 0 &&
      operator !== 'isNull' &&
      operator !== 'isNotNull'
    ) {
      return;
    }

    if (name === 'has_profile') {
      if (value.includes('true')) {
        where[id] = 'profile_id != device_id';
      } else {
        where[id] = 'profile_id = device_id';
      }
      return;
    }

    // Handle group. prefixed filters (requires ARRAY JOIN + _g JOIN in query)
    if (name.startsWith('group.') && projectId) {
      const whereFrom = getGroupPropertySql(name);
      if (hasTypedCast(filter.type) && isTypedOperator(operator)) {
        where[id] = buildTypedClause(whereFrom, operator, value, filter.type);
        return;
      }
      switch (operator) {
        case 'is': {
          if (value.length === 1) {
            where[id] =
              `${whereFrom} = ${sqlstring.escape(String(value[0]).trim())}`;
          } else {
            where[id] =
              `${whereFrom} IN (${value.map((val) => sqlstring.escape(String(val).trim())).join(', ')})`;
          }
          break;
        }
        case 'isNot': {
          if (value.length === 1) {
            where[id] =
              `${whereFrom} != ${sqlstring.escape(String(value[0]).trim())}`;
          } else {
            where[id] =
              `${whereFrom} NOT IN (${value.map((val) => sqlstring.escape(String(val).trim())).join(', ')})`;
          }
          break;
        }
        case 'contains': {
          where[id] =
            `(${value.map((val) => `${whereFrom} LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`).join(' OR ')})`;
          break;
        }
        case 'doesNotContain': {
          where[id] =
            `(${value.map((val) => `${whereFrom} NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`).join(' OR ')})`;
          break;
        }
        case 'startsWith': {
          where[id] =
            `(${value.map((val) => `${whereFrom} LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`).join(' OR ')})`;
          break;
        }
        case 'endsWith': {
          where[id] =
            `(${value.map((val) => `${whereFrom} LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`).join(' OR ')})`;
          break;
        }
        case 'isNull': {
          where[id] = `(${whereFrom} = '' OR ${whereFrom} IS NULL)`;
          break;
        }
        case 'isNotNull': {
          where[id] = `(${whereFrom} != '' AND ${whereFrom} IS NOT NULL)`;
          break;
        }
        case 'regex': {
          where[id] =
            `(${value.map((val) => `match(${whereFrom}, ${sqlstring.escape(String(val).trim())})`).join(' OR ')})`;
          break;
        }
      }
      return;
    }

    if (
      name.startsWith('properties.') ||
      name.startsWith('profile.properties.')
    ) {
      const propertyKey = getSelectPropertyKey(
        name,
        undefined,
        undefined,
        undefined,
        eventsAlias,
      );
      const isWildcard = propertyKey.includes('%');
      const whereFrom = propertyKey;

      // Typed cast (number/date/datetime/boolean) short-circuit. Casts both the
      // column and each value so e.g. `>= '2019-01-01'` compares as dates
      // instead of crashing `toFloat64('2019-01-01')`. Untyped/string filters
      // fall through to the legacy switch below.
      if (hasTypedCast(filter.type) && isTypedOperator(operator)) {
        where[id] = isWildcard
          ? `arrayExists(x -> ${buildTypedClause('x', operator, value, filter.type)}, ${whereFrom})`
          : buildTypedClause(whereFrom, operator, value, filter.type);
        return;
      }

      switch (operator) {
        case 'is': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map((val) => `x = ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')}, ${whereFrom})`;
          } else if (value.length === 1) {
            where[id] =
              `${whereFrom} = ${sqlstring.escape(String(value[0]).trim())}`;
          } else {
            where[id] = `${whereFrom} IN (${value
              .map((val) => sqlstring.escape(String(val).trim()))
              .join(', ')})`;
          }
          break;
        }
        case 'isNot': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map((val) => `x != ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')}, ${whereFrom})`;
          } else if (value.length === 1) {
            where[id] =
              `${whereFrom} != ${sqlstring.escape(String(value[0]).trim())}`;
          } else {
            where[id] = `${whereFrom} NOT IN (${value
              .map((val) => sqlstring.escape(String(val).trim()))
              .join(', ')})`;
          }
          break;
        }
        case 'contains': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) => `x LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'doesNotContain': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `x NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'startsWith': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) => `x LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'endsWith': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) => `x LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'regex': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map((val) => `match(x, ${sqlstring.escape(String(val).trim())})`)
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `match(${whereFrom}, ${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'isNull': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> x = '' OR x IS NULL, ${whereFrom})`;
          } else {
            where[id] = `(${whereFrom} = '' OR ${whereFrom} IS NULL)`;
          }
          break;
        }
        case 'isNotNull': {
          if (isWildcard) {
            where[id] =
              `arrayExists(x -> x != '' AND x IS NOT NULL, ${whereFrom})`;
          } else {
            where[id] = `(${whereFrom} != '' AND ${whereFrom} IS NOT NULL)`;
          }
          break;
        }
        case 'gt': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) > toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) > toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'lt': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) < toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) < toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'gte': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) >= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) >= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'lte': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) <= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) <= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          }
          break;
        }
      }
    } else {
      // Bare-column branch. For events queries: enforce that `name` is one
      // of the known top-level columns (anything else would crash parse with
      // UNKNOWN_IDENTIFIER). For sessions queries: skip the guard because
      // the sessions table has its own column set (utm_*, entry_path, etc.)
      // that OverviewService.getRawWhereClause already vets via its
      // WHITELISTED_FILTERS pre-pass.
      if (tableScope === 'events' && !EVENT_TOP_LEVEL_COLUMNS.has(name)) {
        return;
      }
      // Typed cast short-circuit (see property branch above). Supersedes the
      // `isNumericColumn` auto-detect when the user declared an explicit type.
      if (hasTypedCast(filter.type) && isTypedOperator(operator)) {
        where[id] = buildTypedClause(name, operator, value, filter.type);
        return;
      }
      switch (operator) {
        case 'is': {
          if (value.length === 1) {
            where[id] =
              `${name} = ${sqlstring.escape(String(value[0]).trim())}`;
          } else {
            where[id] = `${name} IN (${value
              .map((val) => sqlstring.escape(String(val).trim()))
              .join(', ')})`;
          }
          break;
        }
        case 'isNull': {
          where[id] = `(${name} = '' OR ${name} IS NULL)`;
          break;
        }
        case 'isNotNull': {
          where[id] = `(${name} != '' AND ${name} IS NOT NULL)`;
          break;
        }
        case 'isNot': {
          if (value.length === 1) {
            where[id] =
              `${name} != ${sqlstring.escape(String(value[0]).trim())}`;
          } else {
            where[id] = `${name} NOT IN (${value
              .map((val) => sqlstring.escape(String(val).trim()))
              .join(', ')})`;
          }
          break;
        }
        case 'contains': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
            )
            .join(' OR ')})`;
          break;
        }
        case 'doesNotContain': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
            )
            .join(' OR ')})`;
          break;
        }
        case 'startsWith': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`
            )
            .join(' OR ')})`;
          break;
        }
        case 'endsWith': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`
            )
            .join(' OR ')})`;
          break;
        }
        case 'regex': {
          where[id] = `(${value
            .map(
              (val) =>
                `match(${name}, ${sqlstring.escape(stripLeadingAndTrailingSlashes(String(val)).trim())})`
            )
            .join(' OR ')})`;
          break;
        }
        case 'gt': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) > toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map((val) => `${name} > ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')})`;
          }
          break;
        }
        case 'lt': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) < toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map((val) => `${name} < ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')})`;
          }
          break;
        }
        case 'gte': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) >= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map(
                (val) => `${name} >= ${sqlstring.escape(String(val).trim())}`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'lte': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) <= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map(
                (val) => `${name} <= ${sqlstring.escape(String(val).trim())}`
              )
              .join(' OR ')})`;
          }
          break;
        }
      }
    }
  });

  return where;
}
