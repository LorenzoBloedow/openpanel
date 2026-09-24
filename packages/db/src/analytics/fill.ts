import { DateTime } from '@openpanel/common';

import type { TimeUnit } from './time';

/**
 * Fill missing time buckets in JS — ClickHouse's `ORDER BY date WITH FILL
 * FROM … TO … STEP …`, which Postgres doesn't have.
 *
 * Buckets are wall-clock strings in the project zone, as the queries render
 * them ('YYYY-MM-DD HH:MM:SS', or 'YYYY-MM-DD' for `format: 'date'`). The
 * range starts at the bucket containing `from` and stops before `to`, like
 * WITH FILL. Rows outside the range (the ROLLUP totals row) are kept; the
 * result is ordered by the bucket, stable within one bucket.
 */
export interface GapFillOptions<T> {
  key: keyof T & string;
  from: string;
  to: string;
  unit: TimeUnit;
  format?: 'datetime' | 'date';
  /** The row to insert for a missing bucket. */
  fill: (bucket: string) => T;
}

const WALL_CLOCK_FORMATS = ['yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm', 'yyyy-MM-dd'];

function parseWallClock(value: string): DateTime {
  const normalized = value.replace('T', ' ').replace(/\.\d+$/, '');
  for (const format of WALL_CLOCK_FORMATS) {
    const parsed = DateTime.fromFormat(normalized, format, { zone: 'utc' });
    if (parsed.isValid) {
      return parsed;
    }
  }
  throw new Error(`gapFill: not a wall-clock date: ${value}`);
}

export function bucketRange(
  from: string,
  to: string,
  unit: TimeUnit,
  format: 'datetime' | 'date' = 'datetime',
): string[] {
  const pattern = format === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss';
  const end = parseWallClock(to);
  const buckets: string[] = [];
  let cursor = parseWallClock(from).startOf(unit);
  while (cursor < end) {
    buckets.push(cursor.toFormat(pattern));
    cursor = cursor.plus({ [unit]: 1 });
  }
  return buckets;
}

export function gapFill<T extends Record<string, unknown>>(
  rows: T[],
  options: GapFillOptions<T>,
): T[] {
  const { key, fill } = options;
  const present = new Set(rows.map((row) => String(row[key])));
  const filled = [...rows];
  for (const bucket of bucketRange(
    options.from,
    options.to,
    options.unit,
    options.format,
  )) {
    if (!present.has(bucket)) {
      filled.push(fill(bucket));
    }
  }
  // Array.prototype.sort is stable, so rows sharing a bucket keep their order.
  return filled.sort((a, b) => {
    const left = String(a[key]);
    const right = String(b[key]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
