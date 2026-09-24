import type {
  CohortDefinition,
  EventBasedCohortDefinition,
  EventCriteria,
  Frequency,
  IChartEventFilter,
  PropertyBasedCohortDefinition,
  Timeframe,
} from '@openpanel/validation';

import { cohortComputeQueue } from '@openpanel/queue';
import { type Queryable, anQuery, anTransaction } from '../analytics/client';
import { PROFILE_TABLE_COLUMNS, profileColumnKind } from '../analytics/fields';
import { gapFill } from '../analytics/fill';
import {
  cohortMembershipQuery,
  prefixedFilterClauses,
} from '../analytics/filters';
import { profileRow } from '../analytics/rows';
import { type Sql, and, empty, join, or, raw, sql } from '../analytics/sql';
import { parseTimestamp } from '../analytics/time';
import { insertCohortMembers } from '../analytics/writers';
import { db } from '../prisma-client';
import {
  type IClickhouseProfile,
  type IServiceProfile,
  profileSearchWhere,
  transformProfile,
} from './profile.service';

// Max members materialized into cohort_members per compute. Cohorts larger
// than this are truncated (to the first profile ids in order, so a refresh
// keeps the same subset), so deployments with bigger cohorts need to raise
// it — env-tunable to avoid an image rebuild for what is really a sizing
// knob.
//
// Strictly a positive safe integer: anything else falls back to the
// default. Number.parseInt would accept '5000junk' or '-1', and 0 is falsy
// at the `limit ? LIMIT ... : ''` call sites, which would silently remove
// the cap entirely.
const COHORT_MATERIALIZE_LIMIT_RAW = process.env.COHORT_MATERIALIZE_LIMIT;
const COHORT_MATERIALIZE_LIMIT_PARSED =
  COHORT_MATERIALIZE_LIMIT_RAW && /^\d+$/.test(COHORT_MATERIALIZE_LIMIT_RAW)
    ? Number(COHORT_MATERIALIZE_LIMIT_RAW)
    : Number.NaN;
export const COHORT_MATERIALIZE_LIMIT =
  Number.isSafeInteger(COHORT_MATERIALIZE_LIMIT_PARSED) &&
  COHORT_MATERIALIZE_LIMIT_PARSED > 0
    ? COHORT_MATERIALIZE_LIMIT_PARSED
    : 10000;

/**
 * The cohort queries ran without a session time zone: timeframes are UTC
 * days, and the list filters read dates in UTC.
 */
const UTC = { timezone: 'UTC' } as const;

const DAY_MS = 86_400_000;
const RELATIVE_TIMEFRAME = /^(\d+)d$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TRAILING_BACKSLASHES = /\\+$/;
const PROFILE_PREFIX = /^profile\./;
const PROFILES_PREFIX = /^profiles\./;

/** Members written per INSERT when a cohort is materialized. */
const MEMBER_INSERT_CHUNK = 5000;
/** Profile ids kept in cohort_metadata.sample_profiles. */
const SAMPLE_SIZE = 10;

/** A definition that matches nobody, shaped like every criterion. */
const NO_PROFILES = raw('SELECT NULL::text AS profile_id WHERE FALSE');
/** What ClickHouse read an empty string compared with a date-time as. */
const EPOCH = raw('to_timestamp(0)');

/**
 * A definition ClickHouse failed to run: a date `toDate` could not read, an
 * empty `contains` list (`AND ()`), a LIKE pattern ending in a lone
 * backslash, LIKE or a number comparison on a date column. The query
 * failed as a whole, so the whole definition matches nobody now — never a
 * single criterion, which inside "never did X" would match everybody.
 */
class RejectedDefinition extends Error {}

function rejectedAsEmpty<T>(build: () => T, nobody: T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof RejectedDefinition) {
      return nobody;
    }
    throw error;
  }
}

// --- timeframes ------------------------------------------------------------------

/**
 * The UTC days a criterion looks at, `to` included; open-ended without it.
 * The summary MVs keyed events by `toStartOfDay(created_at)` (UTC) and
 * compared that with `toDate(…)` bounds.
 */
interface DayWindow {
  from: string;
  to?: string;
}

/** The 'YYYY-MM-DD' of an instant, or null when it is not a 4-digit year. */
function utcDay(ms: number): string | null {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const day = date.toISOString().slice(0, 10);
  return CALENDAR_DATE.test(day) ? day : null;
}

/**
 * A 'YYYY-MM-DD' calendar date (the form zAbsoluteTimeframe accepts).
 * Anything else ClickHouse's toDate rejected or mangled ('2026-02-30' read
 * as March 2nd): the definition is rejected.
 */
function calendarDate(value: string): string {
  if (
    !CALENDAR_DATE.test(value) ||
    utcDay(Date.parse(`${value}T00:00:00Z`)) !== value
  ) {
    throw new RejectedDefinition(`Not a calendar date: ${value}`);
  }
  return value;
}

/**
 * `toDate(now() - INTERVAL n DAY)` (the JS clock stands in for now()) for a
 * relative timeframe, the given days for an absolute one.
 */
function timeframeWindow(timeframe: Timeframe): DayWindow {
  if (timeframe.type === 'relative') {
    const match = timeframe.value.match(RELATIVE_TIMEFRAME);
    if (!match) {
      throw new Error(`Invalid relative timeframe: ${timeframe.value}`);
    }
    const days = Number.parseInt(match[1]!, 10);
    const from = utcDay(Date.now() - days * DAY_MS);
    if (!from) {
      throw new RejectedDefinition(`Timeframe out of range: ${timeframe.value}`);
    }
    return { from };
  }

  const from = calendarDate(timeframe.start);
  return timeframe.end ? { from, to: calendarDate(timeframe.end) } : { from };
}

/** Events on the window's days, as an instant range on created_at. */
function eventsInWindow(window: DayWindow): Sql {
  const from = sql`e.created_at >= (${window.from}::date::timestamp AT TIME ZONE 'UTC')`;
  if (!window.to) {
    return from;
  }
  return sql`${from} AND e.created_at < ((${window.to}::date + 1)::timestamp AT TIME ZONE 'UTC')`;
}

/** profile_event_days rows on the window's days. */
function rollupDaysInWindow(window: DayWindow): Sql {
  const from = sql`d.day >= ${window.from}::date`;
  return window.to ? sql`${from} AND d.day <= ${window.to}::date` : from;
}

// --- LIKE ----------------------------------------------------------------------------

/**
 * `value [NOT] LIKE pattern`. A pattern ending in a lone backslash is an
 * invalid escape to both engines.
 */
function like(value: Sql, pattern: string, negate = false): Sql {
  const trailing = pattern.length - pattern.replace(TRAILING_BACKSLASHES, '').length;
  if (trailing % 2 === 1) {
    throw new RejectedDefinition(`Invalid LIKE pattern: ${pattern}`);
  }
  return sql`${value} ${raw(negate ? 'NOT LIKE' : 'LIKE')} ${pattern}::text`;
}

/** `(a OR b …)` of LIKE tests; without values ClickHouse's `()` failed. */
function anyLike(value: Sql, patterns: string[], negate = false): Sql {
  if (patterns.length === 0) {
    throw new RejectedDefinition('LIKE without values');
  }
  return sql`(${or(patterns.map((pattern) => like(value, pattern, negate)))})`;
}

/** `(a AND b …)` of LIKE tests; without values ClickHouse's `()` failed. */
function allLike(value: Sql, patterns: string[], negate = false): Sql {
  if (patterns.length === 0) {
    throw new RejectedDefinition('LIKE without values');
  }
  return sql`(${and(patterns.map((pattern) => like(value, pattern, negate)))})`;
}

/** Filter values as the cohort builders compared them: `String(v).trim()`. */
function filterValues(filter: IChartEventFilter): string[] {
  return filter.value.map((item) => String(item).trim());
}

// --- event criteria ------------------------------------------------------------------

const FREQUENCY_OPERATORS: Record<string, string> = {
  gte: '>=',
  eq: '=',
  lte: '<=',
};

function frequencyOperator(frequency: Frequency): Sql {
  return raw(FREQUENCY_OPERATORS[frequency.operator] ?? '>=');
}

// "Exactly 0" and "at most 0" both mean the profile never did the event.
// Neither can be expressed as a HAVING over the events: a profile only has
// a group there when it did the event at least once, so every group that
// reaches the HAVING already counts >= 1 and the criterion returns nothing.
// The query has to be inverted instead.
//
// `gte 0` is not "never" — it matches every profile — and zFrequency rejects
// it, so it stays on the ordinary HAVING path.
function isNeverFrequency(frequency: Frequency): boolean {
  return (
    frequency.count === 0 &&
    (frequency.operator === 'eq' || frequency.operator === 'lte')
  );
}

// Every profile in the project except the ones that did the event. The
// timeframe stays inside the subquery, so "never did X in the last 30 days"
// keeps including someone who did X 60 days ago, matching how the timeframe
// control reads for a positive criterion. `didEvent` is correlated on p.id.
function neverDidEventQuery(projectId: string, didEvent: Sql): Sql {
  return sql`
    SELECT p.id AS profile_id
    FROM analytics.profiles AS p
    WHERE p.project_id = ${projectId}
      AND NOT EXISTS (${didEvent})
  `;
}

/**
 * The criterion's events: identified profiles (the summary MVs kept
 * `profile_id != device_id` rows; the empty id is left out, as in the
 * profile_event_days rollup), its event name, its window.
 */
function criterionEvents(projectId: string, name: string, window: DayWindow): Sql {
  return sql`e.project_id = ${projectId}
    AND e.name = ${name}::text
    AND e.profile_id <> e.device_id
    AND e.profile_id <> ''
    AND ${eventsInWindow(window)}`;
}

/** A property filter's test of one property value, as it ran on the MV's property_value. */
function propertyValuePredicate(value: Sql, filter: IChartEventFilter): Sql {
  const values = filterValues(filter);
  switch (filter.operator) {
    case 'is':
      return values.length === 1
        ? sql`${value} = ${values[0]}::text`
        : sql`${value} = ANY(${values}::text[])`;
    case 'isNot':
      return values.length === 1
        ? sql`${value} <> ${values[0]}::text`
        : sql`${value} <> ALL(${values}::text[])`;
    case 'contains':
      return anyLike(value, values.map((item) => `%${item}%`));
    case 'doesNotContain':
      return allLike(value, values.map((item) => `%${item}%`), true);
    default:
      return sql`${value} = ANY(${values}::text[])`;
  }
}

/**
 * How an event matches a criterion's property filters. The summary MV had
 * one row per non-empty (property_key, property_value) pair of an event; a
 * row matched when `property_key = <key> AND <value test>` held for some
 * filter (the filters were ORed), and a frequency summed the matching rows'
 * event counts — so an event counts once per matching pair. Filters on the
 * same key test the same pair.
 */
function propertyMatch(filters: IChartEventFilter[]): { any: Sql; pairs: Sql } {
  const byKey = new Map<string, IChartEventFilter[]>();
  for (const filter of filters) {
    const key = filter.name.replace('properties.', '');
    byKey.set(key, [...(byKey.get(key) ?? []), filter]);
  }
  const pairMatches = [...byKey].map(([key, keyFilters]) => {
    const value = sql`COALESCE(e.properties ->> ${key}::text, '')`;
    const predicates = or(keyFilters.map((filter) => propertyValuePredicate(value, filter)));
    return sql`(${value} <> '' AND (${predicates}))`;
  });
  return {
    any: sql`(${or(pairMatches)})`,
    pairs: join(
      pairMatches.map((match) => sql`(CASE WHEN ${match} THEN 1 ELSE 0 END)`),
      ' + ',
    ),
  };
}

/**
 * The profile ids (one row each) meeting one event criterion. Filters other
 * than `properties.*` are ignored, as before. Without property filters the
 * "did it at all" forms read the profile_event_days rollup, which holds
 * exactly the (profile, event, UTC day) rows the summary MV had; counts and
 * property pairs come from the events of the window.
 */
export function buildEventCriteriaQuery(
  projectId: string,
  criteria: EventCriteria,
): Sql {
  return rejectedAsEmpty(() => eventCriterionQuery(projectId, criteria), NO_PROFILES);
}

function eventCriterionQuery(projectId: string, criteria: EventCriteria): Sql {
  const { name, filters, timeframe, frequency } = criteria;
  const window = timeframeWindow(timeframe);
  const count = frequency ? Number(frequency.count) : 0;
  if (frequency && !Number.isFinite(count)) {
    throw new RejectedDefinition(`Invalid frequency: ${frequency.count}`);
  }

  const propertyFilters = filters.filter((filter) =>
    filter.name.startsWith('properties.'),
  );

  if (propertyFilters.length > 0) {
    const match = propertyMatch(propertyFilters);
    if (frequency && isNeverFrequency(frequency)) {
      // "Never did X where plan = pro" reads as "has no matching (event,
      // property) pair": someone who did the event with plan = free is a
      // member.
      return neverDidEventQuery(
        projectId,
        sql`SELECT 1 FROM analytics.events AS e
          WHERE ${criterionEvents(projectId, name, window)}
            AND e.profile_id = p.id
            AND ${match.any}`,
      );
    }
    if (frequency) {
      return sql`
        SELECT e.profile_id
        FROM analytics.events AS e
        WHERE ${criterionEvents(projectId, name, window)}
          AND ${match.any}
        GROUP BY e.profile_id
        HAVING sum(${match.pairs}) ${frequencyOperator(frequency)} ${count}::numeric
      `;
    }
    return sql`
      SELECT DISTINCT e.profile_id
      FROM analytics.events AS e
      WHERE ${criterionEvents(projectId, name, window)}
        AND ${match.any}
    `;
  }

  const rollupRows = sql`d.project_id = ${projectId}
    AND d.name = ${name}::text
    AND ${rollupDaysInWindow(window)}`;

  if (frequency && isNeverFrequency(frequency)) {
    return neverDidEventQuery(
      projectId,
      sql`SELECT 1 FROM analytics.profile_event_days AS d
        WHERE ${rollupRows} AND d.profile_id = p.id`,
    );
  }
  if (frequency) {
    return sql`
      SELECT e.profile_id
      FROM analytics.events AS e
      WHERE ${criterionEvents(projectId, name, window)}
      GROUP BY e.profile_id
      HAVING count(*) ${frequencyOperator(frequency)} ${count}::numeric
    `;
  }
  return sql`
    SELECT DISTINCT d.profile_id
    FROM analytics.profile_event_days AS d
    WHERE ${rollupRows}
  `;
}

// --- property criteria ---------------------------------------------------------------------

interface ProfileTarget {
  sql: Sql;
  kind: 'text' | 'timestamp';
}

function profileTarget(name: string): ProfileTarget {
  const normalizedName = name.replace(PROFILE_PREFIX, 'profiles.');
  if (normalizedName.startsWith('profiles.properties.')) {
    const propKey = normalizedName.replace('profiles.properties.', '');
    return {
      // A missing key reads as '', ClickHouse's Map default.
      sql: sql`COALESCE(profiles.properties ->> ${propKey}::text, '')`,
      kind: 'text',
    };
  }
  const column = normalizedName.replace(PROFILES_PREFIX, '');
  if (!PROFILE_TABLE_COLUMNS.has(column)) {
    throw new Error(`Unknown profile filter column: ${name}`);
  }
  return {
    sql: raw(`profiles.${column}`),
    kind: profileColumnKind(column) === 'timestamp' ? 'timestamp' : 'text',
  };
}

// SQL for a profile filter's column: a properties key (bound, so a quote in
// it stays a value) or a plain column, qualified with the `profiles` alias.
// The column name is an identifier and cannot be bound like a value, so it
// must come from the allowlist (GHSA-gvwr-5684-wjqc).
export function profileColumnAccess(name: string): Sql {
  return profileTarget(name).sql;
}

const NUMERIC_COMPARATORS: Partial<Record<IChartEventFilter['operator'], string>> = {
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
};

/**
 * `toFloat64OrNull(column) <op> <first value>`. The value went into the
 * SQL as a JS number: NaN compared false, ±Infinity as themselves.
 */
function numericClause(target: Sql, filter: IChartEventFilter): Sql {
  const number = Number(filter.value[0]);
  if (Number.isNaN(number)) {
    return raw('FALSE');
  }
  return sql`analytics.to_float_or_null(${target}) ${raw(NUMERIC_COMPARATORS[filter.operator]!)} ${number}::double precision`;
}

function textProfileClause(target: Sql, filter: IChartEventFilter): Sql | null {
  const values = filterValues(filter);
  switch (filter.operator) {
    case 'is':
      return values.length === 1
        ? sql`${target} = ${values[0]}::text`
        : sql`${target} = ANY(${values}::text[])`;
    case 'isNot':
      return values.length === 1
        ? sql`${target} <> ${values[0]}::text`
        : sql`${target} <> ALL(${values}::text[])`;
    case 'contains':
      return anyLike(target, values.map((item) => `%${item}%`));
    case 'doesNotContain':
      // An OR across the values, as it always was here.
      return anyLike(target, values.map((item) => `%${item}%`), true);
    case 'startsWith':
      return anyLike(target, values.map((item) => `${item}%`));
    case 'endsWith':
      return anyLike(target, values.map((item) => `%${item}`));
    case 'isNull':
      return sql`${target} = ''`;
    case 'isNotNull':
      return sql`${target} <> ''`;
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte':
      return numericClause(target, filter);
    default:
      return null;
  }
}

/**
 * created_at / last_seen_at: ClickHouse compared them with the values read
 * as UTC date-times (an empty value as the epoch), and could not run LIKE
 * or toFloat64OrNull on them.
 */
function timestampProfileClause(target: Sql, filter: IChartEventFilter): Sql | null {
  const values = filterValues(filter).map((item) =>
    item === '' ? EPOCH : parseTimestamp(sql`${item}::text`, UTC),
  );
  switch (filter.operator) {
    case 'is':
      return values.length === 1
        ? sql`${target} = ${values[0]!}`
        : sql`${target} IN (${join(values)})`;
    case 'isNot':
      return values.length === 1
        ? sql`${target} <> ${values[0]!}`
        : sql`${target} NOT IN (${join(values)})`;
    case 'isNull':
      return sql`${target} = ${EPOCH}`;
    case 'isNotNull':
      return sql`${target} <> ${EPOCH}`;
    case 'contains':
    case 'doesNotContain':
    case 'startsWith':
    case 'endsWith':
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte':
      throw new RejectedDefinition(`${filter.operator} on a date column`);
    default:
      return null;
  }
}

// Known gap, not fixed here: there is no case for 'inCohort' or
// 'notInCohort', so one of those inside a cohort definition is dropped
// without an error and the cohort silently widens. The same operators do
// work at report level (analytics/filters.ts).
function profileFilterClause(filter: IChartEventFilter, target: ProfileTarget): Sql | null {
  const { value, operator } = filter;
  if (value.length === 0 && operator !== 'isNull' && operator !== 'isNotNull') {
    return null;
  }
  return target.kind === 'timestamp'
    ? timestampProfileClause(target.sql, filter)
    : textProfileClause(target.sql, filter);
}

/**
 * The definition's filters combined with its operator, or null when it
 * matches nobody: every filter was dropped, or the definition was rejected.
 * Every name is resolved first, as before: an unknown column throws even
 * when its own filter would have been dropped.
 *
 * analytics.profiles holds one row per profile, so no newest-row
 * resolution (ClickHouse's argMax over versions) is needed.
 */
function propertyCohortCondition(
  definition: PropertyBasedCohortDefinition,
): Sql | null {
  const { properties, operator } = definition.criteria;
  const targets = properties.map((filter) => profileTarget(filter.name));
  return rejectedAsEmpty(() => {
    const clauses: Sql[] = [];
    properties.forEach((filter, index) => {
      const clause = profileFilterClause(filter, targets[index]!);
      if (clause) {
        clauses.push(clause);
      }
    });
    if (clauses.length === 0) {
      return null;
    }
    return operator === 'and' ? and(clauses) : or(clauses);
  }, null);
}

export function buildPropertyBasedCohortQuery(
  projectId: string,
  definition: PropertyBasedCohortDefinition,
  limit?: number,
): Sql {
  const condition = propertyCohortCondition(definition);
  if (!condition) {
    return NO_PROFILES;
  }
  return sql`
    SELECT profiles.id AS profile_id
    FROM analytics.profiles AS profiles
    WHERE profiles.project_id = ${projectId}
      AND (${condition})
    ${limit ? sql`ORDER BY profiles.id LIMIT ${limit}` : empty}
  `;
}

// Every criterion emits one row per matching profile under the column name
// profile_id, which is what lets them be combined as sets.
export function buildEventBasedCohortQuery(
  projectId: string,
  definition: EventBasedCohortDefinition,
): Sql {
  const { events, operator } = definition.criteria;
  if (events.length === 0) {
    return NO_PROFILES;
  }
  return rejectedAsEmpty(() => {
    const queries = events.map(
      (eventCriteria) => sql`(${eventCriterionQuery(projectId, eventCriteria)})`,
    );
    return join(queries, operator === 'and' ? ' INTERSECT ' : ' UNION ');
  }, NO_PROFILES);
}

export async function computeEventBasedCohort(
  projectId: string,
  definition: EventBasedCohortDefinition,
  limit?: number,
): Promise<string[]> {
  const combinedQuery = buildEventBasedCohortQuery(projectId, definition);

  // The LIMIT wraps the combination: on the last operand alone it would cut
  // a "never did X" set (most of the project) down to an arbitrary slice
  // before the INTERSECT. Ordered, so a capped cohort keeps the same members
  // from one refresh to the next.
  const finalQuery = limit
    ? sql`SELECT profile_id FROM (${combinedQuery}) AS cohort ORDER BY profile_id LIMIT ${limit}`
    : combinedQuery;

  const results = await anQuery<{ profile_id: string }>(finalQuery);
  return results.map((r) => r.profile_id);
}

export async function countEventBasedCohort(
  projectId: string,
  definition: EventBasedCohortDefinition,
): Promise<number> {
  const combinedQuery = buildEventBasedCohortQuery(projectId, definition);
  const results = await anQuery<{ count: number }>(
    sql`SELECT count(*) AS count FROM (${combinedQuery}) AS cohort`,
  );
  return results[0]?.count ?? 0;
}

export async function computePropertyBasedCohort(
  projectId: string,
  definition: PropertyBasedCohortDefinition,
  limit?: number,
): Promise<string[]> {
  if (!propertyCohortCondition(definition)) {
    return [];
  }

  const results = await anQuery<{ profile_id: string }>(
    buildPropertyBasedCohortQuery(projectId, definition, limit),
  );
  return results.map((r) => r.profile_id);
}

export async function countPropertyBasedCohort(
  projectId: string,
  definition: PropertyBasedCohortDefinition,
): Promise<number> {
  if (!propertyCohortCondition(definition)) {
    return 0;
  }

  const results = await anQuery<{ count: number }>(
    sql`SELECT count(*) AS count FROM (${buildPropertyBasedCohortQuery(projectId, definition)}) AS cohort`,
  );
  return results[0]?.count ?? 0;
}

// --- stored membership ---------------------------------------------------------------------

/**
 * Upsert members and the cohort's metadata row. Pass the transaction's
 * client to make it part of a larger write (see updateCohortMembership).
 */
export async function storeCohortMembership(
  projectId: string,
  cohortId: string,
  profileIds: string[],
  version: number,
  client?: Queryable,
): Promise<void> {
  const members = [...new Set(profileIds)];
  const now = `${new Date().toISOString().slice(0, 19)}Z`;

  for (let index = 0; index < members.length; index += MEMBER_INSERT_CHUNK) {
    await insertCohortMembers(
      members.slice(index, index + MEMBER_INSERT_CHUNK).map((profileId) => ({
        project_id: projectId,
        cohort_id: cohortId,
        profile_id: profileId,
        matched_at: now,
        matching_properties: {},
        version,
      })),
      client,
    );
  }

  await anQuery(
    sql`
      INSERT INTO analytics.cohort_metadata (project_id, cohort_id, member_count, last_computed_at, sample_profiles, version)
      VALUES (${projectId}, ${cohortId}, ${members.length}, ${now}::timestamptz, ${members.slice(0, SAMPLE_SIZE)}::text[], ${version})
      ON CONFLICT (project_id, cohort_id) DO UPDATE SET
        member_count = EXCLUDED.member_count,
        last_computed_at = EXCLUDED.last_computed_at,
        sample_profiles = EXCLUDED.sample_profiles,
        version = EXCLUDED.version
    `,
    undefined,
    client,
  );
}

function deleteMembers(projectId: string, cohortId: string, client: Queryable) {
  return anQuery(
    sql`DELETE FROM analytics.cohort_members WHERE project_id = ${projectId} AND cohort_id = ${cohortId}`,
    undefined,
    client,
  );
}

function deleteMetadata(projectId: string, cohortId: string, client: Queryable) {
  return anQuery(
    sql`DELETE FROM analytics.cohort_metadata WHERE project_id = ${projectId} AND cohort_id = ${cohortId}`,
    undefined,
    client,
  );
}

export async function getCohortMembers(
  cohortId: string,
  projectId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ profileIds: string[]; total: number }> {
  const cohort = await db.cohort.findUnique({ where: { id: cohortId } });

  if (!cohort) {
    throw new Error('Cohort not found');
  }

  // All members of a compute share matched_at; the id keeps pages stable.
  const results = await anQuery<{ profile_id: string; total: number }>(sql`
    SELECT
      profile_id,
      count(*) OVER () AS total
    FROM analytics.cohort_members
    WHERE project_id = ${projectId}
      AND cohort_id = ${cohortId}
    ORDER BY matched_at DESC, profile_id ASC
    ${opts?.limit ? sql`LIMIT ${opts.limit}` : empty}
    ${opts?.offset ? sql`OFFSET ${opts.offset}` : empty}
  `);
  return {
    profileIds: results.map((r) => r.profile_id),
    total: results[0]?.total || 0,
  };
}

export async function getCohortCount(
  cohortId: string,
  projectId: string,
): Promise<number> {
  const cohort = await db.cohort.findUnique({ where: { id: cohortId } });

  if (!cohort) {
    throw new Error('Cohort not found');
  }

  if (cohort.lastComputedAt) {
    const age = Date.now() - cohort.lastComputedAt.getTime();
    if (age < 15 * 60 * 1000) {
      return cohort.profileCount;
    }
  }

  const result = await anQuery<{ count: number }>(sql`
    SELECT count(*) AS count
    FROM analytics.cohort_members
    WHERE project_id = ${projectId}
      AND cohort_id = ${cohortId}
  `);
  return result[0]?.count || 0;
}

export async function computeCohort(
  projectId: string,
  definition: CohortDefinition,
  limit?: number,
): Promise<string[]> {
  if (definition.type === 'event') {
    return computeEventBasedCohort(projectId, definition, limit);
  }
  if (definition.type === 'property') {
    return computePropertyBasedCohort(projectId, definition, limit);
  }
  return [];
}

export async function countCohort(
  projectId: string,
  definition: CohortDefinition,
): Promise<number> {
  if (definition.type === 'event') {
    return countEventBasedCohort(projectId, definition);
  }
  if (definition.type === 'property') {
    return countPropertyBasedCohort(projectId, definition);
  }
  return 0;
}

/**
 * Recompute a cohort and swap its stored membership in one transaction:
 * readers see the previous members or the new ones, never a mix, and the
 * cohort's profileCount/lastComputedAt change with them. Safe to rerun at
 * any point (the refresh cron runs every 30 minutes, jobs are retried):
 * every run replaces the whole membership.
 *
 * The compute runs before the transaction. Inside it, the cohort's row is
 * locked first: a concurrent recompute of the same cohort waits for this one
 * (the later commit wins), and deleting the cohort waits too — or, when the
 * cohort is already gone, nothing is written and leftovers are removed.
 */
export async function updateCohortMembership(
  cohortId: string,
): Promise<void> {
  const cohort = await db.cohort.findUnique({ where: { id: cohortId } });

  if (!cohort) {
    return;
  }

  const definition = cohort.definition as CohortDefinition;
  const profileIds = [
    ...new Set(
      await computeCohort(
        cohort.projectId,
        definition,
        COHORT_MATERIALIZE_LIMIT,
      ),
    ),
  ];

  const version = Date.now();
  const computedAt = new Date(version).toISOString();

  await anTransaction(async (client) => {
    const locked = await anQuery<{ id: string }>(
      sql`SELECT id FROM public.cohorts WHERE id = ${cohort.id}::uuid FOR UPDATE`,
      undefined,
      client,
    );
    await deleteMembers(cohort.projectId, cohort.id, client);
    if (locked.length === 0) {
      await deleteMetadata(cohort.projectId, cohort.id, client);
      return;
    }
    await storeCohortMembership(
      cohort.projectId,
      cohort.id,
      profileIds,
      version,
      client,
    );
    // Prisma's DateTime columns are UTC `timestamp(3)`; updatedAt is what
    // Prisma's @updatedAt would have set.
    await anQuery(
      sql`
        UPDATE public.cohorts
        SET "profileCount" = ${profileIds.length},
          "lastComputedAt" = (${computedAt}::timestamptz AT TIME ZONE 'UTC'),
          "updatedAt" = (${computedAt}::timestamptz AT TIME ZONE 'UTC')
        WHERE id = ${cohort.id}::uuid
      `,
      undefined,
      client,
    );
  });
}

export async function deleteCohortMembership(
  cohortId: string,
  projectId: string,
): Promise<void> {
  await anTransaction(async (client) => {
    await deleteMembers(projectId, cohortId, client);
    await deleteMetadata(projectId, cohortId, client);
  });
}

export async function getProfilesInCohort(
  cohortId: string,
  projectId: string,
): Promise<Set<string>> {
  const { profileIds } = await getCohortMembers(cohortId, projectId, {
    limit: 100000,
  });
  return new Set(profileIds);
}

/**
 * Enqueue a recompute for a cohort.
 *
 * Uses `deduplication` rather than a fixed `jobId`. A fixed jobId makes BullMQ
 * short-circuit `add` for as long as *any* record for that id exists in Redis —
 * and `removeOnComplete: { age }` is not a TTL, it only trims on some other
 * job in the queue finishing. That deadlocks: nothing can be added because the
 * completed record is still there, and the record is never collected because
 * nothing gets added. The deduplication key, in contrast, is released by
 * `moveToFinished` on both completion and terminal failure, so it only collapses
 * a compute that is genuinely still in flight.
 */
export async function enqueueCohortCompute(cohortId: string): Promise<void> {
  await cohortComputeQueue.add(
    'cohortCompute',
    { cohortId },
    {
      deduplication: { id: `cohort-${cohortId}` },
    },
  );
}

/** A cohort's members as full profiles, newest first (trpc cohort.listProfiles). */
export async function listCohortMemberProfiles({
  projectId,
  cohortId,
  cursor,
  take,
  search,
  filters,
}: {
  projectId: string;
  cohortId: string;
  cursor?: number;
  take: number;
  search?: string;
  filters?: IChartEventFilter[];
}): Promise<{ data: IServiceProfile[]; count: number }> {
  const offset = Math.max(0, (cursor ?? 0) * take);

  // count(*) OVER () is the total before the page: 0 past the last page.
  const rows = await anQuery<IClickhouseProfile & { total_count: number }>(sql`
    SELECT ${profileRow('p')}, count(*) OVER () AS total_count
    FROM analytics.profiles AS p
    WHERE ${and([
      sql`p.project_id = ${projectId}`,
      sql`p.id IN (${cohortMembershipQuery(cohortId, projectId)})`,
      profileSearchWhere(search, 'p'),
      // Only cohort / group.* / profile.* filters apply to profiles.
      ...prefixedFilterClauses(filters ?? [], {
        ...UTC,
        projectId,
        table: 'profiles',
        alias: 'p',
      }),
    ])}
    ORDER BY p.created_at DESC, p.id ASC
    LIMIT ${take} OFFSET ${offset}
  `);

  const count = rows[0]?.total_count ?? 0;
  const data = rows.map(({ total_count: _total, ...profile }) =>
    transformProfile(profile),
  );
  return { data, count };
}

export async function getCohortMemberEvents(
  projectId: string,
  cohortId: string,
  limit = 10,
): Promise<{ name: string; count: number }[]> {
  return anQuery<{ name: string; count: number }>(sql`
    SELECT e.name, count(*) AS count
    FROM analytics.events AS e
    WHERE e.project_id = ${projectId}
      AND e.profile_id IN (${cohortMembershipQuery(cohortId, projectId)})
      AND e.name NOT IN ('screen_view', 'session_start', 'session_end')
    GROUP BY e.name
    ORDER BY 2 DESC, 1 ASC
    LIMIT ${limit}
  `);
}

/**
 * Events of the cohort's members per UTC day since `days` days ago, every
 * day up to today present (ClickHouse's WITH FILL, filled in JS).
 */
export async function getCohortEventsPerDay(
  projectId: string,
  cohortId: string,
  days = 30,
): Promise<{ date: string; count: number }[]> {
  const now = Date.now();
  const from = utcDay(now - days * DAY_MS);
  const to = utcDay(now + DAY_MS);
  if (!(from && to)) {
    return [];
  }

  const rows = await anQuery<{ date: string; count: number }>(sql`
    SELECT
      to_char((e.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
      count(*) AS count
    FROM analytics.events AS e
    WHERE e.project_id = ${projectId}
      AND e.created_at >= (${from}::date::timestamp AT TIME ZONE 'UTC')
      AND e.profile_id IN (${cohortMembershipQuery(cohortId, projectId)})
    GROUP BY 1
    ORDER BY 1 ASC
  `);
  return gapFill(rows, {
    key: 'date',
    from,
    to,
    unit: 'day',
    format: 'date',
    fill: (date) => ({ date, count: 0 }),
  }).map((r) => ({ date: String(r.date), count: Number(r.count) }));
}

export async function getCohortMemberRoutes(
  projectId: string,
  cohortId: string,
  limit = 10,
): Promise<{ path: string; count: number }[]> {
  return anQuery<{ path: string; count: number }>(sql`
    SELECT e.path, count(*) AS count
    FROM analytics.events AS e
    WHERE e.project_id = ${projectId}
      AND e.profile_id IN (${cohortMembershipQuery(cohortId, projectId)})
      AND e.name = 'screen_view'
      AND e.path <> ''
    GROUP BY e.path
    ORDER BY 2 DESC, 1 ASC
    LIMIT ${limit}
  `);
}
