import { sql } from '../../../analytics/sql';
import {
  CREATED_UTC_DAY,
  EVENTS_TABLE,
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

const DELIMITER = '|||';
const SCREEN_VIEWS = "name = 'screen_view'";

async function fetchPageTrendAggregates(ctx: ComputeContext): Promise<{
  currentMap: Map<string, number>;
  baselineMap: Map<string, number>;
  totalCurrent: number;
  totalBaseline: number;
}> {
  if (ctx.window.kind === 'yesterday') {
    const [currentResults, baselineResults, totals] = await Promise.all([
      ctx
        .clix()
        .select<{ origin: string; path: string; cnt: number }>([
          'origin',
          'path',
          'count(*) as cnt',
        ])
        .from(EVENTS_TABLE)
        .rawWhere(forProject(ctx.projectId))
        .rawWhere(SCREEN_VIEWS)
        .rawWhere(
          createdBetween(ctx.window.start, getEndOfDay(ctx.window.end)),
        )
        .groupBy(['origin', 'path'])
        .execute(),
      ctx
        .clix()
        .select<{ date: string; origin: string; path: string; cnt: number }>([
          sql`${CREATED_UTC_DAY} as date`,
          'origin',
          'path',
          'count(*) as cnt',
        ])
        .from(EVENTS_TABLE)
        .rawWhere(forProject(ctx.projectId))
        .rawWhere(SCREEN_VIEWS)
        .rawWhere(
          createdBetween(
            ctx.window.baselineStart,
            getEndOfDay(ctx.window.baselineEnd),
          ),
        )
        .groupBy([CREATED_UTC_DAY, 'origin', 'path'])
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
        .from(EVENTS_TABLE)
        .rawWhere(forProject(ctx.projectId))
        .rawWhere(SCREEN_VIEWS)
        .rawWhere(
          createdBetween(ctx.window.baselineStart, getEndOfDay(ctx.window.end)),
        )
        .execute(),
    ]);

    const currentMap = buildLookupMap(
      currentResults,
      (r) => `${r.origin || ''}${DELIMITER}${r.path || '/'}`,
    );

    const targetWeekday = getWeekday(ctx.window.start);
    const baselineMap = computeWeekdayMedians(
      baselineResults,
      targetWeekday,
      (r) => `${r.origin || ''}${DELIMITER}${r.path || '/'}`,
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
      .select<{ origin: string; path: string; cur: number; base: number }>([
        'origin',
        'path',
        countCreatedBetween(curStart, curEnd, 'cur'),
        countCreatedBetween(baseStart, baseEnd, 'base'),
      ])
      .from(EVENTS_TABLE)
      .rawWhere(forProject(ctx.projectId))
      .rawWhere(SCREEN_VIEWS)
      .rawWhere(createdBetween(baseStart, curEnd))
      .groupBy(['origin', 'path'])
      .execute(),
    ctx
      .clix()
      .select<{ cur_total: number; base_total: number }>([
        countCreatedBetween(curStart, curEnd, 'cur_total'),
        countCreatedBetween(baseStart, baseEnd, 'base_total'),
      ])
      .from(EVENTS_TABLE)
      .rawWhere(forProject(ctx.projectId))
      .rawWhere(SCREEN_VIEWS)
      .rawWhere(createdBetween(baseStart, curEnd))
      .execute(),
  ]);

  const currentMap = buildLookupMap(
    results,
    (r) => `${r.origin || ''}${DELIMITER}${r.path || '/'}`,
    (r) => Number(r.cur ?? 0),
  );

  const baselineMap = buildLookupMap(
    results,
    (r) => `${r.origin || ''}${DELIMITER}${r.path || '/'}`,
    (r) => Number(r.base ?? 0),
  );

  const totalCurrent = totals[0]?.cur_total ?? 0;
  const totalBaseline = totals[0]?.base_total ?? 0;

  return { currentMap, baselineMap, totalCurrent, totalBaseline };
}

export const pageTrendsModule: InsightModule = {
  key: 'page-trends',
  cadence: ['daily'],
  // Share-based thresholds (values in basis points: 100 = 1%)
  // Tightened to cut noise: page-trends was ~85% of all insight rows because
  // a 0.5pp share wiggle on up to 100 pages/run crossed the bar.
  // minTotal: require at least 1% combined share (current + baseline)
  // minAbsDelta: require at least 1.0 percentage point shift
  // minPct: require at least 35% relative change in share
  // maxDims: evaluate at most 30 pages/run (was 100)
  thresholds: { minTotal: 100, minAbsDelta: 100, minPct: 0.35, maxDims: 30 },

  async enumerateDimensions(ctx) {
    const { currentMap, baselineMap } = await fetchPageTrendAggregates(ctx);
    const topDims = selectTopDimensions(
      currentMap,
      baselineMap,
      this.thresholds?.maxDims ?? 100,
    );
    return topDims.map((dim) => `page:${dim}`);
  },

  async computeMany(ctx, dimensionKeys): Promise<ComputeResult[]> {
    const { currentMap, baselineMap, totalCurrent, totalBaseline } =
      await fetchPageTrendAggregates(ctx);
    const results: ComputeResult[] = [];

    for (const dimKey of dimensionKeys) {
      if (!dimKey.startsWith('page:')) continue;
      const originPath = dimKey.replace('page:', '');

      const pageviewsCurrent = currentMap.get(originPath) ?? 0;
      const pageviewsCompare = baselineMap.get(originPath) ?? 0;

      const currentShare =
        totalCurrent > 0 ? pageviewsCurrent / totalCurrent : 0;
      const compareShare =
        totalBaseline > 0 ? pageviewsCompare / totalBaseline : 0;

      // Use share values in basis points (100 = 1%) for thresholding
      // This makes thresholds intuitive: minAbsDelta=50 means 0.5pp shift
      const currentShareBp = currentShare * 10000;
      const compareShareBp = compareShare * 10000;

      const shareShiftPp = (currentShare - compareShare) * 100;
      // changePct is relative change in share, not absolute pageviews
      const shareChangePct = computeChangePct(currentShare, compareShare);
      const direction = computeDirection(shareChangePct);

      results.push({
        ok: true,
        dimensionKey: dimKey,
        // Use share in basis points for threshold checks
        currentValue: currentShareBp,
        compareValue: compareShareBp,
        changePct: shareChangePct,
        direction,
        extra: {
          // Keep absolute values for display
          pageviewsCurrent,
          pageviewsCompare,
          shareShiftPp,
          currentShare,
          compareShare,
          isNew: pageviewsCompare === 0 && pageviewsCurrent > 0,
        },
      });
    }

    return results;
  },

  render(result, ctx): RenderedCard {
    const originPath = result.dimensionKey.replace('page:', '');
    const [origin, path] = originPath.split(DELIMITER);
    const displayValue = origin ? `${origin}${path}` : path || '/';

    // Get absolute pageviews from extra (currentValue/compareValue are now share-based)
    const pageviewsCurrent = Number(result.extra?.pageviewsCurrent ?? 0);
    const pageviewsCompare = Number(result.extra?.pageviewsCompare ?? 0);
    const shareCurrent = Number(result.extra?.currentShare ?? 0);
    const shareCompare = Number(result.extra?.compareShare ?? 0);
    const shareShiftPp = Number(result.extra?.shareShiftPp ?? 0);
    const isNew = result.extra?.isNew as boolean | undefined;

    // Display share shift in percentage points
    const isIncrease = shareShiftPp >= 0;
    const shareShiftDisplay = Math.abs(shareShiftPp).toFixed(1);

    const title = isNew
      ? `New page getting views: ${displayValue}`
      : `Page ${displayValue} share ${isIncrease ? '↑' : '↓'} ${shareShiftDisplay}pp`;

    return {
      title,
      summary: `${ctx.window.label}. Share ${(shareCurrent * 100).toFixed(1)}% vs ${(shareCompare * 100).toFixed(1)}%.`,
      displayName: displayValue,
      payload: {
        kind: 'insight_v1',
        dimensions: [
          { key: 'origin', value: origin ?? '', displayName: origin ?? '' },
          { key: 'path', value: path ?? '', displayName: path ?? '' },
        ],
        primaryMetric: 'share',
        metrics: {
          pageviews: {
            current: pageviewsCurrent,
            compare: pageviewsCompare,
            delta: pageviewsCurrent - pageviewsCompare,
            changePct:
              pageviewsCompare > 0
                ? (pageviewsCurrent - pageviewsCompare) / pageviewsCompare
                : null,
            direction:
              pageviewsCurrent > pageviewsCompare
                ? 'up'
                : pageviewsCurrent < pageviewsCompare
                  ? 'down'
                  : 'flat',
            unit: 'count',
          },
          share: {
            current: shareCurrent,
            compare: shareCompare,
            delta: shareCurrent - shareCompare,
            changePct: result.changePct ?? null, // This is now share-based
            direction: result.direction ?? 'flat',
            unit: 'ratio',
          },
        },
        extra: {
          isNew: result.extra?.isNew,
          shareShiftPp,
        },
      },
    };
  },
};
