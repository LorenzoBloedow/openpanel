import { parseUserAgent, uuidv7 } from '@openpanel/common/server';
import { getProfileProperties } from '@openpanel/db/src/ingest/profiles';
import type {
  DeprecatedIncrementProfilePayload,
  DeprecatedPostEventPayload,
  DeprecatedUpdateProfilePayload,
} from '@openpanel/validation';
import { type Context, Hono } from 'hono';
import { pathOr } from 'ramda';

import { applyBotSuspicion } from '@/bots/suspicion';
import type { AppEnv } from '@/env';
import {
  geoSource,
  getCandidateDeviceIds,
  getDedupeHash,
  getGeoAndAsn,
  getSdkHeaders,
  getTimestamp,
  resolveDevice,
} from '@/ingest/context';
import { normalizeEvent } from '@/ingest/normalize';
import { enqueueRecords } from '@/ingest/queue';
import { detachedKind, eventRecord, identifyRecord } from '@/ingest/records';
import { botFilter, sdkClient } from '@/middleware/sdk';
import { isExcludedByProject } from '@/routes/track';

/**
 * The beta SDKs' endpoints (POST /event, POST /profile[/increment|/decrement]).
 * Same pipeline as /track, same responses as before.
 */

function cfOf(c: Context<AppEnv>) {
  return c.req.raw.cf as Parameters<typeof geoSource>[1];
}

export const eventRoutes = new Hono<AppEnv>();

eventRoutes.use(sdkClient, botFilter);

eventRoutes.post('/', async (c) => {
  const rawBody = c.get('body');
  const body = (rawBody && typeof rawBody === 'object' ? rawBody : null) as
    | (DeprecatedPostEventPayload & { groups?: string[] })
    | null;
  const client = c.get('client')!;
  const projectId = client.projectId;
  if (!projectId) {
    return c.text('missing origin', 400);
  }
  if (!(body && typeof body.name === 'string' && body.name)) {
    return c.json(
      { status: 400, error: 'Bad Request', message: 'body/name is required' },
      400,
    );
  }

  const headers = c.req.raw.headers;
  const ip = c.get('clientIp');
  const ua = c.req.header('user-agent') ?? 'unknown/1.0';
  const { timestamp, isTimestampFromThePast } = getTimestamp(
    c.get('timestamp'),
    body,
  );

  const [{ geo, asnInfo }, deviceIds] = await Promise.all([
    getGeoAndAsn(ip, geoSource(headers, cfOf(c))),
    getCandidateDeviceIds({ projectId, ip, ua }),
  ]);
  const device = await resolveDevice({
    projectId,
    deviceIds,
    eventTimeMs: c.get('timestamp'),
    dedupeHash: getDedupeHash({
      body: rawBody,
      ip,
      origin: c.req.header('origin'),
      clientIdHeader: c.req.header('openpanel-client-id'),
    }),
  });
  if (device.duplicate) {
    return c.text('Duplicate event', 200);
  }

  const uaInfo = parseUserAgent(ua, body.properties);
  // Mark (never block) likely bot traffic with __bot / __bot_reasons.
  body.properties = applyBotSuspicion(body.properties, {
    asnInfo,
    headers: Object.fromEntries(headers),
    clientSecretAuth: c.get('clientSecretAuth'),
    isServer: uaInfo.isServer,
  }) as DeprecatedPostEventPayload['properties'];

  const event = normalizeEvent({
    projectId,
    deviceId: device.deviceId,
    sessionId: device.sessionId,
    event: {
      name: body.name,
      profileId: body.profileId,
      properties: body.properties,
      groups: Array.isArray(body.groups) ? body.groups : [],
    },
    timestamp,
    ...getSdkHeaders(headers),
    geo,
    uaInfo,
  });
  const detached = detachedKind({
    isServer: uaInfo.isServer,
    isFromPast: isTimestampFromThePast,
  });
  if (detached || !isExcludedByProject(event, client)) {
    await enqueueRecords(c.env.EVENTS_QUEUE, projectId, [
      eventRecord(event, detached),
    ]);
  }

  return c.text('ok', 202);
});

export const profileRoutes = new Hono<AppEnv>();

profileRoutes.use(sdkClient, botFilter);

profileRoutes.post('/', async (c) => {
  const payload = c.get('body') as DeprecatedUpdateProfilePayload | null;
  const projectId = c.get('client')?.projectId;
  if (!projectId) {
    return c.text('No projectId', 400);
  }
  const ip = c.get('clientIp');
  const { geo } = await getGeoAndAsn(
    ip,
    geoSource(c.req.raw.headers, cfOf(c)),
  );
  const record = payload
    ? identifyRecord(payload, {
        projectId,
        geo,
        ua: c.req.header('user-agent'),
      })
    : null;
  if (!record) {
    return c.json(
      {
        status: 400,
        error: 'Bad Request',
        message: 'body/profileId is required',
      },
      400,
    );
  }
  await enqueueRecords(c.env.EVENTS_QUEUE, projectId, [record]);
  return c.text(String(payload?.profileId), 202);
});

async function adjustProfile(c: Context<AppEnv>, direction: 1 | -1) {
  const body = c.get('body') as DeprecatedIncrementProfilePayload | null;
  const projectId = c.get('client')?.projectId;
  if (!projectId) {
    return c.text('No projectId', 400);
  }
  if (!(body?.profileId && typeof body.property === 'string')) {
    return c.json(
      {
        status: 400,
        error: 'Bad Request',
        message: 'body/profileId and body/property are required',
      },
      400,
    );
  }
  const profileId = String(body.profileId);
  const properties = await getProfileProperties(projectId, profileId);
  if (!properties) {
    return c.text('Not found', 404);
  }
  const parsed = Number.parseInt(
    pathOr<string>('0', body.property.split('.'), properties),
    10,
  );
  if (Number.isNaN(parsed)) {
    return c.text('Not number', 400);
  }
  const value = Number(body.value);
  await enqueueRecords(c.env.EVENTS_QUEUE, projectId, [
    {
      type: 'profile_op',
      id: uuidv7(),
      projectId,
      profileId,
      property: body.property,
      delta: direction * (Number.isFinite(value) ? value : 0),
    },
  ]);
  return c.text(profileId, 202);
}

profileRoutes.post('/increment', (c) => adjustProfile(c, 1));
profileRoutes.post('/decrement', (c) => adjustProfile(c, -1));
