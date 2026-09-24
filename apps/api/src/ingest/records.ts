import { parseUserAgent, uuidv7 } from '@openpanel/common/server';
import {
  type EventRecord,
  type ProfileRecord,
  serializeEventPayload,
} from '@openpanel/db/src/ingest/envelope';
import type { IServiceCreateEventPayload } from '@openpanel/db/src/services/event.service';
import type { GeoLocation } from '@openpanel/geo';

import { stripBotProperties } from '@/bots/suspicion';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Identity fields come from event properties too, which nobody validated. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export interface IdentifyInput {
  profileId: unknown;
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  avatar?: unknown;
  properties?: unknown;
}

/**
 * The profile upsert for an identify (the track handler's `handleIdentify`):
 * the SDK's fields plus the request's geo and user agent as properties.
 * Returns null without a profile id.
 */
export function identifyRecord(
  payload: IdentifyInput,
  context: { projectId: string; geo: GeoLocation; ua: string | undefined },
): ProfileRecord | null {
  const profileId =
    payload.profileId === undefined || payload.profileId === null
      ? ''
      : String(payload.profileId);
  if (!profileId) {
    return null;
  }
  const properties = isRecord(payload.properties)
    ? { ...payload.properties }
    : {};
  // Profiles must not carry forged bot verdicts either.
  stripBotProperties(properties);
  const uaInfo = parseUserAgent(context.ua, properties);
  const { geo } = context;

  return {
    type: 'profile',
    id: uuidv7(),
    profile: {
      id: profileId,
      projectId: context.projectId,
      firstName: optionalString(payload.firstName),
      lastName: optionalString(payload.lastName),
      email: optionalString(payload.email),
      avatar: optionalString(payload.avatar),
      properties: {
        ...properties,
        country: geo.country,
        city: geo.city,
        region: geo.region,
        longitude: geo.longitude,
        latitude: geo.latitude,
        os: uaInfo.os,
        os_version: uaInfo.osVersion,
        browser: uaInfo.browser,
        browser_version: uaInfo.browserVersion,
        device: uaInfo.device,
        brand: uaInfo.brand,
        model: uaInfo.model,
      },
      isExternal: true,
    },
  };
}

export function eventRecord(
  event: IServiceCreateEventPayload,
  detached?: 'server' | 'past',
): EventRecord {
  return {
    type: 'event',
    id: uuidv7(),
    event: serializeEventPayload(event),
    ...(detached ? { detached } : {}),
  };
}

/**
 * Server-side events (server user agents) and events backdated more than
 * 15 minutes don't open or close sessions. A backdated event joins no
 * session; a server event joins its profile's live session, if any.
 */
export function detachedKind(input: {
  isServer: boolean;
  isFromPast: boolean;
}): 'server' | 'past' | undefined {
  if (input.isFromPast) {
    return 'past';
  }
  return input.isServer ? 'server' : undefined;
}
