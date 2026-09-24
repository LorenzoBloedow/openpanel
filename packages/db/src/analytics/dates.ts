/**
 * Date helpers the services share. Timestamps come back from the analytics
 * queries as ClickHouse-style UTC strings ('2024-05-01 12:34:56.789', see
 * client.ts), so the names and behaviour of the ClickHouse-era helpers are
 * kept.
 */

/** A UTC 'YYYY-MM-DD HH:MM:SS[.mmm]' string as a Date. */
export function convertClickhouseDateToJs(date: string) {
  return new Date(`${date.replace(' ', 'T')}Z`);
}

/** 'YYYY-MM-DD HH:MM:SS' in UTC ('YYYY-MM-DD' with skipTime). */
export function formatClickhouseDate(
  date: Date | string,
  skipTime = false,
): string {
  if (skipTime) {
    return new Date(date).toISOString().split('T')[0]!;
  }
  return new Date(date)
    .toISOString()
    .replace('T', ' ')
    .replace(/(\.\d{3})?Z+$/, '');
}

const ROLLUP_DATE_PREFIX = '1970-01-01';

/** The epoch placeholder a ROLLUP totals row (or an empty min) carries. */
export function isClickhouseDefaultMinDate(date: string): boolean {
  return date.startsWith(ROLLUP_DATE_PREFIX) || date.startsWith('1969-12-31');
}

export function toNullIfDefaultMinDate(date?: string | null): Date | null {
  if (!date) {
    return null;
  }
  return isClickhouseDefaultMinDate(date)
    ? null
    : convertClickhouseDateToJs(date);
}
