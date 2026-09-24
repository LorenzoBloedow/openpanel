/**
 * Report filters and property expressions on Postgres: the successor of the
 * ClickHouse string builders in services/chart.service.ts (helper section)
 * and services/filter-where.service.ts. Everything returns `Sql` fragments;
 * filter values, property keys, cohort ids and project ids are always bind
 * parameters, and the only identifiers spliced in are allowlisted columns
 * and validated aliases.
 *
 * Two filter dialects, as before:
 *
 * - {@link eventFilterClauses} (was `getEventFiltersWhereClause`): report
 *   filters on the events table — columns, `properties.*` (wildcards
 *   included), `profile.properties.*`, `group.*`, `has_profile`, cohorts.
 * - {@link prefixedFilterClauses} (was `buildFilterWhere`): list filters on
 *   the events, sessions or profiles table — only `cohort` / `group.*` /
 *   `profile.*` / `session.*` names, through subqueries; everything else is
 *   dropped, as before.
 *
 * Both return one `Sql` per surviving filter (AND them with `and()`), with
 * the ClickHouse semantics kept operator by operator, quirks included
 * (`doesNotContain` with several values is an OR on events, untyped numeric
 * property comparisons read non-numbers as 0, regex strips slashes on
 * columns only, …) — checked case by case against ClickHouse 26.1, see
 * test/fixtures/filter-cases.ts. Differences: a value or operator
 * ClickHouse could not convert (`toFloat64('abc')`, LIKE on a number or a
 * date column, `duration = ''`) no longer fails the query — it matches
 * nothing, or compares the column's text.
 *
 * Time zones: `timezone` in the scope is ClickHouse's `session_timezone`,
 * and it only applies where it applied there — date text parsed by typed
 * `date`/`datetime` filters (parseDateTimeBestEffort). Timestamp columns
 * behave like ClickHouse's DateTime64 table columns, which kept the server
 * zone (UTC) whatever the session zone: a literal compared with the column
 * (`created_at > '2024-05-01'`), the column's text and its date
 * (`toDate(created_at)`) are UTC, and a typed filter reads the column's UTC
 * wall-clock time in the project zone.
 *
 * The filtered row is addressed through a scope: the row's table alias
 * (`alias: 'e'` → `e.country`) and, optionally, rows joined to it:
 *
 * - `profileAlias`: a profiles row joined with {@link profileJoin} (a LEFT
 *   JOIN on the primary key, what ClickHouse's `LEFT ANY JOIN … AS profile`
 *   was). Without it `profile.*` names read the profile through a correlated
 *   lookup, with the same defaults ('' for a missing profile).
 * - `groupJoin`: one row per group id, from {@link groupJoin} (`ARRAY JOIN
 *   groups` + the `_g` join). Needed for group breakdowns; without it
 *   `group.*` filters are `EXISTS` over the row's groups (same matches, but
 *   a row in two matching groups is no longer counted twice). Either way a
 *   `group.*` filter keeps only rows that have groups, even one ClickHouse
 *   dropped (untyped gt/lt, no values): its ARRAY JOIN did that.
 *
 * Porting a ClickHouse query:
 *
 *   getEventFiltersWhereClause(f, pid, 'e')   → and(eventFilterClauses(f, { projectId, timezone, alias: 'e' }))
 *   buildFilterWhere(f, pid, ctx)             → prefixedFilterClauses(f, { projectId, timezone, table, alias })
 *   getSelectPropertyKey(p, pid, cId, cName, 'e') → eventPropertyExpr(p, scope, { id: cId, name: cName })
 *   getGroupPropertySql(p)                    → groupPropertyExpr(p, groupJoin aliases)
 *   getGroupPropertySelect / getProfilePropertySelect → groupColumnExpr / profileColumnExpr
 *   `LEFT ANY JOIN (… profiles …) AS profile` → profileJoin(scope)
 *   `ARRAY JOIN groups AS _group_id` + `_g`   → groupJoin(scope)
 *   buildCohortMembershipQuery / buildInlineCohortJoin / getCohortAlias → cohortMembershipQuery / cohortJoin / cohortAlias
 *   buildAllCohortsMembershipQuery / buildAllCohortsLabelExpr → allCohortsMembershipQuery / allCohortsLabelExpr
 *   transformPropertyKey (wildcards)          → wildcardKeyPattern (./fields.ts)
 *   profilePropertiesCteSelect / rewriteProfilePropertyRefs → narrowedProfileSelect + narrowProfileScope
 *   normalizeEventField, isKnownEventField, extractCohortId, isAllCohortsBreakdown,
 *   collectBreakdownCohortIds, collectProfilePropertyKeys, isProfileColumn,
 *   profileJoinColumns, PROFILE_TABLE_COLUMNS → ./fields.ts (same names)
 *   fetchCohortsMetadata, fetchProjectCohorts → ./cohorts.ts (same names)
 */
import { stripLeadingAndTrailingSlashes } from '@openpanel/common';
import {
  getCohortIds,
  type IChartEventFilter,
  type IChartEventFilterOperator,
  type IChartFilterValueType,
} from '@openpanel/validation';

import type { CohortMetadata } from './cohorts';
import {
  type ColumnKind,
  EVENT_FIELD_ALIASES,
  EVENT_TABLE_COLUMNS,
  NUMERIC_FILTER_COLUMNS,
  SESSION_TABLE_COLUMNS,
  extractCohortId,
  isWildcardProperty,
  normalizeEventField,
  resolveGroupField,
  resolveProfileField,
  wildcardKeyPattern,
} from './fields';
import { type Sql, and, empty, join, or, raw, sql } from './sql';
import { type TimeCtx, parseTimestamp, toLocal, toLocalDate } from './time';

type Filter = IChartEventFilter;
type FilterValue = Filter['value'][number];
type Operator = IChartEventFilterOperator;

// --- scopes ---------------------------------------------------------------------------

export interface GroupJoinAliases {
  /** Alias of the joined analytics.groups row (ClickHouse `_g`). */
  alias: string;
  /** Alias of the unnested group id (ClickHouse `_group_id`). */
  idAlias: string;
}

export interface EventFilterScope extends TimeCtx {
  projectId: string;
  /** Alias of the filtered table (`e` → `e.country`); omit for bare names. */
  alias?: string;
  /** Which table bare column names belong to (default `events`). */
  table?: 'events' | 'sessions';
  /** Alias of a profiles row joined with {@link profileJoin}. */
  profileAlias?: string;
  /**
   * `profile.properties.<key>` → a column of the joined profile, for joins
   * that select only the referenced keys (see {@link narrowProfileScope}).
   */
  profileColumns?: ReadonlyMap<string, string>;
  /** Aliases of a {@link groupJoin}; group.* then reads the joined row. */
  groupJoin?: GroupJoinAliases;
}

export interface PrefixedFilterScope extends TimeCtx {
  projectId: string;
  /** The table the filtered row comes from (ClickHouse `selfTable`). */
  table: 'events' | 'sessions' | 'profiles';
  /** Alias of the filtered table; omit for bare names. */
  alias?: string;
  /** Date scope of `session.performed_event` subqueries. */
  startDate?: Date;
  endDate?: Date;
}

/** Default aliases of {@link groupJoin}, as the ClickHouse queries named them. */
export const GROUP_JOIN: GroupJoinAliases = { alias: '_g', idAlias: '_group_id' };

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkAlias(alias: string): string {
  if (!ALIAS.test(alias)) {
    throw new Error(`Invalid SQL alias: ${JSON.stringify(alias)}`);
  }
  return alias;
}

/**
 * `alias.column`. Columns come from the allowlists in ./fields.ts, aliases
 * are checked, so both are safe to splice.
 */
function qualify(alias: string | undefined, column: string): Sql {
  checkAlias(column);
  return raw(alias ? `${checkAlias(alias)}.${column}` : column);
}

// --- values ------------------------------------------------------------------------------

/** `String(v).trim()`: how the event builder read every value. */
const valueText = (value: FilterValue) => String(value).trim();

/**
 * sqlstring.escape of a trimmed value, as the prefixed builder bound it:
 * strings trimmed, numbers and booleans as their text, null stays NULL.
 */
const scalarText = (value: FilterValue): string | null =>
  value === null ? null : typeof value === 'string' ? value.trim() : String(value);

/** A bound text value. */
const bindText = (value: string | null) => sql`${value}::text`;

/** The same, as a LIKE pattern built from the trimmed value text. */
const likePattern = (prefix: string, value: string, suffix: string) =>
  sql`${`${prefix}${value}${suffix}`}::text`;

// --- targets ----------------------------------------------------------------------------------

/** An expression a filter compares, with how its values compare. */
interface Target {
  sql: Sql;
  kind: ColumnKind;
}

const textTarget = (expression: Sql): Target => ({ sql: expression, kind: 'text' });

/** `COALESCE(source->>key, '')`: a flattened property, '' when missing. */
function jsonText(source: Sql, key: string): Sql {
  return sql`COALESCE(${source} ->> ${key}::text, '')`;
}

/**
 * ClickHouse's DateTime64 table columns carry the server zone (UTC), and
 * `session_timezone` did not change that: `toString(col)`, `toDate(col)` and
 * a string literal compared with the column (`created_at > '2024-05-01'`)
 * all read UTC. Only functions — `toDateTime('…')`,
 * `parseDateTimeBestEffort*`, `toStartOf*` — used the session zone.
 */
const COLUMN_ZONE: TimeCtx = { timezone: 'UTC' };

/**
 * A target as text, for LIKE / regex / emptiness checks. Timestamps render
 * like ClickHouse's `toString` of a DateTime64(3) column (UTC).
 */
function asText(target: Target): Sql {
  switch (target.kind) {
    case 'text':
      return target.sql;
    case 'timestamp':
      return sql`to_char(${toLocal(target.sql, COLUMN_ZONE)}, 'YYYY-MM-DD HH24:MI:SS.MS')`;
    default:
      return sql`(${target.sql})::text`;
  }
}

/** ClickHouse `toFloat64(x)` of a column (timestamps as epoch seconds). */
function toFloat(target: Target): Sql {
  switch (target.kind) {
    case 'number':
      return sql`(${target.sql})::double precision`;
    case 'timestamp':
      return sql`extract(epoch from ${target.sql})::double precision`;
    default:
      return sql`analytics.to_float_or_null((${target.sql})::text)`;
  }
}

/** ClickHouse `toFloat64(<value>)`; a non-number is NULL (matches nothing). */
const floatValue = (value: string | null) =>
  sql`analytics.to_float_or_null(${value}::text)`;

/**
 * A value compared with a column in the column's own type, the way
 * ClickHouse converted a string literal next to a typed column (a date
 * literal in the column's zone, UTC — see COLUMN_ZONE).
 */
function columnValue(value: string | null, target: Target): Sql {
  switch (target.kind) {
    case 'timestamp':
      return parseTimestamp(bindText(value), COLUMN_ZONE);
    case 'text':
    case 'uuid':
      return bindText(value);
    default:
      // number / boolean: the parameter takes the column's type.
      return sql`${value}`;
  }
}

/** The target in the form its values are compared with (uuid as text). */
function comparable(target: Target): Sql {
  return target.kind === 'uuid' ? sql`(${target.sql})::text` : target.sql;
}

/** `COLLATE "C"`: ClickHouse compared strings bytewise. */
function ordered(target: Target): Sql {
  return target.kind === 'text' ? sql`(${target.sql} COLLATE "C")` : comparable(target);
}

// --- typed casts (filter-cast.ts) -----------------------------------------------------------

type TypedCast = Exclude<IChartFilterValueType, 'string'>;

const TYPED_OPERATORS: Partial<Record<Operator, string>> = {
  is: '=',
  isNot: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/** A declared non-string type: both sides are cast before comparing. */
export function hasTypedCast(type?: IChartFilterValueType): type is TypedCast {
  return !!type && type !== 'string';
}

export function isTypedOperator(operator: Operator): boolean {
  return operator in TYPED_OPERATORS;
}

/**
 * `castSql` of filter-cast.ts: `toFloat64OrNull(toString(x))`,
 * `parseDateTimeBestEffortOrNull(toString(x))` (and its `toDate`), or the
 * true/1/yes test for booleans. Date text is read in the project zone
 * (`session_timezone`); a timestamp column goes through its UTC text first,
 * so its UTC wall-clock time is what's read in the project zone — and its
 * date is the UTC date — exactly as ClickHouse did.
 */
function castTo(target: Target, type: TypedCast, ctx: TimeCtx): Sql {
  const isTimestamp = target.kind === 'timestamp';
  switch (type) {
    case 'number':
      return sql`analytics.to_float_or_null(${asText(target)})`;
    case 'datetime':
      return isTimestamp
        ? sql`(${toLocal(target.sql, COLUMN_ZONE)} AT TIME ZONE ${ctx.timezone}::text)`
        : parseTimestamp(asText(target), ctx);
    case 'date':
      return isTimestamp
        ? toLocalDate(target.sql, COLUMN_ZONE)
        : toLocalDate(parseTimestamp(asText(target), ctx), ctx);
    case 'boolean':
      return sql`(CASE WHEN lower(btrim(${asText(target)})) IN ('true', '1', 'yes') THEN 1 ELSE 0 END)`;
  }
}

/**
 * `buildTypedClause`: both sides cast to `type`; `isNot` must differ from
 * every value (AND), the others match any value (OR).
 */
function typedClause(
  target: Target,
  operator: Operator,
  values: readonly FilterValue[],
  type: TypedCast,
  ctx: TimeCtx,
): Sql {
  const comparator = raw(TYPED_OPERATORS[operator] ?? '=');
  const left = castTo(target, type, ctx);
  const parts = values.map(
    (value) =>
      sql`${left} ${comparator} ${castTo(textTarget(bindText(scalarText(value))), type, ctx)}`,
  );
  return sql`(${operator === 'isNot' ? and(parts) : or(parts)})`;
}

/** Every value's predicate, ORed (a ClickHouse `(a OR b)` list). */
function anyOfValues(
  values: readonly FilterValue[],
  predicate: (value: FilterValue) => Sql,
): Sql {
  return sql`(${or(values.map(predicate))})`;
}

function allOfValues(
  values: readonly FilterValue[],
  predicate: (value: FilterValue) => Sql,
): Sql {
  return sql`(${and(values.map(predicate))})`;
}

const isNullOperator = (operator: Operator) =>
  operator === 'isNull' || operator === 'isNotNull';

// --- event filters (getEventFiltersWhereClause) ------------------------------------------

/**
 * One WHERE fragment per report filter that applies to the events table
 * (or the sessions table with `table: 'sessions'`); filters ClickHouse
 * ignored are dropped. AND the result.
 */
export function eventFilterClauses(
  filters: readonly Filter[],
  scope: EventFilterScope,
): Sql[] {
  const clauses: Sql[] = [];
  for (const filter of filters) {
    const clause = eventFilterClause(filter, scope);
    if (clause) {
      clauses.push(clause);
    }
  }
  return clauses;
}

/** {@link eventFilterClauses} ANDed (`TRUE` when nothing applies). */
export function eventFiltersWhere(
  filters: readonly Filter[],
  scope: EventFilterScope,
): Sql {
  return and(eventFilterClauses(filters, scope));
}

function eventFilterClause(filter: Filter, scope: EventFilterScope): Sql | null {
  const clause = eventFilterCondition(filter, scope);
  if (scope.groupJoin || !filter.name.startsWith('group.')) {
    return clause;
  }
  // The ClickHouse queries ARRAY JOINed the groups for any group.* filter,
  // which drops rows without groups even when the filter itself was dropped
  // (untyped gt/gte/lt/lte, no values). With a group join the join does it.
  const hasGroups = sql`cardinality(${qualify(scope.alias, 'groups')}) > 0`;
  return clause ? and([hasGroups, clause]) : hasGroups;
}

function eventFilterCondition(filter: Filter, scope: EventFilterScope): Sql | null {
  const { value, operator } = filter;
  const table = scope.table ?? 'events';
  // Both tables name columns in snake_case; only events keep the UTM values
  // in the properties.
  const name =
    table === 'sessions'
      ? (Object.hasOwn(EVENT_FIELD_ALIASES, filter.name)
          ? EVENT_FIELD_ALIASES[filter.name]!
          : filter.name)
      : normalizeEventField(filter.name);

  if (operator === 'inCohort' || operator === 'notInCohort') {
    const cohortIds = getCohortIds(filter);
    if (cohortIds.length === 0) {
      return null;
    }
    return cohortMembership(
      qualify(scope.alias, 'profile_id'),
      cohortIds,
      operator === 'notInCohort',
      scope.projectId,
    );
  }

  if (value.length === 0 && !isNullOperator(operator)) {
    return null;
  }

  if (name === 'has_profile') {
    const profileId = qualify(scope.alias, 'profile_id');
    const deviceId = qualify(scope.alias, 'device_id');
    return value.includes('true')
      ? sql`${profileId} <> ${deviceId}`
      : sql`${profileId} = ${deviceId}`;
  }

  if (name.startsWith('group.')) {
    return groupEventFilter(name, filter, scope);
  }

  if (name.startsWith('properties.') || name.startsWith('profile.properties.')) {
    return propertyEventFilter(name, filter, scope);
  }

  const columns = table === 'sessions' ? SESSION_TABLE_COLUMNS : EVENT_TABLE_COLUMNS;
  const kind = Object.hasOwn(columns, name) ? columns[name] : undefined;
  if (!kind) {
    // Not a column of the table (e.g. `profile.email` on events): dropped,
    // as ClickHouse's column allowlist did.
    return null;
  }
  return columnEventFilter(name, { sql: qualify(scope.alias, name), kind }, filter, scope);
}

function columnEventFilter(
  name: string,
  target: Target,
  filter: Filter,
  ctx: TimeCtx,
): Sql | null {
  const { value, operator, type } = filter;
  if (hasTypedCast(type) && isTypedOperator(operator)) {
    return typedClause(target, operator, value, type, ctx);
  }
  const text = asText(target);
  const compared = comparable(target);
  const numeric = NUMERIC_FILTER_COLUMNS.has(name);
  const literal = (item: FilterValue) => columnValue(valueText(item), target);
  const compare = (comparator: string) =>
    numeric
      ? anyOfValues(
          value,
          (item) => sql`${toFloat(target)} ${raw(comparator)} ${floatValue(valueText(item))}`,
        )
      : anyOfValues(
          value,
          (item) => sql`${ordered(target)} ${raw(comparator)} ${literal(item)}`,
        );

  switch (operator) {
    case 'is':
      return value.length === 1
        ? sql`${compared} = ${literal(value[0]!)}`
        : sql`${compared} IN (${join(value.map(literal))})`;
    case 'isNot':
      return value.length === 1
        ? sql`${compared} <> ${literal(value[0]!)}`
        : sql`${compared} NOT IN (${join(value.map(literal))})`;
    case 'isNull':
      return sql`(${text} = '' OR ${target.sql} IS NULL)`;
    case 'isNotNull':
      return sql`(${text} <> '' AND ${target.sql} IS NOT NULL)`;
    case 'contains':
      return anyOfValues(value, (item) => sql`${text} LIKE ${likePattern('%', valueText(item), '%')}`);
    case 'doesNotContain':
      return anyOfValues(value, (item) => sql`${text} NOT LIKE ${likePattern('%', valueText(item), '%')}`);
    case 'startsWith':
      return anyOfValues(value, (item) => sql`${text} LIKE ${likePattern('', valueText(item), '%')}`);
    case 'endsWith':
      return anyOfValues(value, (item) => sql`${text} LIKE ${likePattern('%', valueText(item), '')}`);
    case 'regex':
      // Columns strip /…/ around the pattern; properties don't.
      return anyOfValues(
        value,
        (item) => sql`${text} ~ ${bindText(stripLeadingAndTrailingSlashes(String(item)).trim())}`,
      );
    case 'gt':
      return compare('>');
    case 'lt':
      return compare('<');
    case 'gte':
      return compare('>=');
    case 'lte':
      return compare('<=');
    default:
      return null;
  }
}

/** A property's text at `x` for the scalar or wildcard form. */
type ValuePredicate = (value: Sql) => Sql;

function propertyEventFilter(name: string, filter: Filter, scope: EventFilterScope): Sql | null {
  const { value, operator, type } = filter;
  const property = propertyRef(name, scope);

  // Wildcard names test every matching key: arrayExists(x -> …, values).
  const test = (predicate: ValuePredicate): Sql =>
    property.wildcard
      ? sql`EXISTS (SELECT 1 FROM (SELECT btrim(_kv.value) AS x FROM jsonb_each_text(${property.source}) AS _kv(key, value) WHERE _kv.key LIKE ${property.wildcard}::text) AS _w WHERE ${predicate(raw('_w.x'))})`
      : predicate(property.value);

  if (hasTypedCast(type) && isTypedOperator(operator)) {
    return test((x) => typedClause(textTarget(x), operator, value, type, scope));
  }

  const eachValue = (predicate: (x: Sql, item: string) => Sql): Sql =>
    test((x) => anyOfValues(value, (item) => predicate(x, valueText(item))));

  switch (operator) {
    case 'is':
      if (property.wildcard) {
        return eachValue((x, item) => sql`${x} = ${bindText(item)}`);
      }
      return value.length === 1
        ? sql`${property.value} = ${bindText(valueText(value[0]!))}`
        : sql`${property.value} = ANY(${value.map(valueText)}::text[])`;
    case 'isNot':
      if (property.wildcard) {
        return eachValue((x, item) => sql`${x} <> ${bindText(item)}`);
      }
      return value.length === 1
        ? sql`${property.value} <> ${bindText(valueText(value[0]!))}`
        : sql`${property.value} <> ALL(${value.map(valueText)}::text[])`;
    case 'contains':
      return eachValue((x, item) => sql`${x} LIKE ${likePattern('%', item, '%')}`);
    case 'doesNotContain':
      // An OR across values, as before: with two values it rarely excludes.
      return eachValue((x, item) => sql`${x} NOT LIKE ${likePattern('%', item, '%')}`);
    case 'startsWith':
      return eachValue((x, item) => sql`${x} LIKE ${likePattern('', item, '%')}`);
    case 'endsWith':
      return eachValue((x, item) => sql`${x} LIKE ${likePattern('%', item, '')}`);
    case 'regex':
      return eachValue((x, item) => sql`${x} ~ ${bindText(item)}`);
    case 'isNull':
      return test((x) => sql`(${x} = '' OR ${x} IS NULL)`);
    case 'isNotNull':
      return test((x) => sql`(${x} <> '' AND ${x} IS NOT NULL)`);
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      // toFloat64OrZero: a non-number property compares as 0.
      const comparator = raw(TYPED_OPERATORS[operator]!);
      return eachValue(
        (x, item) =>
          sql`COALESCE(analytics.to_float_or_null(${x}), 0) ${comparator} ${floatValue(item)}`,
      );
    }
    default:
      return null;
  }
}

function groupEventFilter(name: string, filter: Filter, scope: EventFilterScope): Sql | null {
  const { value, operator, type } = filter;
  const condition = (aliases: GroupJoinAliases): Sql | null => {
    const target = textTarget(groupPropertyExpr(name, aliases));
    if (hasTypedCast(type) && isTypedOperator(operator)) {
      return typedClause(target, operator, value, type, scope);
    }
    const x = target.sql;
    const each = (predicate: (item: string) => Sql) =>
      anyOfValues(value, (item) => predicate(valueText(item)));
    switch (operator) {
      case 'is':
        return value.length === 1
          ? sql`${x} = ${bindText(valueText(value[0]!))}`
          : sql`${x} = ANY(${value.map(valueText)}::text[])`;
      case 'isNot':
        return value.length === 1
          ? sql`${x} <> ${bindText(valueText(value[0]!))}`
          : sql`${x} <> ALL(${value.map(valueText)}::text[])`;
      case 'contains':
        return each((item) => sql`${x} LIKE ${likePattern('%', item, '%')}`);
      case 'doesNotContain':
        return each((item) => sql`${x} NOT LIKE ${likePattern('%', item, '%')}`);
      case 'startsWith':
        return each((item) => sql`${x} LIKE ${likePattern('', item, '%')}`);
      case 'endsWith':
        return each((item) => sql`${x} LIKE ${likePattern('%', item, '')}`);
      case 'isNull':
        return sql`(${x} = '' OR ${x} IS NULL)`;
      case 'isNotNull':
        return sql`(${x} <> '' AND ${x} IS NOT NULL)`;
      case 'regex':
        return each((item) => sql`${x} ~ ${bindText(item)}`);
      default:
        // Untyped gt/gte/lt/lte had no group form: the filter is dropped.
        return null;
    }
  };

  if (scope.groupJoin) {
    return condition(scope.groupJoin);
  }
  const inner = condition(EXISTS_GROUP);
  if (!inner) {
    return null;
  }
  return sql`EXISTS (SELECT 1 FROM unnest(${qualify(scope.alias, 'groups')}) AS ${raw(EXISTS_GROUP.idAlias)} LEFT JOIN analytics.groups AS ${raw(EXISTS_GROUP.alias)} ON ${raw(EXISTS_GROUP.alias)}.project_id = ${scope.projectId} AND ${raw(EXISTS_GROUP.alias)}.id = ${raw(EXISTS_GROUP.idAlias)} WHERE ${inner})`;
}

/** Aliases inside the self-contained group EXISTS. */
const EXISTS_GROUP: GroupJoinAliases = { alias: '_fg', idAlias: '_fgid' };

// --- property references -------------------------------------------------------------------------

interface PropertyRef {
  /** The flattened map (jsonb) the key is read from. */
  source: Sql;
  /** `COALESCE(source->>key, '')` for a single key. */
  value: Sql;
  /** The LIKE pattern of a wildcard name. */
  wildcard?: string;
}

/** The profile's properties map, joined or looked up. */
function profileProperties(scope: EventFilterScope): Sql {
  if (scope.profileAlias) {
    return qualify(scope.profileAlias, 'properties');
  }
  return sql`(SELECT _fp.properties FROM analytics.profiles AS _fp WHERE _fp.project_id = ${scope.projectId} AND _fp.id = ${qualify(scope.alias, 'profile_id')})`;
}

function propertyRef(name: string, scope: EventFilterScope): PropertyRef {
  const isProfile = name.startsWith('profile.properties.');
  const source = isProfile ? profileProperties(scope) : qualify(scope.alias, 'properties');
  if (isWildcardProperty(name)) {
    return { source, value: empty, wildcard: wildcardKeyPattern(name) };
  }
  const key = isProfile
    ? name.slice('profile.properties.'.length)
    : name.slice('properties.'.length);
  const narrowed = isProfile ? scope.profileColumns?.get(key) : undefined;
  if (narrowed && scope.profileAlias) {
    return { source, value: sql`COALESCE(${qualify(scope.profileAlias, narrowed)}, '')` };
  }
  return { source, value: jsonText(source, key) };
}

// --- expressions (getSelectPropertyKey & co) ---------------------------------------------------------

/**
 * The value of a filter/breakdown/metric name for each row — ClickHouse's
 * `getSelectPropertyKey`. A wildcard property is a `text[]` of the matching
 * values. `group.*` needs `scope.groupJoin`. A cohort (`cohort:<id>`, or
 * `cohort.id`) is a label: the cohort name / `Not <name>`, or `In Cohort` /
 * `Not In Cohort` without one.
 */
export function eventPropertyExpr(
  property: string,
  scope: EventFilterScope,
  cohort?: { id?: string; name?: string },
): Sql {
  const name = normalizeEventField(property);
  const cohortId = cohort?.id || extractCohortId(name);
  if (cohortId) {
    const member = cohortMembership(
      qualify(scope.alias, 'profile_id'),
      [cohortId],
      false,
      scope.projectId,
    );
    const inLabel = cohort?.name ?? 'In Cohort';
    const outLabel = cohort?.name ? `Not ${cohort.name}` : 'Not In Cohort';
    return sql`(CASE WHEN ${member} THEN ${inLabel}::text ELSE ${outLabel}::text END)`;
  }

  if (name === 'has_profile') {
    return sql`(CASE WHEN ${qualify(scope.alias, 'profile_id')} <> ${qualify(scope.alias, 'device_id')} THEN 'true' ELSE 'false' END)`;
  }

  if (name.startsWith('group.')) {
    if (!scope.groupJoin) {
      throw new Error(`${name} needs a group join (see groupJoin)`);
    }
    return groupPropertyExpr(name, scope.groupJoin);
  }

  if (name.startsWith('properties.') || name.startsWith('profile.properties.')) {
    const ref = propertyRef(name, scope);
    if (ref.wildcard) {
      return sql`ARRAY(SELECT btrim(_kv.value) FROM jsonb_each_text(${ref.source}) AS _kv(key, value) WHERE _kv.key LIKE ${ref.wildcard}::text)`;
    }
    return ref.value;
  }

  if (name.startsWith('profile.')) {
    const field = resolveProfileField(name);
    if (!field || 'propertyKey' in field) {
      throw new Error(`Unknown profile field: ${JSON.stringify(name)}`);
    }
    return profileFieldExpr(field.column, field.kind, scope);
  }

  const columns = scope.table === 'sessions' ? SESSION_TABLE_COLUMNS : EVENT_TABLE_COLUMNS;
  if (!Object.hasOwn(columns, name)) {
    throw new Error(`Unknown event field: ${JSON.stringify(name)}`);
  }
  return qualify(scope.alias, name);
}

/** A profiles column of the row's profile ('' when there is none). */
function profileFieldExpr(column: string, kind: ColumnKind, scope: EventFilterScope): Sql {
  const value = scope.profileAlias
    ? qualify(scope.profileAlias, column)
    : sql`(SELECT ${qualify('_fp', column)} FROM analytics.profiles AS _fp WHERE _fp.project_id = ${scope.projectId} AND _fp.id = ${qualify(scope.alias, 'profile_id')})`;
  return kind === 'text' ? sql`COALESCE(${value}, '')` : value;
}

/**
 * A `group.*` name on a {@link groupJoin} row (`getGroupPropertySql`):
 * name / type / properties.<key> of the joined group ('' when the id has no
 * group row), the group id for anything else.
 */
export function groupPropertyExpr(
  property: string,
  aliases: GroupJoinAliases = GROUP_JOIN,
): Sql {
  const field = resolveGroupField(property);
  if ('propertyKey' in field) {
    return jsonText(qualify(aliases.alias, 'properties'), field.propertyKey);
  }
  if (field.column === 'name' || field.column === 'type') {
    return sql`COALESCE(${qualify(aliases.alias, field.column)}, '')`;
  }
  return raw(checkAlias(aliases.idAlias));
}

/**
 * A `group.*` name read from analytics.groups itself (distinct values,
 * `getGroupPropertySelect`).
 */
export function groupColumnExpr(property: string, alias?: string): Sql {
  const field = resolveGroupField(property);
  if ('propertyKey' in field) {
    return jsonText(qualify(alias, 'properties'), field.propertyKey);
  }
  return qualify(alias, field.column);
}

/**
 * A `profile.*` name read from analytics.profiles itself
 * (`getProfilePropertySelect`); unknown fields read the id.
 */
export function profileColumnExpr(property: string, alias?: string): Sql {
  const field = resolveProfileField(property);
  if (!field) {
    return qualify(alias, 'id');
  }
  if ('propertyKey' in field) {
    return jsonText(qualify(alias, 'properties'), field.propertyKey);
  }
  return qualify(alias, field.column);
}

// --- joins -----------------------------------------------------------------------------------------------

/**
 * `LEFT JOIN analytics.profiles AS profile ON …` — one profile per row (the
 * primary key), NULL columns when the row's profile doesn't exist. Pass the
 * same alias as `profileAlias` in the scope.
 */
export function profileJoin(
  scope: Pick<EventFilterScope, 'projectId' | 'alias'>,
  alias = 'profile',
): Sql {
  const joined = checkAlias(alias);
  return sql`LEFT JOIN analytics.profiles AS ${raw(joined)} ON ${raw(joined)}.project_id = ${scope.projectId} AND ${raw(joined)}.id = ${qualify(scope.alias, 'profile_id')}`;
}

/**
 * One row per group id of the row joined with its group:
 * `CROSS JOIN LATERAL unnest(e.groups) AS _group_id LEFT JOIN analytics.groups
 * AS _g …` (ClickHouse's `ARRAY JOIN groups` — rows without groups drop out).
 * Pass the aliases as `groupJoin` in the scope.
 */
export function groupJoin(
  scope: Pick<EventFilterScope, 'projectId' | 'alias'>,
  aliases: GroupJoinAliases = GROUP_JOIN,
): Sql {
  const group = raw(checkAlias(aliases.alias));
  const id = raw(checkAlias(aliases.idAlias));
  return sql`CROSS JOIN LATERAL unnest(${qualify(scope.alias, 'groups')}) AS ${id} LEFT JOIN analytics.groups AS ${group} ON ${group}.project_id = ${scope.projectId} AND ${group}.id = ${id}`;
}

/**
 * Select list for a narrowed profile join: the id, one column per
 * referenced `profile.properties.<key>` (see collectProfilePropertyKeys) and
 * the full map only when a wildcard needs it. Use with
 * {@link narrowProfileScope}:
 *
 *   const { select, columns } = narrowedProfileSelect(keys, needsFullMap);
 *   sql`LEFT JOIN (SELECT ${select} FROM analytics.profiles WHERE project_id = ${pid}) AS profile ON profile.id = e.profile_id`
 *   narrowProfileScope({ ...scope, profileAlias: 'profile' }, columns)
 */
export function narrowedProfileSelect(
  keys: readonly string[],
  needsFullMap: boolean,
): { select: Sql; columns: Map<string, string> } {
  const columns = new Map<string, string>();
  const parts: Sql[] = [raw('id')];
  keys.forEach((key, index) => {
    const column = `pp_${index}`;
    columns.set(key, column);
    parts.push(sql`properties ->> ${key}::text AS ${raw(column)}`);
  });
  if (needsFullMap || keys.length === 0) {
    parts.push(raw('properties'));
  }
  return { select: join(parts), columns };
}

/** The scope reading narrowed profile properties from their columns. */
export function narrowProfileScope<T extends EventFilterScope>(
  scope: T,
  columns: ReadonlyMap<string, string>,
): T {
  return { ...scope, profileColumns: columns };
}

// --- cohorts ---------------------------------------------------------------------------------------------

function cohortMembership(
  profileId: Sql,
  cohortIds: readonly string[],
  negate: boolean,
  projectId: string,
): Sql {
  return sql`${profileId} ${raw(negate ? 'NOT IN' : 'IN')} (SELECT profile_id FROM analytics.cohort_members WHERE cohort_id = ANY(${[...cohortIds]}::text[]) AND project_id = ${projectId})`;
}

/** Profiles in a cohort (`buildCohortMembershipQuery`). */
export function cohortMembershipQuery(cohortId: string, projectId: string): Sql {
  return sql`SELECT profile_id FROM analytics.cohort_members WHERE cohort_id = ${cohortId} AND project_id = ${projectId}`;
}

/** `cohort_<id>`: the join alias of a cohort (`getCohortAlias`). */
export function cohortAlias(cohortId: string): string {
  return checkAlias(`cohort_${cohortId.replace(/-/g, '_')}`);
}

/**
 * `LEFT JOIN analytics.cohort_members AS cohort_<id> …` on the row's profile
 * (`buildInlineCohortJoin`); at most one row per profile.
 */
export function cohortJoin(cohortId: string, projectId: string, rowAlias?: string): Sql {
  const alias = raw(cohortAlias(cohortId));
  return sql`LEFT JOIN analytics.cohort_members AS ${alias} ON ${alias}.project_id = ${projectId} AND ${alias}.cohort_id = ${cohortId} AND ${alias}.profile_id = ${qualify(rowAlias, 'profile_id')}`;
}

/** Every (profile, cohort) pair of a project (`buildAllCohortsMembershipQuery`). */
export function allCohortsMembershipQuery(projectId: string): Sql {
  return sql`SELECT profile_id, cohort_id FROM analytics.cohort_members WHERE project_id = ${projectId}`;
}

/** The cohort name of a membership row (`buildAllCohortsLabelExpr`). */
export function allCohortsLabelExpr(
  cohorts: readonly CohortMetadata[],
  alias = '_all_cohorts',
): Sql {
  if (cohorts.length === 0) {
    return sql`'Unknown'::text`;
  }
  const cohortId = qualify(alias, 'cohort_id');
  const arms = cohorts.map((cohort) => sql`WHEN ${cohort.id}::text THEN ${cohort.name}::text`);
  return sql`(CASE ${cohortId} ${join(arms, ' ')} ELSE 'Unknown' END)`;
}

// --- prefixed filters (buildFilterWhere) --------------------------------------------------------------------

/** Session columns a `session.<field>` filter compares as numbers. */
const SESSION_NUMERIC_COLUMNS: ReadonlySet<string> = new Set([
  'screen_view_count',
  'event_count',
  'duration',
  'revenue',
]);

/**
 * One WHERE fragment per `cohort` / `group.*` / `profile.*` / `session.*`
 * filter on a list query; every other name (plain columns, `properties.*`)
 * is dropped, as ClickHouse's buildFilterWhere did.
 */
export function prefixedFilterClauses(
  filters: readonly Filter[],
  scope: PrefixedFilterScope,
): Sql[] {
  const clauses: Sql[] = [];
  for (const filter of filters) {
    const clause = prefixedFilterClause(filter, scope);
    if (clause) {
      clauses.push(clause);
    }
  }
  return clauses;
}

function prefixedFilterClause(filter: Filter, scope: PrefixedFilterScope): Sql | null {
  if (
    filter.operator === 'inCohort' ||
    filter.operator === 'notInCohort' ||
    filter.name.startsWith('cohort:')
  ) {
    return prefixedCohortClause(filter, scope);
  }
  if (filter.name.startsWith('group.')) {
    return prefixedGroupClause(filter, scope);
  }
  if (filter.name.startsWith('profile.')) {
    return prefixedProfileClause(filter, scope);
  }
  if (filter.name.startsWith('session.')) {
    return prefixedSessionClause(filter, scope);
  }
  return null;
}

function profileIdOf(scope: PrefixedFilterScope): Sql {
  return qualify(scope.alias, scope.table === 'profiles' ? 'id' : 'profile_id');
}

function prefixedCohortClause(filter: Filter, scope: PrefixedFilterScope): Sql | null {
  let cohortIds = getCohortIds(filter);
  // Older URLs carried the id only in the name.
  if (cohortIds.length === 0 && filter.name.startsWith('cohort:')) {
    cohortIds = [filter.name.slice('cohort:'.length)];
  }
  if (cohortIds.length === 0) {
    return null;
  }
  return cohortMembership(
    profileIdOf(scope),
    cohortIds,
    filter.operator === 'notInCohort',
    scope.projectId,
  );
}

function prefixedGroupClause(filter: Filter, scope: PrefixedFilterScope): Sql | null {
  const field = resolveGroupField(filter.name);
  const target: Target =
    'propertyKey' in field
      ? textTarget(jsonText(raw('_fg.properties'), field.propertyKey))
      : textTarget(raw(`_fg.${field.column}`));
  const inner = scalarClause(target, filter, { type: filter.type }, scope);
  if (!inner) {
    return null;
  }
  return sql`EXISTS (SELECT 1 FROM analytics.groups AS _fg WHERE _fg.project_id = ${scope.projectId} AND _fg.id = ANY(${qualify(scope.alias, 'groups')}) AND ${inner})`;
}

function prefixedProfileClause(filter: Filter, scope: PrefixedFilterScope): Sql | null {
  const field = resolveProfileField(filter.name);
  if (!field) {
    return null;
  }
  const self = scope.table === 'profiles';
  const alias = self ? scope.alias : '_fp';
  const target: Target =
    'propertyKey' in field
      ? textTarget(jsonText(qualify(alias, 'properties'), field.propertyKey))
      : { sql: qualify(alias, field.column), kind: field.kind };
  const numeric = 'column' in field && (field.column === 'created_at' || field.column === 'last_seen_at');
  const inner = scalarClause(target, filter, { numeric, type: filter.type }, scope);
  if (!inner) {
    return null;
  }
  if (self) {
    return inner;
  }
  return sql`${profileIdOf(scope)} IN (SELECT _fp.id FROM analytics.profiles AS _fp WHERE _fp.project_id = ${scope.projectId} AND ${inner})`;
}

function prefixedSessionClause(filter: Filter, scope: PrefixedFilterScope): Sql | null {
  if (scope.table !== 'sessions') {
    return null;
  }
  const field = filter.name.replace(/^session\./, '');

  if (field === 'performed_event') {
    if (filter.value.length === 0) {
      return null;
    }
    const names = filter.value.map(scalarText);
    const inWindow =
      scope.startDate && scope.endDate
        ? sessionEventDays(scope.startDate, scope.endDate)
        : raw('TRUE');
    return sql`${qualify(scope.alias, 'id')} ${raw(filter.operator === 'isNot' ? 'NOT IN' : 'IN')} (SELECT session_id FROM analytics.events WHERE project_id = ${scope.projectId} AND ${inWindow} AND name = ANY(${names}::text[]))`;
  }

  if (field === 'is_bounce') {
    if (filter.value.length === 0) {
      return null;
    }
    const wants = filter.value.some((item) =>
      typeof item === 'boolean' ? item : String(item).toLowerCase() === 'true',
    );
    const truthy = filter.operator === 'isNot' ? !wants : wants;
    return sql`${qualify(scope.alias, 'is_bounce')} = ${raw(truthy ? 'true' : 'false')}`;
  }

  if (SESSION_NUMERIC_COLUMNS.has(field)) {
    return scalarClause(
      { sql: qualify(scope.alias, field), kind: 'number' },
      filter,
      { numeric: true, type: filter.type },
      scope,
    );
  }
  return null;
}

/**
 * `toDate(created_at) BETWEEN toDate(start) AND toDate(end)`: UTC days on
 * both sides (the column's zone, see COLUMN_ZONE, and the UTC text of the
 * bounds), as an index-friendly instant range.
 */
function sessionEventDays(startDate: Date, endDate: Date): Sql {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  return sql`created_at >= (${day(startDate)}::date::timestamp AT TIME ZONE 'UTC') AND created_at < ((${day(endDate)}::date + 1)::timestamp AT TIME ZONE 'UTC')`;
}

/**
 * `compileScalarClause` of filter-where.service.ts: ILIKE for the text
 * operators, `doesNotContain` ANDed, Float64 comparisons for `numeric`.
 */
function scalarClause(
  target: Target,
  filter: Filter,
  options: { numeric?: boolean; type?: IChartFilterValueType },
  ctx: TimeCtx,
): Sql | null {
  const { operator, value } = filter;
  if (value.length === 0 && !isNullOperator(operator)) {
    return null;
  }
  if (hasTypedCast(options.type) && isTypedOperator(operator)) {
    return typedClause(target, operator, value, options.type, ctx);
  }
  const numeric = options.numeric === true;
  const text = asText(target);
  const compare = (comparator: string) =>
    anyOfValues(value, (item) =>
      numeric
        ? sql`${toFloat(target)} ${raw(comparator)} ${floatValue(scalarText(item))}`
        : sql`${ordered(textTarget(text))} ${raw(comparator)} ${bindText(scalarText(item))}`,
    );

  switch (operator) {
    case 'is':
      if (numeric) {
        return compare('=');
      }
      return value.length === 1
        ? sql`${text} = ${bindText(scalarText(value[0]!))}`
        : sql`${text} IN (${join(value.map((item) => bindText(scalarText(item))))})`;
    case 'isNot':
      if (numeric) {
        // An OR across values, as before.
        return compare('<>');
      }
      return value.length === 1
        ? sql`${text} <> ${bindText(scalarText(value[0]!))}`
        : sql`${text} NOT IN (${join(value.map((item) => bindText(scalarText(item))))})`;
    case 'contains':
      return anyOfValues(value, (item) => sql`${text} ILIKE ${likePattern('%', valueText(item), '%')}`);
    case 'doesNotContain':
      return allOfValues(value, (item) => sql`${text} NOT ILIKE ${likePattern('%', valueText(item), '%')}`);
    case 'startsWith':
      return anyOfValues(value, (item) => sql`${text} ILIKE ${likePattern('', valueText(item), '%')}`);
    case 'endsWith':
      return anyOfValues(value, (item) => sql`${text} ILIKE ${likePattern('%', valueText(item), '')}`);
    case 'regex':
      return anyOfValues(value, (item) => sql`${text} ~ ${bindText(scalarText(item))}`);
    case 'isNull':
      return sql`(${text} = '' OR ${target.sql} IS NULL)`;
    case 'isNotNull':
      return sql`(${text} <> '' AND ${target.sql} IS NOT NULL)`;
    case 'gt':
      return compare('>');
    case 'lt':
      return compare('<');
    case 'gte':
      return compare('>=');
    case 'lte':
      return compare('<=');
    default:
      return null;
  }
}
