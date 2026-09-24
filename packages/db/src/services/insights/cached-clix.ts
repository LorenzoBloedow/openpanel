import { type Query, clix as analyticsClix } from '../../analytics/query-builder';
import { compile } from '../../analytics/sql';
import type { InsightQueryFactory } from './types';

/**
 * Creates a cached wrapper around the query factory that caches results by
 * query (text and parameters). This eliminates duplicate queries within the
 * same module/window context; identical queries running at once share one
 * round trip.
 *
 * @param factory - Query factory (defaults to the analytics query builder)
 * @param cache - Optional cache Map to store query results
 * @param timezone - Timezone for wall-clock values (defaults to UTC)
 * @returns A function that creates cached Query instances (compatible with clix API)
 */
export function createCachedClix(
  factory: InsightQueryFactory = analyticsClix,
  cache?: Map<string, Promise<unknown>>,
  timezone?: string,
) {
  function clixCached(): Query {
    const query = factory(timezone);
    const queryTimezone = timezone ?? 'UTC';

    const originalExecute = query.execute.bind(query);
    query.execute = () => {
      const { text, values } = compile(query.toSql());
      const cacheKey = JSON.stringify([text, values, queryTimezone]);

      const cached = cache?.get(cacheKey);
      if (cached) {
        return cached as ReturnType<typeof originalExecute>;
      }

      const result = originalExecute();
      if (cache) {
        cache.set(cacheKey, result);
        // A failed query is not remembered: the next call runs it again.
        result.catch(() => cache.delete(cacheKey));
      }
      return result;
    };

    return query;
  }

  // Copy static helpers from the query builder
  clixCached.exp = analyticsClix.exp;
  clixCached.date = analyticsClix.date;
  clixCached.datetime = analyticsClix.datetime;
  clixCached.dynamicDatetime = analyticsClix.dynamicDatetime;
  clixCached.toStartOf = analyticsClix.toStartOf;
  clixCached.formatBucket = analyticsClix.formatBucket;

  return clixCached;
}
