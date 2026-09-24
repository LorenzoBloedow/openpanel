import { describe, expect, it } from 'vitest';
import { bucketRange, gapFill } from './fill';

describe('gapFill', () => {
  it('fills missing day buckets up to (not including) the end', () => {
    const rows = [
      { date: '2024-03-02 00:00:00', count: 5 },
      { date: '1970-01-01 00:00:00', count: 5 },
    ];
    expect(
      gapFill(rows, {
        key: 'date',
        from: '2024-03-01 10:00:00',
        to: '2024-03-04 00:00:00',
        unit: 'day',
        fill: (date) => ({ date, count: 0 }),
      }),
    ).toEqual([
      { date: '1970-01-01 00:00:00', count: 5 },
      { date: '2024-03-01 00:00:00', count: 0 },
      { date: '2024-03-02 00:00:00', count: 5 },
      { date: '2024-03-03 00:00:00', count: 0 },
    ]);
  });

  it('uses Monday weeks and month starts', () => {
    expect(bucketRange('2024-03-06 00:00:00', '2024-03-19 00:00:00', 'week', 'date')).toEqual([
      '2024-03-04',
      '2024-03-11',
      '2024-03-18',
    ]);
    expect(bucketRange('2024-01-31', '2024-04-01', 'month', 'date')).toEqual([
      '2024-01-01',
      '2024-02-01',
      '2024-03-01',
    ]);
  });

  it('keeps several rows per bucket in order', () => {
    const rows = [
      { date: '2024-03-01 01:00:00', name: 'b' },
      { date: '2024-03-01 01:00:00', name: 'a' },
    ];
    expect(
      gapFill(rows, {
        key: 'date',
        from: '2024-03-01 00:00:00',
        to: '2024-03-01 02:00:00',
        unit: 'hour',
        fill: (date) => ({ date, name: '' }),
      }).map((row) => row.name),
    ).toEqual(['', 'b', 'a']);
  });
});
