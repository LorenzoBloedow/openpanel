/**
 * Query pieces the funnel, conversion and user-flow (sankey) services
 * share. Not re-exported from the package: these are internals of those
 * three services.
 */
import type { IChartEventFilter } from '@openpanel/validation';

import { collectProfilePropertyKeys, resolveProfileField } from '../analytics/fields';
import {
  type EventFilterScope,
  GROUP_JOIN,
  groupJoin,
  narrowProfileScope,
  narrowedProfileSelect,
} from '../analytics/filters';
import { clix } from '../analytics/query-builder';
import { type Sql, join, raw, sql } from '../analytics/sql';
import { type TimeCtx, fromLocalEarliest } from '../analytics/time';

/** Alias of the events row in the funnel, conversion and sankey queries. */
export const EVENTS = 'e';

/** Alias of the profile joined by {@link eventJoins}. */
const PROFILE = 'profile';

/**
 * `column BETWEEN start AND end` for the dashboard's wall-clock bounds, read
 * the way `created_at BETWEEN toDateTime('…') AND toDateTime('…')` read them
 * under the project's session_timezone. `clix.datetime` first normalizes the
 * input as the ClickHouse builder did ('YYYY-MM-DD' is midnight).
 */
export function dateRange(
  startDate: string,
  endDate: string,
  ctx: TimeCtx,
  column: Sql = raw(`${EVENTS}.created_at`),
): Sql {
  return sql`${column} BETWEEN ${fromLocalEarliest(clix.datetime(startDate), ctx)} AND ${fromLocalEarliest(clix.datetime(endDate), ctx)}`;
}

/**
 * The joins an events query's filters and breakdowns read through, and the
 * filter scope that reads them:
 * - `profile.*` names: the profile, narrowed to the referenced property
 *   keys and profile columns (ClickHouse's narrowed `LEFT ANY JOIN … AS
 *   profile`);
 * - `groups`: one row per group of the event, rows without groups dropped
 *   (ClickHouse's `ARRAY JOIN groups` and its `_g` join).
 */
export function eventJoins({
  projectId,
  timezone,
  filters,
  breakdowns,
  groups,
}: {
  projectId: string;
  timezone: string;
  filters: readonly IChartEventFilter[];
  breakdowns: readonly { name: string }[];
  groups: boolean;
}): { joins: Sql; scope: EventFilterScope } {
  let scope: EventFilterScope = { projectId, timezone, alias: EVENTS };
  const joins: Sql[] = [];

  const profileBreakdowns = breakdowns.filter((b) => b.name.startsWith('profile.'));
  const readsProfile =
    profileBreakdowns.length > 0 || filters.some((f) => f.name.startsWith('profile.'));
  if (readsProfile) {
    const properties = collectProfilePropertyKeys([...filters, ...breakdowns]);
    const { select, columns } = narrowedProfileSelect(properties.keys, properties.needsFullMap);
    const profileColumns = new Set<string>();
    for (const breakdown of profileBreakdowns) {
      const field = resolveProfileField(breakdown.name);
      // Allowlisted by resolveProfileField; `id` is always selected.
      if (field && 'column' in field && field.column !== 'id') {
        profileColumns.add(field.column);
      }
    }
    const extra = [...profileColumns].map((column) => sql`, ${raw(column)}`);
    joins.push(
      sql`LEFT JOIN (SELECT ${select}${join(extra, '')} FROM analytics.profiles WHERE project_id = ${projectId}) AS ${raw(PROFILE)} ON ${raw(PROFILE)}.id = ${raw(EVENTS)}.profile_id`,
    );
    scope = narrowProfileScope({ ...scope, profileAlias: PROFILE }, columns);
  }

  if (groups) {
    joins.push(groupJoin(scope, GROUP_JOIN));
    scope = { ...scope, groupJoin: GROUP_JOIN };
  }

  return { joins: join(joins, ' '), scope };
}
