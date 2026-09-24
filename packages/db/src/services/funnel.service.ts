import { ifNaN } from '@openpanel/common';
import type {
  IChartBreakdown,
  IChartEvent,
  IReportInput,
} from '@openpanel/validation';
import { last, reverse } from 'ramda';
import { fetchCohortsMetadata } from '../analytics/cohorts';
import {
  collectBreakdownCohortIds,
  extractCohortId,
  isAllCohortsBreakdown,
  isKnownEventField,
  resolveProfileField,
} from '../analytics/fields';
import {
  type EventFilterScope,
  eventFilterClauses,
  eventPropertyExpr,
} from '../analytics/filters';
import { clix } from '../analytics/query-builder';
import { type Sql, and, empty, join, or, raw, sql } from '../analytics/sql';
import {
  millisecondsInterval,
  windowFunnelCtes,
} from '../analytics/window-funnel';
import { EVENTS, dateRange, eventJoins } from './funnel-query';
import { mergeGlobalFilters, onlyReportEvents } from './reports.service';

/** Display label for null/empty breakdown values (e.g. property not set). */
export const EMPTY_BREAKDOWN_LABEL = 'Not set';

function normalizeBreakdownValue(value: unknown): string {
  if (value == null || value === '') {
    return EMPTY_BREAKDOWN_LABEL;
  }
  const s = String(value).trim();
  return s === '' ? EMPTY_BREAKDOWN_LABEL : s;
}

/**
 * Breakdowns the funnel can render: known event fields, minus the chart's
 * all-cohorts breakdown (bare `cohort`, which has no funnel equivalent) and
 * `profile.*` names that are neither a profile column nor a property —
 * ClickHouse failed on both; they are dropped, like unknown columns.
 */
function isFunnelBreakdown(name: string): boolean {
  if (!isKnownEventField(name) || isAllCohortsBreakdown(name)) {
    return false;
  }
  return !name.startsWith('profile.') || resolveProfileField(name) !== null;
}

export class FunnelService {
  // biome-ignore lint/complexity/noUselessConstructor: callers still pass the ClickHouse client
  constructor(_client?: unknown) {
    // Ignored: the queries run on the analytics pool of the current scope.
  }

  /**
   * Returns the grouping strategy for the funnel.
   * Determines whether windowFunnel is computed per session_id or profile_id.
   */
  getFunnelGroup(group?: string): 'profile_id' | 'session_id' {
    return group === 'profile_id' ? 'profile_id' : 'session_id';
  }

  /** Each step's condition on the events row: its name and its filters. */
  getFunnelConditions(events: IChartEvent[], scope: EventFilterScope): Sql[] {
    return events.map((event) =>
      and([
        sql`${raw(EVENTS)}.name = ${event.name}::text`,
        ...eventFilterClauses(event.filters ?? [], scope),
      ]),
    );
  }

  /**
   * The funnel CTEs, to register in order:
   *
   * - `funnel_rows`: one row per event (per group, with a group join) that
   *   matches at least one step — the other rows can't advance the funnel —
   *   with `step_<n>` flags, `created_at`, the group key, `profile_id` and
   *   the raw `b_<i>` breakdown values;
   * - `funnel_step_<n>` / `funnel_levels`: ClickHouse's
   *   `windowFunnel(window, 'strict_increase')` per group key (see
   *   analytics/window-funnel.ts);
   * - `session_funnel`: one row per group key with its level (0 when the
   *   first step never happened). With `group === 'session_id'` the
   *   session's `profile_id` is the one of its latest row (argMax), so a
   *   mid-session identify counts as the identified profile.
   *
   * Breakdowns are attributed to the value at the group's FIRST step-1 row
   * (argMinIf), not grouped by: grouping the sequence by a per-row value
   * splits a user's steps across buckets whenever the value isn't the same
   * on every step (e.g. an experiment tag set on the entry event only), and
   * the later steps then show 0. `group.*` breakdowns are the exception:
   * each event is fanned out per group, and a user in three groups belongs
   * in all three funnels, so they stay part of the group key.
   */
  buildFunnelCte({
    projectId,
    startDate,
    endDate,
    eventSeries,
    funnelWindowMilliseconds,
    timezone,
    group = 'session_id',
    joins = empty,
    scope,
    breakdownExpressions = [],
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    eventSeries: IChartEvent[];
    funnelWindowMilliseconds: number;
    timezone: string;
    group?: 'session_id' | 'profile_id';
    joins?: Sql;
    scope: EventFilterScope;
    breakdownExpressions?: { expression: Sql; perRow: boolean }[];
  }): { name: string; query: Sql }[] {
    const conditions = this.getFunnelConditions(eventSeries, scope);
    const steps = conditions.map((_, index) => `step_${index + 1}`);
    const breakdownColumns = breakdownExpressions.map((b, index) => ({
      ...b,
      column: `b_${index}`,
    }));
    const groupKey = [group, ...breakdownColumns.filter((b) => b.perRow).map((b) => b.column)];
    const names = [...new Set(eventSeries.map((event) => event.name))];
    const e = raw(EVENTS);

    const rowColumns: Sql[] = [
      sql`${e}.${raw(group)}`,
      ...(group === 'session_id' ? [sql`${e}.profile_id`] : []),
      sql`${e}.created_at`,
      ...conditions.map((condition, index) => sql`(${condition}) AS ${raw(steps[index]!)}`),
      ...breakdownColumns.map((b) => sql`${b.expression} AS ${raw(b.column)}`),
    ];
    const rows = sql`SELECT ${join(rowColumns)}
      FROM analytics.events AS ${e} ${joins}
      WHERE ${and([
        sql`${e}.project_id = ${projectId}`,
        dateRange(startDate, endDate, { timezone }),
        sql`${e}.name = ANY(${names}::text[])`,
        or(conditions),
      ])}`;

    // windowFunnel's 'strict_increase' mode requires every step's timestamp
    // to be strictly greater than the previous step's, so same-timestamp
    // sequences (server-side senders, batched SDKs, imported data with
    // coarse timestamps) never connect. Mixpanel/Amplitude count those as
    // ordered, so deployments migrating from them can opt into the default
    // (>=) mode; strict stays the default here.
    const nonStrictOrdering =
      process.env.FUNNEL_NON_STRICT_ORDERING === '1' ||
      process.env.FUNNEL_NON_STRICT_ORDERING === 'true';
    const funnel = windowFunnelCtes({
      source: 'funnel_rows',
      partitionBy: groupKey,
      time: 'created_at',
      steps,
      window: millisecondsInterval(funnelWindowMilliseconds),
      strictIncrease: !nonStrictOrdering,
      prefix: 'funnel',
    });

    const aggregates: Sql[] = [
      ...groupKey.map((column) => raw(column)),
      ...(group === 'session_id'
        ? [raw('(array_agg(profile_id ORDER BY created_at DESC))[1] AS profile_id')]
        : []),
      ...breakdownColumns
        .filter((b) => !b.perRow)
        .map((b) => raw(`(array_agg(${b.column} ORDER BY created_at) FILTER (WHERE step_1))[1] AS ${b.column}`)),
    ];
    // Group-breakdown values may be NULL; the group key column never is.
    const sameGroup = groupKey.map((column, index) =>
      index === 0
        ? raw(`_lv.${column} = _f.${column}`)
        : raw(`_lv.${column} IS NOT DISTINCT FROM _f.${column}`),
    );
    const funnelColumns: Sql[] = [
      raw(`_f.${group}`),
      raw('COALESCE(_lv.level, 0) AS level'),
      ...(group === 'session_id' ? [raw('_f.profile_id')] : []),
      ...breakdownColumns.map((b) => raw(`_f.${b.column}`)),
    ];
    const sessionFunnel = sql`SELECT ${join(funnelColumns)}
      FROM (
        SELECT ${join(aggregates)} FROM funnel_rows
        GROUP BY ${join(groupKey.map((column) => raw(column)))}
      ) AS _f
      LEFT JOIN ${raw(funnel.levels)} AS _lv ON ${join(sameGroup, ' AND ')}`;

    return [
      { name: 'funnel_rows', query: rows },
      ...funnel.ctes,
      { name: 'session_funnel', query: sessionFunnel },
    ];
  }

  buildSessionsCte({
    projectId,
    startDate,
    endDate,
    timezone,
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    timezone: string;
  }) {
    return clix(timezone)
      .select(['profile_id AS pid', 'id AS sid'])
      .from('analytics.sessions')
      .rawWhere(sql`project_id = ${projectId}::text`)
      .rawWhere(dateRange(startDate, endDate, { timezone }, raw('created_at')));
  }

  private fillFunnel(
    funnel: { level: number; count: number }[],
    steps: number,
  ) {
    const filled = Array.from({ length: steps }, (_, index) => {
      const level = index + 1;
      const matchingResult = funnel.find((res) => res.level === level);
      return {
        level,
        count: matchingResult ? matchingResult.count : 0,
      };
    });

    // Accumulate counts from top to bottom of the funnel
    for (let i = filled.length - 1; i >= 0; i--) {
      const step = filled[i];
      const prevStep = filled[i + 1];
      // If there's a previous step, add the count to the current step
      if (step && prevStep) {
        step.count += prevStep.count;
      }
    }
    return filled.reverse();
  }

  toSeries(
    funnel: { level: number; count: number; [key: string]: any }[],
    breakdowns: { name: string }[] = [],
    limit: number | undefined = undefined,
  ) {
    if (!breakdowns.length) {
      return [
        funnel.map((f) => ({
          level: f.level,
          count: f.count,
          id: 'none',
          breakdowns: [],
        })),
      ];
    }

    // Group by breakdown values (normalize empty/null to "Not set")
    const series = funnel.reduce(
      (acc, f) => {
        const key = breakdowns
          .map((b, index) => normalizeBreakdownValue(f[`b_${index}`]))
          .join('|');
        if (!acc[key]) {
          // The limit caps how many breakdown series we return, so it must only
          // reject NEW keys. Bailing out of the whole reduce here would drop the
          // remaining rows of series already accepted: the query is ordered by
          // level DESC, so those rows are the lower funnel steps, and losing them
          // leaves each series holding only its deepest level. fillFunnel then
          // accumulates that single row into every step, so every step reports an
          // identical count at 100%.
          if (limit && Object.keys(acc).length >= limit) {
            return acc;
          }
          acc[key] = [];
        }
        acc[key]!.push({
          id: key,
          breakdowns: breakdowns.map((b, index) =>
            normalizeBreakdownValue(f[`b_${index}`]),
          ),
          level: f.level,
          count: f.count,
        });
        return acc;
      },
      {} as Record<
        string,
        {
          id: string;
          breakdowns: string[];
          level: number;
          count: number;
        }[]
      >,
    );

    return Object.values(series);
  }

  getProfileFilters(events: IChartEvent[]) {
    return events.flatMap((e) =>
      e.filters
        ?.filter((f) => f.name.startsWith('profile.'))
        .map((f) => f.name.replace('profile.', '')),
    );
  }

  /**
   * Builds everything the funnel chart and the funnel profile list share: the
   * normalized event series and breakdowns, and a query with the funnel CTEs
   * (joins wired up for the filters and breakdowns) registered on it. Callers
   * add their own `funnel` CTE and final projection on top, e.g.
   *
   *   query.with('funnel', 'SELECT * FROM session_funnel WHERE level != 0');
   *   query.select(['DISTINCT profile_id']).from('funnel');
   *   query.rawWhere(sql`level >= ${targetLevel}`);
   *
   * `session_funnel` — one row per group key — has these columns:
   * - `session_id` (the default grouping) or `profile_id` (funnelGroup
   *   'profile_id'): the group key;
   * - `level` (integer): the deepest step reached, 0 when the group has
   *   rows for later steps only (callers filter `level != 0`);
   * - `profile_id` (text): with session grouping, the profile of the
   *   session's latest step row; with profile grouping it is the key;
   * - `b_0` … `b_<n-1>`: one per returned `breakdowns` entry, in order —
   *   the value at the group's first step-1 row, or per row (and part of the
   *   key) for `group.*` breakdowns. Text for property, profile, group,
   *   cohort and has_profile breakdowns (a wildcard property is `text[]`),
   *   the column's own type for plain event columns; '' or NULL when unset
   *   (both shown as EMPTY_BREAKDOWN_LABEL).
   *
   * This exists because the two used to be written out twice and drifted: a
   * breakdown expression only works if the join it reads was added, and the
   * joins depend on the breakdowns.
   */
  async buildFunnelBase({
    projectId,
    startDate,
    endDate,
    series,
    globalFilters,
    breakdowns: initialBreakdowns = [],
    funnelWindow = 24,
    funnelGroup,
    timezone,
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    series: IReportInput['series'];
    globalFilters?: IReportInput['globalFilters'];
    breakdowns?: IChartBreakdown[];
    funnelWindow?: number;
    funnelGroup?: string;
    timezone: string;
  }) {
    const breakdowns = initialBreakdowns.filter((b) => isFunnelBreakdown(b.name));

    const eventSeries = onlyReportEvents(
      mergeGlobalFilters(series, globalFilters),
    );

    if (eventSeries.length === 0) {
      throw new Error('events are required');
    }

    const funnelWindowMilliseconds = funnelWindow * 3600 * 1000;
    const group = this.getFunnelGroup(funnelGroup);
    const filters = eventSeries.flatMap((e) => e.filters ?? []);
    const needsGroupJoin =
      funnelGroup === 'group' ||
      filters.some((f) => f.name.startsWith('group.')) ||
      breakdowns.some((b) => b.name.startsWith('group.'));

    const cohortMetadata = await fetchCohortsMetadata(
      collectBreakdownCohortIds(breakdowns),
    );
    const { joins, scope } = eventJoins({
      projectId,
      timezone,
      filters,
      breakdowns,
      groups: needsGroupJoin,
    });
    const breakdownExpressions = breakdowns.map((b) => {
      const cohortId = extractCohortId(b.name);
      const cohort = cohortId
        ? { id: cohortId, name: cohortMetadata.get(cohortId)?.name }
        : undefined;
      return {
        expression: eventPropertyExpr(b.name, scope, cohort),
        perRow: b.name.startsWith('group.'),
      };
    });

    const query = clix(timezone);
    for (const cte of this.buildFunnelCte({
      projectId,
      startDate,
      endDate,
      eventSeries,
      funnelWindowMilliseconds,
      timezone,
      group,
      joins,
      scope,
      breakdownExpressions,
    })) {
      query.with(cte.name, cte.query);
    }

    return { query, eventSeries, breakdowns, group };
  }

  async getFunnel({
    projectId,
    startDate,
    endDate,
    series,
    globalFilters,
    options,
    breakdowns: initialBreakdowns = [],
    limit,
    timezone = 'UTC',
  }: IReportInput & { timezone: string; events?: IChartEvent[] }) {
    if (!startDate || !endDate) {
      throw new Error('startDate and endDate are required');
    }

    const funnelOptions = options?.type === 'funnel' ? options : undefined;

    const {
      query: funnelQuery,
      eventSeries,
      breakdowns,
    } = await this.buildFunnelBase({
      projectId,
      startDate,
      endDate,
      series,
      globalFilters,
      breakdowns: initialBreakdowns,
      funnelWindow: funnelOptions?.funnelWindow,
      funnelGroup: funnelOptions?.funnelGroup,
      timezone,
    });

    // windowFunnel is computed per the primary key (profile_id or session_id),
    // so we just filter out level=0 rows — no re-aggregation needed.
    funnelQuery.with(
      'funnel',
      'SELECT * FROM session_funnel WHERE level != 0',
    );

    funnelQuery
      .select<{
        level: number;
        count: number;
        [key: string]: any;
      }>([
        'level',
        ...breakdowns.map((b, index) => `b_${index}`),
        'count(*) AS count',
      ])
      .from('funnel')
      .groupBy(['level', ...breakdowns.map((b, index) => `b_${index}`)])
      .orderBy('level', 'DESC');

    const funnelData = await funnelQuery.execute();
    const funnelSeries = this.toSeries(funnelData, breakdowns, limit);

    return funnelSeries
      .map((data) => {
        const maxLevel = eventSeries.length;
        const filledFunnelRes = this.fillFunnel(
          data.map((d) => ({ level: d.level, count: d.count })),
          maxLevel,
        );

        const totalSessions = last(filledFunnelRes)?.count ?? 0;
        const steps = reverse(filledFunnelRes)
          .reduce(
            (acc, item, index, list) => {
              const prev = list[index - 1] ?? { count: totalSessions };
              const next = list[index + 1];
              const event = eventSeries[item.level - 1]!;
              return [
                ...acc,
                {
                  event: {
                    ...event,
                    displayName: event.displayName || event.name,
                  },
                  count: item.count,
                  percent: (item.count / totalSessions) * 100,
                  dropoffCount: next ? item.count - next.count : null,
                  dropoffPercent: next
                    ? ((item.count - next.count) / item.count) * 100
                    : null,
                  previousCount: prev.count,
                  nextCount: next?.count ?? null,
                },
              ];
            },
            [] as {
              event: IChartEvent & { displayName: string };
              count: number;
              percent: number;
              dropoffCount: number | null;
              dropoffPercent: number | null;
              previousCount: number;
              nextCount: number | null;
            }[],
          )
          .map((step, index, list) => {
            return {
              ...step,
              percent: ifNaN(step.percent, 0),
              dropoffPercent: ifNaN(step.dropoffPercent, 0),
              isHighestDropoff: (() => {
                // Skip if current step has no dropoff
                if (!step?.dropoffCount) return false;

                // Get maximum dropoff count, excluding 0s
                const maxDropoff = Math.max(
                  ...list
                    .map((s) => s.dropoffCount || 0)
                    .filter((count) => count > 0),
                );

                // Check if this is the first step with the highest dropoff
                return (
                  step.dropoffCount === maxDropoff &&
                  list.findIndex((s) => s.dropoffCount === maxDropoff) === index
                );
              })(),
            };
          });

        return {
          id: data[0]?.id ?? 'none',
          breakdowns: data[0]?.breakdowns ?? [],
          steps,
          totalSessions,
          lastStep: last(steps)!,
          mostDropoffsStep: steps.find((step) => step.isHighestDropoff)!,
        };
      })
      .sort((a, b) => {
        const aTotal = a.steps.reduce((acc, step) => acc + step.count, 0);
        const bTotal = b.steps.reduce((acc, step) => acc + step.count, 0);
        return bTotal - aTotal;
      });
  }
}

export const funnelService = new FunnelService();

import { getSettingsForProject } from './organization.service';

export async function getFunnelCore(input: {
  projectId: string;
  startDate: string;
  endDate: string;
  steps: string[];
  windowHours?: number;
  groupBy?: 'session_id' | 'profile_id';
}) {
  const { timezone } = await getSettingsForProject(input.projectId);
  const eventSeries = input.steps.map((name, index) => ({
    id: String(index + 1),
    type: 'event' as const,
    name,
    displayName: name,
    segment: 'user' as const,
    filters: [],
  }));

  const result = await funnelService.getFunnel({
    projectId: input.projectId,
    startDate: input.startDate,
    endDate: input.endDate,
    series: eventSeries,
    breakdowns: [],
    chartType: 'funnel',
    interval: 'day',
    range: 'custom',
    previous: false,
    metric: 'sum',
    options: {
      type: 'funnel',
      funnelWindow: input.windowHours ?? 24,
      funnelGroup: input.groupBy ?? 'session_id',
    },
    timezone,
  });

  const primarySeries = result[0];
  if (!primarySeries) {
    return {
      steps: [],
      totalUsers: 0,
      completedUsers: 0,
      overallConversionRate: 0,
    };
  }

  const steps = primarySeries.steps.map((step, index) => ({
    step: index + 1,
    eventName: step.event.displayName || step.event.name,
    users: step.count,
    conversionRateFromStart: Math.round(step.percent * 100) / 100,
    dropoffPercent:
      step.dropoffPercent != null
        ? Math.round(step.dropoffPercent * 100) / 100
        : null,
    isHighestDropoff: step.isHighestDropoff,
  }));

  const totalUsers = steps[0]?.users ?? 0;
  const completedUsers = steps[steps.length - 1]?.users ?? 0;

  return {
    steps,
    totalUsers,
    completedUsers,
    overallConversionRate:
      totalUsers > 0
        ? Math.round((completedUsers / totalUsers) * 10000) / 100
        : 0,
  };
}
