import { stripLeadingAndTrailingSlashes } from '@openpanel/common';
import type { IChartEvent, IChartEventFilter } from '@openpanel/validation';
import { pathOr } from 'ramda';

import type { IServiceCreateEventPayload } from './event.service';

/**
 * Does an event payload match a chart event definition (name + filters)?
 * Used by project exclusion filters at ingestion and by notification rules.
 * Pure — kept out of notification.service so the ingest path doesn't pull in
 * the query services.
 */
export function matchEventFilters(
  payload: IServiceCreateEventPayload,
  filters: IChartEventFilter[]
) {
  return filters.every((filter) => {
    const { name, value, operator } = filter;

    if (value.length === 0) {
      return true;
    }

    if (name === 'has_profile') {
      if (value.includes('true')) {
        return payload.profileId !== payload.deviceId;
      }
      return payload.profileId === payload.deviceId;
    }

    const propertyValue = (
      name.startsWith('properties.')
        ? pathOr('', name.split('.'), payload)
        : pathOr('', [name], payload)
    ).trim();

    switch (operator) {
      case 'is':
        return value.includes(propertyValue);
      case 'isNot':
        return !value.includes(propertyValue);
      case 'contains':
        return value.some((val) => propertyValue.includes(String(val)));
      case 'doesNotContain':
        return !value.some((val) => propertyValue.includes(String(val)));
      case 'startsWith':
        return value.some((val) => propertyValue.startsWith(String(val)));
      case 'endsWith':
        return value.some((val) => propertyValue.endsWith(String(val)));
      case 'regex': {
        return value
          .map((val) => stripLeadingAndTrailingSlashes(String(val)))
          .some((val) => {
            try {
              return new RegExp(val).test(propertyValue);
            } catch {
              return false;
            }
          });
      }
      case 'isNull':
        return propertyValue === '';
      case 'isNotNull':
        return propertyValue !== '';
      case 'gt':
        return value.some((val) => Number(propertyValue) > Number(val));
      case 'lt':
        return value.some((val) => Number(propertyValue) < Number(val));
      case 'gte':
        return value.some((val) => Number(propertyValue) >= Number(val));
      case 'lte':
        return value.some((val) => Number(propertyValue) <= Number(val));
      default:
        return false;
    }
  });
}

export function matchEvent(
  payload: IServiceCreateEventPayload,
  chartEvent: IChartEvent
) {
  if (payload.name !== chartEvent.name && chartEvent.name !== '*') {
    return false;
  }

  if (chartEvent.filters.length > 0) {
    return matchEventFilters(payload, chartEvent.filters);
  }

  return true;
}
