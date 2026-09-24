import { isSameDomain, parsePath } from '@openpanel/common';
import {
  getReferrerWithQuery,
  parseReferrer,
  type parseUserAgent,
} from '@openpanel/common/server';
import type { IServiceCreateEventPayload } from '@openpanel/db';
import type { GeoLocation } from '@openpanel/geo';

/**
 * Build the stored event payload from an SDK track payload — the
 * `baseEvent` the worker's incoming-event job used to build, now done in the
 * API so the queue carries final rows: path/hash/query/origin from
 * `__path`, referrer and UTM attribution, SDK headers, revenue, geo and
 * user agent.
 */

const GLOBAL_PROPERTIES = ['__path', '__referrer', '__timestamp', '__revenue'];

export interface NormalizeEventInput {
  projectId: string;
  deviceId: string;
  sessionId: string;
  event: {
    name: string;
    profileId?: string | number;
    properties?: Record<string, unknown>;
    groups?: string[];
  };
  /** Event time (ms), already validated against the receive time. */
  timestamp: number;
  sdkName?: string;
  sdkVersion?: string;
  geo: GeoLocation;
  uaInfo: ReturnType<typeof parseUserAgent>;
}

function withoutGlobalProperties(properties: Record<string, unknown>) {
  for (const key of GLOBAL_PROPERTIES) {
    delete properties[key];
  }
  return properties;
}

export function parseRevenue(revenue: unknown): number | undefined {
  if (!revenue) {
    return undefined;
  }
  if (typeof revenue === 'number') {
    return revenue;
  }
  if (typeof revenue === 'string') {
    const parsed = Number.parseFloat(revenue);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export function normalizeEvent(input: NormalizeEventInput): IServiceCreateEventPayload {
  const { event, geo, uaInfo } = input;
  const properties = event.properties ?? {};
  // `path` without the `__` prefix: very old SDKs (kept for compatibility).
  const getProperty = (name: string): string | undefined =>
    ((properties[name] || properties[name.replace('__', '')]) as string | null | undefined) ??
    undefined;

  const url = getProperty('__path');
  const { path, hash, query, origin } = parsePath(url);
  const referrer = isSameDomain(getProperty('__referrer'), url)
    ? null
    : parseReferrer(getProperty('__referrer'));
  const utmReferrer = getReferrerWithQuery(query);

  return {
    name: event.name,
    profileId: event.profileId ? String(event.profileId) : '',
    projectId: input.projectId,
    deviceId: input.deviceId,
    sessionId: input.sessionId,
    properties: withoutGlobalProperties({
      ...properties,
      __hash: hash,
      __query: query,
    }),
    groups: event.groups ?? [],
    createdAt: new Date(input.timestamp),
    duration: 0,
    sdkName: input.sdkName,
    sdkVersion: input.sdkVersion,
    city: geo.city,
    country: geo.country,
    region: geo.region,
    longitude: geo.longitude,
    latitude: geo.latitude,
    path,
    origin,
    referrer: referrer?.url || '',
    referrerName: utmReferrer?.name || referrer?.name || referrer?.url,
    referrerType: utmReferrer?.type || referrer?.type || '',
    os: uaInfo.os,
    osVersion: uaInfo.osVersion,
    browser: uaInfo.browser,
    browserVersion: uaInfo.browserVersion,
    device: uaInfo.device,
    brand: uaInfo.brand,
    model: uaInfo.model,
    revenue:
      event.name === 'revenue' && '__revenue' in properties
        ? parseRevenue(properties.__revenue)
        : undefined,
  };
}
