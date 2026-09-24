/**
 * SQL-shape tests for the profile metrics query. Its results are compared
 * with the ClickHouse service in test/golden/profiles.golden.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { compile } from '../analytics/sql';
import { buildProfileMetricsSql } from './profile.service';

const PROJECT_ID = 'test-sql-validation';
const PROFILE_ID = 'profile-1';

describe('buildProfileMetricsSql', () => {
  // Every metric is a plain aggregate over the same
  // `profile_id = X AND project_id = Y` slice, so the query must read the
  // events table exactly once.
  it('scans the events table exactly once', () => {
    const { text } = compile(buildProfileMetricsSql(PROFILE_ID, PROJECT_ID));
    expect(text.match(/FROM analytics\.events\b/g)).toHaveLength(1);
    expect(text.match(/FROM analytics\.profiles\b/g)).toHaveLength(1);
  });

  it('returns every metric of the panel', () => {
    const { text } = compile(buildProfileMetricsSql(PROFILE_ID, PROJECT_ID));
    for (const metric of [
      'lastSeen',
      'firstSeen',
      'screenViews',
      'sessions',
      'durationAvg',
      'durationP90',
      'totalEvents',
      'uniqueDaysActive',
      'bounceRate',
      'avgEventsPerSession',
      'conversionEvents',
      'avgTimeBetweenSessions',
      'revenue',
    ]) {
      expect(text).toContain(`AS "${metric}"`);
    }
  });

  it('binds the identifiers', () => {
    const { text, values } = compile(buildProfileMetricsSql("p'--", "x'--"));
    expect(text).not.toContain("p'--");
    expect(text).not.toContain("x'--");
    expect(values).toEqual(["x'--", "p'--", "x'--", "p'--"]);
  });
});
