import type { IChartEventFilter, IChartRange } from '@openpanel/validation';

import { getChartStartEndDate } from '../../../src/services/date.service';
import { GOLDEN_PROJECTS, type GoldenProjectKey } from '../harness';

/** The date window a router would compute for `range` (time is frozen). */
export function window(project: GoldenProjectKey, range: IChartRange) {
  const { timezone, id } = GOLDEN_PROJECTS[project];
  const { startDate, endDate } = getChartStartEndDate({ range }, timezone);
  return { projectId: id, timezone, startDate, endDate };
}

/** An explicit wall-clock window in the project's zone. */
export function explicitWindow(
  project: GoldenProjectKey,
  startDate: string,
  endDate: string,
) {
  const { timezone, id } = GOLDEN_PROJECTS[project];
  return { projectId: id, timezone, startDate, endDate };
}

let filterId = 0;
function filter(
  name: string,
  operator: IChartEventFilter['operator'],
  value: IChartEventFilter['value'],
): IChartEventFilter {
  filterId++;
  return { id: `f${filterId}`, name, operator, value };
}

export const FILTERS = {
  none: [] as IChartEventFilter[],
  countrySE: [filter('country', 'is', ['SE'])],
  pathDocs: [filter('path', 'contains', ['docs'])],
  referrerGoogle: [filter('referrer_name', 'is', ['Google'])],
  browserNotChrome: [filter('browser', 'isNot', ['Chrome'])],
  utmNewsletter: [filter('properties.__query.utm_source', 'is', ['newsletter'])],
  mobileInUS: [filter('device', 'is', ['mobile']), filter('country', 'is', ['US'])],
} satisfies Record<string, IChartEventFilter[]>;
