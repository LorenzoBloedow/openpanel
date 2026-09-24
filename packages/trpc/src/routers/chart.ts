import {
  AggregateChartEngine,
  ChartEngine,
  conversionService,
  EMPTY_BREAKDOWN_LABEL,
  funnelService,
  getChartPrevStartEndDate,
  getChartStartEndDate,
  getEventMetasCached,
  getProfilePropertyKeysCached,
  getProfilesCached,
  getReportById,
  getRetentionCohort,
  getSettingsForProject,
  mergeGlobalFilters,
  onlyReportEvents,
  sankeyService,
  type IServiceProfile,
  validateShareAccess,
} from '@openpanel/db';
import { anQuery } from '@openpanel/db/src/analytics/client';
import {
  isKnownEventField,
  normalizeEventField,
} from '@openpanel/db/src/analytics/fields';
import { gapFill } from '@openpanel/db/src/analytics/fill';
import {
  type EventFilterScope,
  GROUP_JOIN,
  eventFilterClauses,
  eventPropertyExpr,
  groupColumnExpr,
  groupJoin,
  profileColumnExpr,
  profileJoin,
} from '@openpanel/db/src/analytics/filters';
import { type Query, clix } from '@openpanel/db/src/analytics/query-builder';
import { recentPropertyValues } from '@openpanel/db/src/analytics/property-values';
import { type Sql, empty, raw, sql } from '@openpanel/db/src/analytics/sql';
import { startOf } from '@openpanel/db/src/analytics/time';
import {
  type IChartEvent,
  type IInterval,
  zChartEventFilter,
  zChartSeries,
  zCriteria,
  zRange,
  zReportInput,
  zTimeInterval,
} from '@openpanel/validation';
import { flatten, map, pipe, prop, sort, uniq } from 'ramda';
import { z } from 'zod';
import { getProjectAccess } from '../access';
import {
  createdSince,
  instant,
  secondsNow,
  zonedMinus,
  zonedWallClock,
} from '../analytics-time';
import { TRPCAccessError, TRPCForbiddenError } from '../errors';
import {
  cacheMiddleware,
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from '../trpc';

const cacher = cacheMiddleware(60);

/**
 * `chart.values` for a top-level event column (country, os, city, device…) has
 * no MV, so it ran `SELECT DISTINCT <col> FROM events WHERE created_at >
 * now() - 6 MONTH` — a full multi-billion-row scan on high-volume projects that
 * hits max_execution_time and returns nothing, then a dashboard tab left open
 * on such a filter re-fires it on every window focus (React Query staleTime=0).
 *
 * These columns are session-level (geo/device/referrer denormalised onto every
 * event), so for an all-events (`*`) value dropdown we read the distinct set
 * from the far smaller `sessions` table (one row per session) instead — same
 * values, orders of magnitude fewer rows. `path`/`origin` are per-pageview (not
 * on `sessions`) and keep using `events`. A specific-event query also stays on
 * `events` since `sessions` has no `name` column (the name filter bounds it).
 */
const SESSION_LEVEL_VALUE_COLUMNS = new Set([
  'country',
  'region',
  'city',
  'os',
  'os_version',
  'browser',
  'browser_version',
  'device',
  'brand',
  'model',
  'referrer',
  'referrer_name',
  'referrer_type',
]);

/**
 * Lookback of the filter-value dropdown for event columns and properties. A
 * value picker only needs recently-seen values, so clamp the scan (default
 * 30d) instead of the old 6-month full scan. Env-tunable.
 */
const VALUES_LOOKBACK_DAYS = Number.parseInt(
  process.env.CHART_VALUES_LOOKBACK_DAYS || '30',
  10,
);

/**
 * Event property values are read from the most recent events that carry the
 * key (there is no values rollup), at most this many of them, so a busy
 * project's picker stays a bounded index scan.
 */
const PROPERTY_VALUES_SCAN_LIMIT = 100_000;

/** Distinct values a profile/group/column dropdown returns at most. */
const DISTINCT_VALUES_LIMIT = 100_000;

const DAY_MS = 86_400_000;

/**
 * The instants of the chart bucket a data point's `date` stands for. The
 * ClickHouse query compared `toStartOf<interval>(created_at)` with the date
 * without a session time zone, so buckets are UTC: day/week/month buckets by
 * the date's day, weeks starting on Sunday (toStartOfWeek's mode 0), and
 * hour/minute buckets only when the date is exactly on one. Null when no
 * bucket can match.
 */
function utcBucket(
  date: Date,
  interval: IInterval,
): { start: Date; end: Date } | null {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const midnight = new Date(Date.UTC(year, month, day));
  switch (interval) {
    case 'minute': {
      if (date.getUTCSeconds() !== 0) {
        return null;
      }
      const start = Date.UTC(year, month, day, date.getUTCHours(), date.getUTCMinutes());
      return { start: new Date(start), end: new Date(start + 60_000) };
    }
    case 'hour': {
      if (date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0) {
        return null;
      }
      const start = Date.UTC(year, month, day, date.getUTCHours());
      return { start: new Date(start), end: new Date(start + 3_600_000) };
    }
    case 'day':
      return { start: midnight, end: new Date(Date.UTC(year, month, day + 1)) };
    case 'week':
      if (date.getUTCDay() !== 0) {
        return null;
      }
      return { start: midnight, end: new Date(Date.UTC(year, month, day + 7)) };
    case 'month':
      if (day !== 1) {
        return null;
      }
      return { start: midnight, end: new Date(Date.UTC(year, month + 1, 1)) };
    default:
      return null;
  }
}

/**
 * Cap on distinct event property keys returned to the picker. Projects in the
 * 8k range exist, so the previous 10k was reachable in normal use.
 */
const EVENT_PROPERTY_KEY_LIMIT = 50_000;

/**
 * Cap on distinct values returned per event property to the filter
 * autocomplete. High-cardinality keys (ids, urls, session tokens) can hold
 * millions of distinct values — returning them all is useless for a picker
 * and heavy for ClickHouse and the browser alike. Most recent values win.
 * Env-tunable via EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT (positive
 * integer; invalid values keep the default).
 */
const EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT_RAW =
  process.env.EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT;
const EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT_PARSED =
  EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT_RAW &&
  /^\d+$/.test(EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT_RAW)
    ? Number(EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT_RAW)
    : Number.NaN;
const EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT =
  Number.isSafeInteger(EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT_PARSED) &&
  EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT_PARSED > 0
    ? EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT_PARSED
    : 500;

/**
 * Distinct non-empty values of a profiles/groups expression, most recently
 * created rows first.
 */
function distinctValues(
  expression: Sql,
  table: 'profiles' | 'groups',
  projectId: string,
): Sql {
  return sql`
    SELECT ${expression} AS values
    FROM ${raw(`analytics.${table}`)}
    WHERE project_id = ${projectId}
      AND (${expression})::text <> ''
    GROUP BY 1
    ORDER BY max(created_at) DESC
    LIMIT ${DISTINCT_VALUES_LIMIT}
  `;
}

const chartProcedure = publicProcedure.use(
  async ({ ctx, next, getRawInput }) => {
    const rawInput = (await getRawInput()) as {
      projectId: string;
      shareId?: string;
      id?: string;
    };

    if (rawInput.shareId) {
      // Require reportId when shareId provided
      if (!rawInput.id) {
        throw new Error('reportId required with shareId');
      }

      // Validate share access
      const shareValidation = await validateShareAccess(
        rawInput.shareId,
        rawInput.id,
        {
          cookies: ctx.cookies,
          session: ctx.session?.userId
            ? { userId: ctx.session.userId }
            : undefined,
        }
      );
      if (!shareValidation.isValid) {
        throw new TRPCForbiddenError('You do not have access to this share');
      }

      // Fetch report
      const report = await getReportById(rawInput.id);
      if (!report) {
        throw new TRPCAccessError('Report not found');
      }

      return next({
        ctx: {
          report,
        },
      });
    }

    // Regular member access check
    if (!ctx.session?.userId) {
      throw new TRPCAccessError('Authentication required');
    }
    const access = await getProjectAccess({
      projectId: rawInput.projectId,
      userId: ctx.session.userId,
    });
    if (!access) {
      throw new TRPCForbiddenError('You do not have access to this project');
    }

    return next({
      ctx: {
        report: null,
      },
    });
  }
);

export const chartRouter = createTRPCRouter({
  projectCard: protectedProcedure
    .use(cacheMiddleware(60 * 5))
    .input(
      z.object({
        projectId: z.string(),
      })
    )
    .query(async ({ input: { projectId } }) => {
      const { timezone } = await getSettingsForProject(projectId);
      const now = secondsNow();
      const monthsAgo = (months: number) => zonedMinus(now, timezone, { months });
      const daysAgo = (days: number) => zonedMinus(now, timezone, { days });

      // Profiles and revenue per project day over the last 3 months.
      const chartPromise = anQuery<{
        value: number;
        date: string;
        revenue: number;
      }>(sql`
        SELECT
          COUNT(DISTINCT s.profile_id) AS value,
          to_char(s.day, 'YYYY-MM-DD HH24:MI:SS') AS date,
          COALESCE(sum(s.revenue), 0) AS revenue
        FROM (
          SELECT ${startOf(raw('created_at'), 'day', { timezone })} AS day, profile_id, revenue
          FROM analytics.sessions
          WHERE project_id = ${projectId}
            AND ${createdSince(monthsAgo(3))}
        ) AS s
        GROUP BY s.day
        ORDER BY s.day
      `).then((rows) =>
        // WITH FILL FROM toStartOfDay(now() - 3 months) TO toStartOfDay(now())
        gapFill(rows, {
          key: 'date',
          from: zonedWallClock(monthsAgo(3), timezone),
          to: zonedWallClock(now, timezone).slice(0, 10),
          unit: 'day',
          fill: (date) => ({ date, value: 0, revenue: 0 }),
        }),
      );

      const metricsPromise = anQuery<{
        months_3: number;
        months_3_prev: number;
        month: number;
        day: number;
        day_prev: number;
        revenue: number;
      }>(sql`
        SELECT
          COUNT(DISTINCT profile_id) FILTER (WHERE created_at >= ${instant(monthsAgo(3))}) AS months_3,
          COUNT(DISTINCT profile_id) FILTER (WHERE created_at >= ${instant(monthsAgo(6))} AND created_at < ${instant(monthsAgo(3))}) AS months_3_prev,
          COUNT(DISTINCT profile_id) FILTER (WHERE created_at >= ${instant(monthsAgo(1))}) AS month,
          COUNT(DISTINCT profile_id) FILTER (WHERE created_at >= ${instant(daysAgo(1))}) AS day,
          COUNT(DISTINCT profile_id) FILTER (WHERE created_at >= ${instant(daysAgo(2))} AND created_at < ${instant(daysAgo(1))}) AS day_prev,
          COALESCE(sum(revenue), 0) AS revenue
        FROM analytics.sessions
        WHERE project_id = ${projectId}
          AND ${createdSince(monthsAgo(6))}
      `);

      const [chart, [metrics]] = await Promise.all([
        chartPromise,
        metricsPromise,
      ]);

      const change =
        metrics && metrics.months_3_prev > 0 && metrics.months_3 > 0
          ? Math.round(
              ((metrics.months_3 - metrics.months_3_prev) /
                metrics.months_3_prev) *
                100
            )
          : null;

      const trend =
        change === null
          ? { direction: 'neutral' as const, percentage: null as number | null }
          : change > 0
            ? { direction: 'up' as const, percentage: change }
            : change < 0
              ? { direction: 'down' as const, percentage: Math.abs(change) }
              : { direction: 'neutral' as const, percentage: 0 };

      return {
        chart: chart.map((d) => ({ ...d, date: new Date(d.date) })),
        metrics,
        trend,
      };
    }),

  events: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
      })
    )
    .query(async ({ input: { projectId } }) => {
      const [events, meta] = await Promise.all([
        // `count` counts rollup rows per name, as count(name) over
        // distinct_event_names_mv did — not events.
        anQuery<{ name: string; count: number }>(sql`
          SELECT name, count(*) AS count
          FROM analytics.event_names
          WHERE project_id = ${projectId}
          GROUP BY name
          ORDER BY count DESC, name COLLATE "C" ASC
        `),
        getEventMetasCached(projectId),
      ]);

      return [
        {
          name: '*',
          count: events.reduce((acc, event) => acc + event.count, 0),
          meta: undefined,
        },
        ...events.map((event) => ({
          name: event.name,
          count: event.count,
          meta: meta.find((m) => m.name === event.name),
        })),
      ];
    }),

  properties: protectedProcedure
    // Aggregating every profile's property keys costs more than the old
    // 10k-row sample. It's still sub-second on millions of profiles, and this
    // list barely moves, so a short cache absorbs it.
    .use(cacheMiddleware(60))
    .input(
      z.object({
        event: z.string().optional(),
        projectId: z.string(),
      })
    )
    .query(async ({ input: { projectId, event } }) => {
      const profileProperties = (
        await getProfilePropertyKeysCached(projectId)
      ).map((key) => `profile.properties.${key}`);

      // Order by recency, not by key length. The cap has to drop *something*
      // on projects with very many distinct keys, and dropping the longest
      // keys first meant losing the most descriptive ones. `property_key`
      // breaks ties so the cap can't cut an arbitrary side of a tied group —
      // an unstable list is the bug this whole change is about.
      const res = await anQuery<{ property_key: string; created_at: string }>(sql`
        SELECT property_key, max(last_seen_at) AS created_at
        FROM analytics.event_property_keys
        WHERE project_id = ${projectId}
          ${event && event !== '*' ? sql`AND name = ${event}::text` : empty}
        GROUP BY property_key
        ORDER BY created_at DESC, property_key COLLATE "C" ASC
        LIMIT ${EVENT_PROPERTY_KEY_LIMIT}
      `);

      const eventProperties = res.map((item) => {
        const key = item.property_key
          .replace(/\.([0-9]+)\./g, '.*.')
          .replace(/\.([0-9]+)/g, '[*]');
        return `properties.${key}`;
      });

      const fixedProperties = [
        'revenue',
        'has_profile',
        'path',
        'origin',
        'referrer',
        'referrer_name',
        'created_at',
        'country',
        'city',
        'region',
        'os',
        'os_version',
        'browser',
        'browser_version',
        'device',
        'brand',
        'model',
        'profile.id',
        'profile.first_name',
        'profile.last_name',
        'profile.email',
        'profile.created_at',
        'profile.last_seen_at',
      ];

      const properties = [
        ...eventProperties,
        ...(event === '*' || !event ? ['name'] : []),
        ...fixedProperties,
        ...profileProperties,
      ];

      return pipe(
        sort<string>((a, b) => a.length - b.length),
        uniq
      )(properties);
    }),

  values: protectedProcedure
    .input(
      z.object({
        event: z.string(),
        property: z.string(),
        projectId: z.string(),
      })
    )
    .query(async ({ input: { event, property, projectId } }) => {
      if (property === 'has_profile') {
        return {
          values: ['true', 'false'],
        };
      }

      const values: string[] = [];

      if (property.startsWith('properties.')) {
        // Most recently seen first, the value breaking ties for a stable
        // list under the cap — same rationale as the key picker above.
        const res = await recentPropertyValues({
          projectId,
          eventName: event && event !== '*' ? event : undefined,
          key: property.replace(/^properties\./, ''),
          since: new Date(Date.now() - VALUES_LOOKBACK_DAYS * DAY_MS),
          scanLimit: PROPERTY_VALUES_SCAN_LIMIT,
          limit: EVENT_PROPERTY_VALUE_AUTOCOMPLETE_LIMIT,
        });

        values.push(...res);
      } else if (property.startsWith('profile.')) {
        const res = await anQuery<{ values: string }>(
          distinctValues(profileColumnExpr(property), 'profiles', projectId),
        );
        values.push(...res.map((r) => String(r.values)).filter(Boolean));
      } else if (property.startsWith('group.')) {
        const res = await anQuery<{ values: string }>(
          distinctValues(groupColumnExpr(property), 'groups', projectId),
        );
        values.push(...res.map((r) => String(r.values)).filter(Boolean));
      } else if (property === 'cohort' || property.startsWith('cohort:')) {
        // Cohort filters use a dedicated cohort multi-select on the client
        // (ComboboxAdvanced over all cohorts) — values aren't sourced from
        // an event-column distinct query. Without this guard, the events
        // SELECT would emit a literal `cohort:<uuid>` identifier and crash
        // with a ClickHouse syntax error.
        return { values: [] };
      } else {
        // Normalize bare utm_* names to `properties.__query.utm_*` and rewrite
        // camelCase aliases (`referrerName`) to their snake_case columns.
        // Unknown identifiers (saved-report typos like `temple_name`, or
        // misnamed columns from older clients) get an empty value list rather
        // than crashing the autocomplete query with UNKNOWN_IDENTIFIER.
        const resolvedProperty = normalizeEventField(property);
        if (!isKnownEventField(resolvedProperty)) {
          return { values: [] };
        }
        // Session-level columns (geo/device/referrer) come from the small
        // `sessions` table, not a billions-row `events` scan. Only for
        // all-events (`*`): `sessions` has no `name` column to filter on.
        const useSessions =
          event === '*' && SESSION_LEVEL_VALUE_COLUMNS.has(resolvedProperty);
        const table = useSessions ? 'sessions' : 'events';
        const expression = eventPropertyExpr(resolvedProperty, {
          projectId,
          timezone: 'UTC',
          table,
        });
        const events = await anQuery<{ values: string }>(sql`
          SELECT ${expression} AS values
          FROM ${raw(`analytics.${table}`)}
          WHERE project_id = ${projectId}
            AND created_at > ${instant(new Date(Date.now() - VALUES_LOOKBACK_DAYS * DAY_MS))}
            ${useSessions || event === '*' ? empty : sql`AND name = ${event}::text`}
          GROUP BY 1
          ORDER BY max(created_at) DESC
          LIMIT ${DISTINCT_VALUES_LIMIT}
        `);

        values.push(
          ...pipe(
            (data: typeof events) => map(prop('values'), data),
            flatten,
            uniq,
            sort((a, b) => a.length - b.length)
          )(events)
        );
      }

      return {
        values,
      };
    }),

  funnel: chartProcedure
    .use(cacher)
    .input(
      zReportInput.and(
        z.object({
          shareId: z.string().optional(),
          id: z.string().optional(),
        })
      )
    )
    .query(async ({ input, ctx }) => {
      const chartInput = ctx.report
        ? {
            ...ctx.report,
            range: input.range ?? ctx.report.range,
            startDate: input.startDate ?? ctx.report.startDate,
            endDate: input.endDate ?? ctx.report.endDate,
            interval: input.interval ?? ctx.report.interval,
          }
        : input;

      const { timezone } = await getSettingsForProject(chartInput.projectId);
      const currentPeriod = getChartStartEndDate(chartInput, timezone);
      const previousPeriod = getChartPrevStartEndDate(currentPeriod);

      const [current, previous] = await Promise.all([
        funnelService.getFunnel({ ...chartInput, ...currentPeriod, timezone }),
        chartInput.previous
          ? funnelService.getFunnel({
              ...chartInput,
              ...previousPeriod,
              timezone,
            })
          : Promise.resolve(null),
      ]);

      return {
        current,
        previous,
      };
    }),

  conversion: chartProcedure
    .use(cacher)
    .input(
      zReportInput.and(
        z.object({
          shareId: z.string().optional(),
          id: z.string().optional(),
        })
      )
    )
    .query(async ({ input, ctx }) => {
      const chartInput = ctx.report
        ? {
            ...ctx.report,
            range: input.range ?? ctx.report.range,
            startDate: input.startDate ?? ctx.report.startDate,
            endDate: input.endDate ?? ctx.report.endDate,
            interval: input.interval ?? ctx.report.interval,
          }
        : input;

      const { timezone } = await getSettingsForProject(chartInput.projectId);
      const currentPeriod = getChartStartEndDate(chartInput, timezone);
      const previousPeriod = getChartPrevStartEndDate(currentPeriod);

      const interval = chartInput.interval;

      const [current, previous] = await Promise.all([
        conversionService.getConversion({
          ...chartInput,
          ...currentPeriod,
          interval,
          timezone,
        }),
        chartInput.previous
          ? conversionService.getConversion({
              ...chartInput,
              ...previousPeriod,
              interval,
              timezone,
            })
          : Promise.resolve(null),
      ]);

      return {
        current: current.map((serie, sIndex) => ({
          ...serie,
          data: serie.data.map((d, dIndex) => ({
            ...d,
            previousRate: previous?.[sIndex]?.data?.[dIndex]?.rate,
          })),
        })),
        previous,
      };
    }),

  sankey: protectedProcedure.input(zReportInput).query(async ({ input }) => {
    const { timezone } = await getSettingsForProject(input.projectId);
    const currentPeriod = getChartStartEndDate(input, timezone);

    // Extract sankey options
    const options = input.options;

    if (!options || options.type !== 'sankey') {
      throw new Error('Sankey options are required');
    }

    // Extract start/end events from series based on mode
    const eventSeries = onlyReportEvents(
      mergeGlobalFilters(input.series, input.globalFilters),
    );

    if (!eventSeries[0]) {
      throw new Error('Start and end events are required');
    }

    return sankeyService.getSankey({
      projectId: input.projectId,
      startDate: currentPeriod.startDate,
      endDate: currentPeriod.endDate,
      steps: options.steps,
      mode: options.mode,
      startEvent: eventSeries[0],
      endEvent: eventSeries[1],
      exclude: options.exclude || [],
      include: options.include,
      timezone,
    });
  }),

  chart: chartProcedure
    .use(cacher)
    .input(
      zReportInput.and(
        z.object({
          shareId: z.string().optional(),
          id: z.string().optional(),
        })
      )
    )
    .query(({ input, ctx }) => {
      const chartInput = ctx.report
        ? {
            ...ctx.report,
            range: input.range ?? ctx.report.range,
            startDate: input.startDate ?? ctx.report.startDate,
            endDate: input.endDate ?? ctx.report.endDate,
            interval: input.interval ?? ctx.report.interval,
          }
        : input;

      return ChartEngine.execute(chartInput);
    }),

  aggregate: chartProcedure
    .use(cacher)
    .input(
      zReportInput.and(
        z.object({
          shareId: z.string().optional(),
          id: z.string().optional(),
        })
      )
    )
    .query(({ input, ctx }) => {
      const chartInput = ctx.report
        ? {
            ...ctx.report,
            range: input.range ?? ctx.report.range,
            startDate: input.startDate ?? ctx.report.startDate,
            endDate: input.endDate ?? ctx.report.endDate,
            interval: input.interval ?? ctx.report.interval,
          }
        : input;

      return AggregateChartEngine.execute(chartInput);
    }),

  cohort: chartProcedure
    .use(cacher)
    .input(
      z.object({
        projectId: z.string(),
        firstEvent: z.array(z.string()).min(1),
        secondEvent: z.array(z.string()).min(1),
        criteria: zCriteria.default('on_or_after'),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        interval: zTimeInterval.default('day'),
        range: zRange,
        filters: z.array(zChartEventFilter).optional(),
        shareId: z.string().optional(),
        id: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const projectId = ctx.report?.projectId ?? input.projectId;
      let firstEvent = input.firstEvent;
      let secondEvent = input.secondEvent;
      let criteria = input.criteria;
      // Property/cohort filters scoping the retention audience. These live
      // alongside the event-name selector (filters[0]) on each retention
      // series; everything except that name selector is an audience filter.
      let filters = input.filters ?? [];
      const dateRange = ctx.report
        ? (input.range ?? ctx.report.range)
        : input.range;
      const startDate = ctx.report
        ? (input.startDate ?? ctx.report.startDate)
        : input.startDate;
      const endDate = ctx.report
        ? (input.endDate ?? ctx.report.endDate)
        : input.endDate;
      const interval = ctx.report
        ? (input.interval ?? ctx.report.interval)
        : input.interval;

      // Extract events from report series if shared
      if (ctx.report) {
        const retentionOptions =
          ctx.report.options?.type === 'retention'
            ? ctx.report.options
            : undefined;
        criteria = retentionOptions?.criteria ?? criteria;

        const eventSeries = onlyReportEvents(ctx.report.series);
        const extractedFirstEvent = (
          eventSeries[0]?.filters?.[0]?.value ?? []
        ).map(String);
        const extractedSecondEvent = (
          eventSeries[1]?.filters?.[0]?.value ?? []
        ).map(String);

        if (
          extractedFirstEvent.length === 0 ||
          extractedSecondEvent.length === 0
        ) {
          throw new Error('Report must have at least 2 event series');
        }

        firstEvent = extractedFirstEvent;
        secondEvent = extractedSecondEvent;
        filters = [
          ...(ctx.report.globalFilters ?? []),
          ...eventSeries.flatMap((serie) =>
            (serie.filters ?? []).filter((filter) => filter.name !== 'name')
          ),
        ];
      }

      const { timezone } = await getSettingsForProject(projectId);
      const dates = getChartStartEndDate(
        {
          range: dateRange,
          startDate,
          endDate,
        },
        timezone
      );

      return getRetentionCohort({
        projectId,
        firstEvent,
        secondEvent,
        criteria,
        interval,
        startDate: dates.startDate,
        endDate: dates.endDate,
        filters,
      });
    }),

  getProfiles: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        date: z.string().describe('The date for the data point (ISO string)'),
        interval: zTimeInterval.default('day'),
        series: zChartSeries,
        breakdowns: z.record(z.string(), z.string()).optional(),
      })
    )
    .query(async ({ input }) => {
      const { projectId, date, series } = input;
      const serie = series[0];

      if (!serie) {
        throw new Error('Series not found');
      }

      if (serie.type !== 'event') {
        throw new Error('Series must be an event');
      }

      // The instants of the interval bucket the data point stands for
      const bucket = utcBucket(new Date(date), input.interval);
      if (!bucket) {
        return [];
      }

      // Joins as the chart's: the profile when a filter or breakdown reads
      // it, one row per group when one reads a group (distinct profiles, so
      // the fan-out doesn't matter). The query ran without a session time
      // zone, so date filters are UTC.
      const names = [
        ...serie.filters.map((filter) => filter.name),
        ...Object.keys(input.breakdowns ?? {}),
      ];
      const joinProfile = names.some((name) => name.startsWith('profile.'));
      const joinGroups = names.some((name) => name.startsWith('group.'));
      const scope: EventFilterScope = {
        projectId,
        timezone: 'UTC',
        alias: 'e',
        profileAlias: joinProfile ? 'profile' : undefined,
        groupJoin: joinGroups ? GROUP_JOIN : undefined,
      };

      const query = clix('UTC')
        .select<{ profile_id: string }>(['DISTINCT e.profile_id'])
        .from('analytics.events AS e')
        .rawWhere(sql`e.project_id = ${projectId}`)
        .rawWhere(
          sql`e.created_at >= ${instant(bucket.start)} AND e.created_at < ${instant(bucket.end)}`,
        );
      if (joinProfile) {
        query.rawJoin(profileJoin(scope));
      }
      if (joinGroups) {
        query.rawJoin(groupJoin(scope));
      }
      if (serie.name !== '*') {
        query.rawWhere(sql`e.name = ${serie.name}::text`);
      }
      for (const clause of eventFilterClauses(serie.filters, scope)) {
        query.rawWhere(clause);
      }
      for (const [key, value] of Object.entries(input.breakdowns ?? {})) {
        // ClickHouse compared the breakdown's value with the string; the
        // text of a numeric column compares the same way.
        query.rawWhere(
          sql`(${eventPropertyExpr(key, scope)})::text = ${value}::text`,
        );
      }

      // Get unique profile IDs
      const profileIds = await query.execute();
      if (profileIds.length === 0) {
        return [];
      }

      // Fetch profile details in batches
      const ids = profileIds.map((p) => p.profile_id).filter(Boolean);
      const BATCH_SIZE = 200;
      const profiles: IServiceProfile[] = [];
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const batchProfiles = await getProfilesCached(batch, projectId);
        profiles.push(...batchProfiles);
      }

      return profiles;
    }),

  getFunnelProfiles: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        series: zChartSeries,
        stepIndex: z.number().describe('0-based index of the funnel step'),
        showDropoffs: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'If true, show users who dropped off at this step. If false, show users who completed at least this step.'
          ),
        funnelWindow: z.number().optional(),
        funnelGroup: z.string().optional(),
        breakdowns: z.array(z.object({ name: z.string() })).optional(),
        breakdownValues: z.array(z.string()).optional(),
        range: zRange,
      })
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const {
        projectId,
        series,
        stepIndex,
        showDropoffs = false,
        funnelWindow,
        funnelGroup,
        breakdowns: inputBreakdowns = [],
        breakdownValues = [],
      } = input;

      const { startDate, endDate } = getChartStartEndDate(input, timezone);

      // stepIndex is 0-based, but level is 1-based, so we need level >= stepIndex + 1
      const targetLevel = stepIndex + 1;

      // Reuse the chart's own funnel builder rather than re-deriving the CTE
      // here. The two copies used to drift — breakdown expressions referencing
      // a `profile` or `cohort_<id>` alias whose join this side never added,
      // which failed with UNKNOWN_IDENTIFIER and surfaced as "No users found".
      const base = await funnelService.buildFunnelBase({
        projectId,
        startDate,
        endDate,
        series,
        breakdowns: inputBreakdowns,
        funnelWindow,
        funnelGroup,
        timezone,
      });
      // The funnel builder's query is the analytics query builder.
      const query = base.query as unknown as Query;
      const { breakdowns } = base;

      // Same shape as the chart's `funnel` CTE: the funnel level is already
      // computed per primary key (with breakdowns attributed at the entry
      // step, so each group carries one deterministic b_N value), so drop
      // level=0 and select distinct profiles.
      query.with('funnel', 'SELECT * FROM session_funnel WHERE level != 0');

      query.select(['DISTINCT profile_id']).from('funnel');

      if (showDropoffs) {
        query.where('level', '=', targetLevel);
      } else {
        query.where('level', '>=', targetLevel);
      }

      // Filter by specific breakdown values when a breakdown row was clicked.
      // The clicked row carries DISPLAY labels — trimmed, with empty/null
      // shown as EMPTY_BREAKDOWN_LABEL (see toSeries/normalizeBreakdownValue)
      // — so match against the same normalization, not the raw column, or
      // "Not set" rows and values with stray whitespace return no users.
      // The text form and COALESCE make the comparison work for numeric
      // breakdown columns and for NULLs.
      breakdowns.forEach((_, index) => {
        const value = breakdownValues[index];
        if (value === undefined) {
          return;
        }
        const normalized = sql`btrim(COALESCE((${raw(`b_${index}`)})::text, ''))`;
        if (value === EMPTY_BREAKDOWN_LABEL) {
          query.rawWhere(
            sql`(${normalized} = '' OR ${normalized} = ${EMPTY_BREAKDOWN_LABEL}::text)`
          );
        } else {
          query.rawWhere(sql`${normalized} = ${value}::text`);
        }
      });

      // Cap the number of profiles passed on to the profile lookups
      query.limit(1000);

      const profileIdsResult = (await query.execute()) as {
        profile_id: string;
      }[];

      if (profileIdsResult.length === 0) {
        return [];
      }

      // Fetch profile details in batches
      const ids = profileIdsResult.map((p) => p.profile_id).filter(Boolean);
      const BATCH_SIZE = 500;
      const profiles: IServiceProfile[] = [];
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const batchProfiles = await getProfilesCached(batch, projectId);
        profiles.push(...batchProfiles);
      }

      return profiles;
    }),
});
