import { NOT_SET_VALUE } from '@openpanel/constants';
import type { IInterval, IReportInput } from '@openpanel/validation';
import { omit } from 'ramda';
import { anQuery } from '../analytics/client';
import { fetchCohortsMetadata } from '../analytics/cohorts';
import {
  EVENT_TABLE_COLUMNS,
  collectBreakdownCohortIds,
  extractCohortId,
  isAllCohortsBreakdown,
  isKnownEventField,
  isWildcardProperty,
  normalizeEventField,
  resolveProfileField,
} from '../analytics/fields';
import { eventFilterClauses, eventPropertyExpr } from '../analytics/filters';
import { clix } from '../analytics/query-builder';
import { type Sql, and, join, raw, sql } from '../analytics/sql';
import { type TimeCtx, startOf, toLocal } from '../analytics/time';
import {
  millisecondsInterval,
  windowFunnelCtes,
} from '../analytics/window-funnel';
import { EVENTS, dateRange, eventJoins } from './funnel-query';
import { mergeGlobalFilters, onlyReportEvents } from './reports.service';

/**
 * Breakdowns the conversion chart can group by: known event fields, minus
 * those ClickHouse failed on — the all-cohorts breakdown (bare `cohort`)
 * and `profile.*` names that are neither a profile column nor a property.
 */
function isConversionBreakdown(name: string): boolean {
  if (!isKnownEventField(name) || isAllCohortsBreakdown(name)) {
    return false;
  }
  return !name.startsWith('profile.') || resolveProfileField(name) !== null;
}

/** Whether a breakdown's value is text (ClickHouse ordered strings bytewise). */
function isTextBreakdown(name: string): boolean {
  const field = normalizeEventField(name);
  if (isWildcardProperty(field)) {
    return false;
  }
  if (Object.hasOwn(EVENT_TABLE_COLUMNS, field)) {
    return EVENT_TABLE_COLUMNS[field] === 'text';
  }
  if (field.startsWith('profile.')) {
    const profileField = resolveProfileField(field);
    return !(profileField && 'column' in profileField) || profileField.kind === 'text';
  }
  // Properties, groups, cohort labels and has_profile.
  return true;
}

/**
 * The project-zone bucket of an event (ClickHouse's `toStartOf<interval>`
 * under session_timezone), as a wall-clock timestamp. Weeks start on
 * Sunday: the query used `toStartOfWeek`'s default mode.
 */
function conversionBucket(interval: IInterval, ctx: TimeCtx): Sql {
  const createdAt = raw(`${EVENTS}.created_at`);
  if (interval === 'week') {
    return sql`(date_trunc('week', ${toLocal(createdAt, ctx)} + interval '1 day') - interval '1 day')`;
  }
  return startOf(createdAt, interval, ctx);
}

export class ConversionService {
  // biome-ignore lint/complexity/noUselessConstructor: callers still pass the ClickHouse client
  constructor(_client?: unknown) {
    // Ignored: the queries run on the analytics pool of the current scope.
  }

  async getConversion({
    projectId,
    startDate,
    endDate,
    options,
    series,
    globalFilters,
    breakdowns = [],
    limit,
    interval,
    timezone,
  }: Omit<IReportInput, 'range' | 'previous' | 'metric' | 'chartType'> & {
    timezone: string;
  }) {
    series = mergeGlobalFilters(series, globalFilters);
    const funnelOptions = options?.type === 'funnel' ? options : undefined;
    const funnelGroup = funnelOptions?.funnelGroup;
    const funnelWindow = funnelOptions?.funnelWindow ?? 24;
    const group = funnelGroup === 'profile_id' ? 'profile_id' : 'session_id';

    // Same guard as FunnelService — drop breakdowns whose name can't be
    // resolved against the events schema.
    breakdowns = breakdowns.filter((b) => isConversionBreakdown(b.name));

    const events = onlyReportEvents(series);

    if (events.length !== 2) {
      throw new Error('events must be an array of two events');
    }

    if (!startDate || !endDate) {
      throw new Error('startDate and endDate are required');
    }

    const cohortMetadata = await fetchCohortsMetadata(
      collectBreakdownCohortIds(breakdowns),
    );
    const eventA = events[0]!;
    const eventB = events[1]!;
    const needsGroupJoin =
      breakdowns.some((b) => b.name.startsWith('group.')) ||
      events.some((e) => e.filters?.some((f) => f.name.startsWith('group.')));
    const { joins, scope } = eventJoins({
      projectId,
      timezone,
      filters: events.flatMap((e) => e.filters ?? []),
      breakdowns,
      groups: needsGroupJoin,
    });

    const breakdownColumns = breakdowns.map((b, index) => {
      const cohortId = extractCohortId(b.name);
      const cohort = cohortId
        ? { id: cohortId, name: cohortMetadata.get(cohortId)?.name }
        : undefined;
      return {
        column: raw(`b_${index}`),
        expression: eventPropertyExpr(b.name, scope, cohort),
        text: isTextBreakdown(b.name),
      };
    });
    const stepCondition = (event: typeof eventA): Sql =>
      and([
        sql`${raw(EVENTS)}.name = ${event.name}::text`,
        ...eventFilterClauses(event.filters ?? [], scope),
      ]);
    const ctx: TimeCtx = { timezone };
    const e = raw(EVENTS);

    // One row per event of either step, as ClickHouse's inner query read
    // them: the group key and the breakdown values are the funnel's GROUP
    // BY keys, `at_second` is toDateTime(created_at), `bucket` feeds
    // `any(toStartOf…(created_at))`.
    const rows = sql`SELECT ${join([
      sql`${e}.${raw(group)}`,
      ...breakdownColumns.map((b) => sql`${b.expression} AS ${b.column}`),
      sql`date_trunc('second', ${e}.created_at) AS at_second`,
      sql`${conversionBucket(interval, ctx)} AS bucket`,
      sql`(${stepCondition(eventA)}) AS step_1`,
      sql`(${stepCondition(eventB)}) AS step_2`,
    ])}
      FROM analytics.events AS ${e} ${joins}
      WHERE ${and([
        sql`${e}.project_id = ${projectId}`,
        sql`${e}.name = ANY(${[eventA.name, eventB.name]}::text[])`,
        dateRange(startDate, endDate, ctx),
      ])}`;

    const groupKey = [group, ...breakdownColumns.map((_, index) => `b_${index}`)];
    const funnel = windowFunnelCtes({
      source: 'conversion_rows',
      partitionBy: groupKey,
      time: 'at_second',
      steps: ['step_1', 'step_2'],
      window: millisecondsInterval(funnelWindow * 3600 * 1000),
      strictIncrease: false,
      prefix: 'conversion',
    });
    const sameGroup = groupKey.map((column, index) =>
      index === 0
        ? raw(`_lv.${column} = _c.${column}`)
        : raw(`_lv.${column} IS NOT DISTINCT FROM _c.${column}`),
    );
    // Groups that reached step 1 (ClickHouse's `WHERE steps > 0`). A group
    // whose rows span two buckets gets the first; ClickHouse's any() was
    // undefined there.
    const keyColumns = join(groupKey.map((column) => raw(column)));
    const groups = sql`SELECT _c.*, _lv.level AS steps
      FROM (
        SELECT ${keyColumns}, min(bucket) AS bucket FROM conversion_rows GROUP BY ${keyColumns}
      ) AS _c
      JOIN ${raw(funnel.levels)} AS _lv ON ${join(sameGroup, ' AND ')}`;

    const breakdownKeys = breakdownColumns.map((b) => b.column);
    const converted = sql`count(*) FILTER (WHERE steps >= 2)`;
    const total = sql`count(DISTINCT ${raw(group)})`;
    const orderBy = breakdownColumns.map((b) =>
      b.text ? sql`${b.column} COLLATE "C"` : b.column,
    );
    const query = sql`WITH conversion_rows AS (${rows}),
        ${join(funnel.ctes.map((cte) => sql`${raw(cte.name)} AS (${cte.query})`))},
        conversion_groups AS (${groups})
      SELECT ${join([
        sql`${clix.formatBucket(raw('bucket'), interval)} AS event_day`,
        ...breakdownKeys,
        sql`${total} AS total_first`,
        sql`${converted} AS conversions`,
        // round(x, 2) on a ClickHouse Float64: x * 100 rounded half to even
        // and divided back; the same float8 steps give the same digits.
        sql`round(100.0::double precision * ${converted} / ${total} * 100) / 100 AS conversion_rate_percentage`,
      ])}
      FROM conversion_groups
      GROUP BY ${join([raw('bucket'), ...breakdownKeys])}
      ORDER BY ${join([raw('bucket'), ...orderBy])}`;

    const results = await anQuery<{
      event_day: string;
      total_first: number;
      conversions: number;
      conversion_rate_percentage: number;
      [key: string]: string | number;
    }>(query);
    return this.toSeries(results, breakdowns, limit).map(
      (serie, serieIndex) => {
        return {
          ...serie,
          data: serie.data.map((d, index) => ({
            ...d,
            timestamp: new Date(d.date).getTime(),
            serieIndex,
            index,
            serie: omit(['data'], serie),
          })),
        };
      },
    );
  }

  private toSeries(
    data: {
      event_day: string;
      total_first: number;
      conversions: number;
      conversion_rate_percentage: number;
      [key: string]: string | number;
    }[],
    breakdowns: { name: string }[] = [],
    limit: number | undefined = undefined,
  ) {
    if (!breakdowns.length) {
      return [
        {
          id: 'conversion',
          breakdowns: [],
          data: data.map((d) => ({
            date: d.event_day,
            total: d.total_first,
            conversions: d.conversions,
            rate: d.conversion_rate_percentage,
          })),
        },
      ];
    }

    // Group by breakdown values
    const series = data.reduce(
      (acc, d) => {
        if (limit && Object.keys(acc).length >= limit) {
          return acc;
        }

        const key =
          breakdowns.map((b, index) => d[`b_${index}`]).join('|') ||
          NOT_SET_VALUE;
        if (!acc[key]) {
          acc[key] = {
            id: key,
            breakdowns: breakdowns.map(
              (b, index) => (d[`b_${index}`] || NOT_SET_VALUE) as string,
            ),
            data: [],
          };
        }
        acc[key]!.data.push({
          date: d.event_day,
          total: d.total_first,
          conversions: d.conversions,
          rate: d.conversion_rate_percentage,
        });
        return acc;
      },
      {} as Record<
        string,
        {
          id: string;
          breakdowns: string[];
          data: {
            date: string;
            total: number;
            conversions: number;
            rate: number;
          }[];
        }
      >,
    );

    return Object.values(series).map((serie, serieIndex) => ({
      ...serie,
      data: serie.data.map((item, dataIndex) => ({
        ...item,
        dataIndex,
        serieIndex,
      })),
    }));
  }
}

export const conversionService = new ConversionService();
