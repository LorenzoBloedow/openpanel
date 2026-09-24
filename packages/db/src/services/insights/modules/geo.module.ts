import { getCountry } from '@openpanel/constants';
import { sql } from '../../../analytics/sql';
import {
  CREATED_UTC_DAY,
  SESSIONS_TABLE,
  countCreatedBetween,
  createdBetween,
  forProject,
} from '../queries';
import type {
  ComputeContext,
  ComputeResult,
  InsightModule,
  RenderedCard,
} from '../types';
import {
  buildLookupMap,
  computeChangePct,
  computeDirection,
  computeWeekdayMedians,
  getEndOfDay,
  getWeekday,
  selectTopDimensions,
} from '../utils';

/**
 * A session country's map key. ClickHouse stored `country` as
 * FixedString(2), so an unknown country read back as two NUL bytes: truthy,
 * so it never became 'unknown'. The engine strips NULs from dimension keys,
 * so that dimension ('country:') never finds its rows and computes 0 vs 0:
 * no insight for unknown countries, which getCountry has no name for. Kept
 * by padding like FixedString did.
 */
function countryKey(country: string): string {
  return country.padEnd(2, '\u0000');
}

async function fetchGeoAggregates(ctx: ComputeContext): Promise<{
  currentMap: Map<string, number>;
  baselineMap: Map<string, number>;
  totalCurrent: number;
  totalBaseline: number;
}> {
  if (ctx.window.kind === 'yesterday') {
    const [currentResults, baselineResults, totals] = await Promise.all([
      ctx
        .clix()
        .select<{ country: string; cnt: number }>([
          'country',
          'count(*) as cnt',
        ])
        .from(SESSIONS_TABLE)
        .rawWhere(forProject(ctx.projectId))
        .rawWhere(
          createdBetween(ctx.window.start, getEndOfDay(ctx.window.end)),
        )
        .groupBy(['country'])
        .execute(),
      ctx
        .clix()
        .select<{ date: string; country: string; cnt: number }>([
          sql`${CREATED_UTC_DAY} as date`,
          'country',
          'count(*) as cnt',
        ])
        .from(SESSIONS_TABLE)
        .rawWhere(forProject(ctx.projectId))
        .rawWhere(
          createdBetween(
            ctx.window.baselineStart,
            getEndOfDay(ctx.window.baselineEnd),
          ),
        )
        .groupBy([CREATED_UTC_DAY, 'country'])
        .execute(),
      ctx
        .clix()
        .select<{ cur_total: number }>([
          countCreatedBetween(
            ctx.window.start,
            getEndOfDay(ctx.window.end),
            'cur_total',
          ),
        ])
        .from(SESSIONS_TABLE)
        .rawWhere(forProject(ctx.projectId))
        .rawWhere(
          createdBetween(ctx.window.baselineStart, getEndOfDay(ctx.window.end)),
        )
        .execute(),
    ]);

    const currentMap = buildLookupMap(
      currentResults,
      (r) => countryKey(r.country),
    );

    const targetWeekday = getWeekday(ctx.window.start);
    const baselineMap = computeWeekdayMedians(
      baselineResults,
      targetWeekday,
      (r) => countryKey(r.country),
    );

    const totalCurrent = totals[0]?.cur_total ?? 0;
    const totalBaseline = Array.from(baselineMap.values()).reduce(
      (sum, val) => sum + val,
      0,
    );

    return { currentMap, baselineMap, totalCurrent, totalBaseline };
  }

  const curStart = ctx.window.start;
  const curEnd = getEndOfDay(ctx.window.end);
  const baseStart = ctx.window.baselineStart;
  const baseEnd = getEndOfDay(ctx.window.baselineEnd);

  const [results, totals] = await Promise.all([
    ctx
      .clix()
      .select<{ country: string; cur: number; base: number }>([
        'country',
        countCreatedBetween(curStart, curEnd, 'cur'),
        countCreatedBetween(baseStart, baseEnd, 'base'),
      ])
      .from(SESSIONS_TABLE)
      .rawWhere(forProject(ctx.projectId))
      .rawWhere(createdBetween(baseStart, curEnd))
      .groupBy(['country'])
      .execute(),
    ctx
      .clix()
      .select<{ cur_total: number; base_total: number }>([
        countCreatedBetween(curStart, curEnd, 'cur_total'),
        countCreatedBetween(baseStart, baseEnd, 'base_total'),
      ])
      .from(SESSIONS_TABLE)
      .rawWhere(forProject(ctx.projectId))
      .rawWhere(createdBetween(baseStart, curEnd))
      .execute(),
  ]);

  const currentMap = buildLookupMap(
    results,
    (r) => countryKey(r.country),
    (r) => Number(r.cur ?? 0),
  );

  const baselineMap = buildLookupMap(
    results,
    (r) => countryKey(r.country),
    (r) => Number(r.base ?? 0),
  );

  const totalCurrent = totals[0]?.cur_total ?? 0;
  const totalBaseline = totals[0]?.base_total ?? 0;

  return { currentMap, baselineMap, totalCurrent, totalBaseline };
}

export const geoModule: InsightModule = {
  key: 'geo',
  cadence: ['daily'],
  thresholds: { minTotal: 100, minAbsDelta: 0, minPct: 0.08, maxDims: 30 },

  async enumerateDimensions(ctx) {
    const { currentMap, baselineMap } = await fetchGeoAggregates(ctx);
    const topDims = selectTopDimensions(
      currentMap,
      baselineMap,
      this.thresholds?.maxDims ?? 30,
    );
    return topDims.map((dim) => `country:${dim}`);
  },

  async computeMany(ctx, dimensionKeys): Promise<ComputeResult[]> {
    const { currentMap, baselineMap, totalCurrent, totalBaseline } =
      await fetchGeoAggregates(ctx);
    const results: ComputeResult[] = [];

    for (const dimKey of dimensionKeys) {
      if (!dimKey.startsWith('country:')) continue;
      const country = dimKey.replace('country:', '');

      const currentValue = currentMap.get(country) ?? 0;
      const compareValue = baselineMap.get(country) ?? 0;

      const currentShare = totalCurrent > 0 ? currentValue / totalCurrent : 0;
      const compareShare = totalBaseline > 0 ? compareValue / totalBaseline : 0;

      const shareShiftPp = (currentShare - compareShare) * 100;
      const changePct = computeChangePct(currentValue, compareValue);
      const direction = computeDirection(changePct);

      results.push({
        ok: true,
        dimensionKey: dimKey,
        currentValue,
        compareValue,
        changePct,
        direction,
        extra: {
          shareShiftPp,
          currentShare,
          compareShare,
          isNew: compareValue === 0 && currentValue > 0,
        },
      });
    }

    return results;
  },

  render(result, ctx): RenderedCard {
    const country = result.dimensionKey.replace('country:', '');
    const changePct = result.changePct ?? 0;
    const isIncrease = changePct >= 0;
    const isNew = result.extra?.isNew as boolean | undefined;
    const displayName = getCountry(country);

    const title = isNew
      ? `New traffic from: ${displayName}`
      : `${displayName} ${isIncrease ? '↑' : '↓'} ${Math.abs(changePct * 100).toFixed(0)}%`;

    const sessionsCurrent = result.currentValue ?? 0;
    const sessionsCompare = result.compareValue ?? 0;
    const shareCurrent = Number(result.extra?.currentShare ?? 0);
    const shareCompare = Number(result.extra?.compareShare ?? 0);

    return {
      title,
      summary: `${ctx.window.label}. Traffic change from ${displayName}.`,
      displayName,
      payload: {
        kind: 'insight_v1',
        dimensions: [
          { key: 'country', value: country, displayName: displayName },
        ],
        primaryMetric: 'sessions',
        metrics: {
          sessions: {
            current: sessionsCurrent,
            compare: sessionsCompare,
            delta: sessionsCurrent - sessionsCompare,
            changePct: sessionsCompare > 0 ? (result.changePct ?? 0) : null,
            direction: result.direction ?? 'flat',
            unit: 'count',
          },
          share: {
            current: shareCurrent,
            compare: shareCompare,
            delta: shareCurrent - shareCompare,
            changePct:
              shareCompare > 0
                ? (shareCurrent - shareCompare) / shareCompare
                : null,
            direction:
              shareCurrent - shareCompare > 0.0005
                ? 'up'
                : shareCurrent - shareCompare < -0.0005
                  ? 'down'
                  : 'flat',
            unit: 'ratio',
          },
        },
        extra: {
          isNew: result.extra?.isNew,
        },
      },
    };
  },
};
