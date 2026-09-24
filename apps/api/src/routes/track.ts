import { parseUserAgent, uuidv7 } from '@openpanel/common/server';
import { insertReplayChunk } from '@openpanel/db/src/analytics/writers';
import { withDbRoute } from '@openpanel/db/src/db-routing';
import type {
  IngestRecord,
  ProfileOpRecord,
} from '@openpanel/db/src/ingest/envelope';
import { getProfileProperties } from '@openpanel/db/src/ingest/profiles';
import { getSessionTimeoutMs } from '@openpanel/db/src/ingest/session-machine';
import { trackLookup } from '@openpanel/db/src/ingest/track-lookup';
import type { IServiceClientWithProject } from '@openpanel/db/src/services/clients.service';
import { matchEvent } from '@openpanel/db/src/services/event-match';
import type { ILogger } from '@openpanel/logger';
import {
  type IDecrementPayload,
  type IIncrementPayload,
  type IProjectFilterEvent,
  type IReplayPayload,
  type ITrackPayload,
  zTrackHandlerPayload,
} from '@openpanel/validation';
import { Hono } from 'hono';
import { pathOr } from 'ramda';
import { z } from 'zod';

import { applyBotSuspicion } from '@/bots/suspicion';
import { documentRoute } from '@/compat/fastify';
import type { AppEnv } from '@/env';
import { validate } from '@/ingest/body';
import {
  type TrackContext,
  geoSource,
  getCandidateDeviceIds,
  getDedupeHash,
  getGeoAndAsn,
  getIdentity,
  getOverrideDeviceId,
  getSdkHeaders,
  getTimestamp,
  resolveDevice,
} from '@/ingest/context';
import { normalizeEvent } from '@/ingest/normalize';
import { enqueueRecords } from '@/ingest/queue';
import { detachedKind, eventRecord, identifyRecord } from '@/ingest/records';
import { botFilter, sdkClient } from '@/middleware/sdk';
import { HttpError } from '@/utils/errors';

const zTrackBody = zTrackHandlerPayload.and(
  z.object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
  }),
);

/** Project exclusion filters apply before anything session related. */
export function isExcludedByProject(
  event: Parameters<typeof matchEvent>[0],
  client: IServiceClientWithProject,
): boolean {
  const filters = (client.project?.filters ?? []).filter(
    (filter): filter is IProjectFilterEvent => filter.type === 'event',
  );
  return filters.some((filter) => matchEvent(event, filter));
}

function trackRecords(
  payload: ITrackPayload,
  context: TrackContext,
  client: IServiceClientWithProject,
  rawUserAgent: string | undefined,
  logger: ILogger,
): IngestRecord[] {
  const uaInfo = parseUserAgent(rawUserAgent, payload.properties);
  // Mark (never block) likely bot traffic with __bot / __bot_reasons.
  payload.properties = applyBotSuspicion(payload.properties, {
    asnInfo: context.asnInfo,
    headers: context.requestHeaders,
    clientSecretAuth: context.clientSecretAuth,
    isServer: uaInfo.isServer,
  });

  const records: IngestRecord[] = [];
  // More than a profile id in the identity: identify the profile too.
  if (context.identity && Object.keys(context.identity).length > 1) {
    const profile = identifyRecord(context.identity, context);
    if (profile) {
      records.push(profile);
    }
  }

  const event = normalizeEvent({
    projectId: context.projectId,
    deviceId: context.deviceId,
    sessionId: context.sessionId,
    event: { ...payload, groups: payload.groups ?? [] },
    timestamp: context.timestamp.value,
    sdkName: context.sdkName,
    sdkVersion: context.sdkVersion,
    geo: context.geo,
    uaInfo,
  });
  const detached = detachedKind({
    isServer: uaInfo.isServer,
    isFromPast: context.timestamp.isFromPast,
  });

  // Detached events are filtered by the consumer once they carry their
  // session's fields, like the old worker did.
  if (!detached && isExcludedByProject(event, client)) {
    logger.info(
      { event: event.name, projectId: context.projectId },
      'Skipping session_start and event (excluded by project filter)',
    );
    return records;
  }

  records.push(eventRecord(event, detached));
  return records;
}

/**
 * Increments are applied by the consumer, but the SDK still gets the old
 * 404 / 400 answers when the profile or the value doesn't allow one.
 */
async function profileOpRecord(
  payload: IIncrementPayload | IDecrementPayload,
  projectId: string,
  direction: 1 | -1,
): Promise<ProfileOpRecord> {
  const profileId = String(payload.profileId);
  const properties = await getProfileProperties(projectId, profileId);
  if (!properties) {
    throw new HttpError('Profile not found', { status: 404 });
  }
  const parsed = Number.parseInt(
    pathOr<string>('0', payload.property.split('.'), properties),
    10,
  );
  if (Number.isNaN(parsed)) {
    throw new HttpError('Property value is not a number', { status: 400 });
  }
  return {
    type: 'profile_op',
    id: uuidv7(),
    projectId,
    profileId,
    property: payload.property,
    delta: direction * (payload.value || 1),
  };
}

/**
 * Replay chunks (up to 2 MB) don't fit in a queue message: they're written
 * straight to Postgres on the direct route. The SDK echoes the session id a
 * previous /track response gave it.
 */
async function insertReplay(
  payload: IReplayPayload,
  projectId: string,
  sessionId: string,
) {
  if (!sessionId) {
    throw new HttpError('Session ID is required for replay', { status: 400 });
  }
  await withDbRoute('replayInsert', () =>
    insertReplayChunk({
      project_id: projectId,
      session_id: sessionId,
      chunk_index: payload.chunk_index,
      started_at: payload.started_at,
      ended_at: payload.ended_at,
      events_count: payload.events_count,
      is_full_snapshot: payload.is_full_snapshot,
      payload: payload.payload,
    }),
  );
}

export const trackRoutes = new Hono<AppEnv>();

documentRoute({
  method: 'POST',
  path: '/track',
  schema: {
    tags: ['Track'],
    description:
      'Ingest a tracking event (track, identify, group, increment, decrement, replay).',
    body: zTrackBody,
    response: {
      200: z.object({ deviceId: z.string(), sessionId: z.string() }),
    },
  },
});
documentRoute({
  method: 'GET',
  path: '/track/device-id',
  schema: {
    tags: ['Track'],
    description:
      'Get or generate a stable device ID and session ID for the current visitor.',
    response: {
      200: z.object({
        deviceId: z.string(),
        sessionId: z.string(),
        message: z.string().optional(),
      }),
    },
  },
});

trackRoutes.use(sdkClient, botFilter);

trackRoutes.post('/', async (c) => {
  const rawBody = c.get('body');
  const body = validate(zTrackBody, rawBody);

  if (body.type === 'alias') {
    return c.json(
      { status: 400, error: 'Bad Request', message: 'Alias is not supported' },
      400,
    );
  }

  const client = c.get('client')!;
  const projectId = client.projectId;
  if (!projectId) {
    throw new HttpError('Missing projectId', { status: 400 });
  }

  const headers = c.req.raw.headers;
  const clientIp = c.get('clientIp');
  const { timestamp, isTimestampFromThePast } = getTimestamp(
    c.get('timestamp'),
    body.payload,
  );
  const ipOverride =
    body.type === 'track' ? body.payload.properties?.__ip : undefined;
  const ip = typeof ipOverride === 'string' && ipOverride ? ipOverride : clientIp;
  const rawUserAgent = c.req.header('user-agent');
  const ua = rawUserAgent ?? 'unknown/1.0';

  const identity = getIdentity(body);
  if (identity?.profileId && body.type === 'track') {
    body.payload.profileId = identity.profileId;
  }

  const [{ geo, asnInfo }, deviceIds] = await Promise.all([
    getGeoAndAsn(
      ip,
      geoSource(headers, c.req.raw.cf as Parameters<typeof geoSource>[1]),
    ),
    getCandidateDeviceIds({
      projectId,
      ip,
      ua,
      overrideDeviceId: getOverrideDeviceId(body),
    }),
  ]);

  const device = await resolveDevice({
    projectId,
    deviceIds,
    eventTimeMs: timestamp,
    dedupeHash:
      body.type === 'replay'
        ? null
        : getDedupeHash({
            body: rawBody,
            ip: clientIp,
            origin: c.req.header('origin'),
            clientIdHeader: c.req.header('openpanel-client-id'),
          }),
  });
  if (device.duplicate) {
    return c.text('Duplicate event', 200);
  }

  const context: TrackContext = {
    projectId,
    ip,
    ua,
    requestHeaders: Object.fromEntries(headers),
    ...getSdkHeaders(headers),
    clientSecretAuth: c.get('clientSecretAuth') ?? false,
    timestamp: { value: timestamp, isFromPast: isTimestampFromThePast },
    identity,
    deviceId: device.deviceId,
    sessionId: device.sessionId,
    geo,
    asnInfo,
  };

  const records: IngestRecord[] = [];
  switch (body.type) {
    case 'track':
      records.push(
        ...trackRecords(
          body.payload,
          context,
          client,
          rawUserAgent,
          c.get('logger'),
        ),
      );
      break;
    case 'identify': {
      const profile = identifyRecord(body.payload, context);
      if (profile) {
        records.push(profile);
      }
      break;
    }
    case 'increment':
      records.push(await profileOpRecord(body.payload, projectId, 1));
      break;
    case 'decrement':
      records.push(await profileOpRecord(body.payload, projectId, -1));
      break;
    case 'replay':
      await insertReplay(
        body.payload,
        projectId,
        body.payload.sessionId || context.sessionId,
      );
      break;
    case 'group':
      records.push({
        type: 'group',
        id: uuidv7(),
        group: {
          id: body.payload.id,
          projectId,
          type: body.payload.type,
          name: body.payload.name,
          properties: body.payload.properties ?? {},
        },
      });
      break;
    case 'assign_group': {
      const profileId = body.payload.profileId ?? context.deviceId;
      if (profileId) {
        records.push({
          type: 'profile',
          id: uuidv7(),
          profile: {
            id: String(profileId),
            projectId,
            isExternal: Boolean(body.payload.profileId),
            groups: body.payload.groupIds,
          },
        });
      }
      break;
    }
    default:
      return c.json(
        { status: 400, error: 'Bad Request', message: 'Invalid type' },
        400,
      );
  }

  await enqueueRecords(c.env.EVENTS_QUEUE, projectId, records);

  return c.json({ deviceId: context.deviceId, sessionId: context.sessionId });
});

trackRoutes.get('/device-id', async (c) => {
  const projectId = c.get('client')?.projectId;
  if (!projectId) {
    return c.text('No projectId', 400);
  }
  const ip = c.get('clientIp');
  if (!ip) {
    return c.text('Missing ip address', 400);
  }
  const ua = c.req.header('user-agent');
  if (!ua) {
    return c.text('Missing header: user-agent', 400);
  }

  const deviceIds = await getCandidateDeviceIds({ projectId, ip, ua });
  try {
    const { sessions } = await trackLookup({ projectId, deviceIds });
    const now = Date.now();
    const timeoutMs = getSessionTimeoutMs();
    for (const [index, deviceId] of deviceIds.entries()) {
      const session = sessions.find((item) => item.deviceId === deviceId);
      // Only a session within its idle window is current; otherwise the SDK
      // should let the next event start a fresh one.
      if (session && now - session.endedAt.getTime() < timeoutMs) {
        return c.json({
          deviceId,
          sessionId: session.sessionId,
          message:
            index === 0
              ? 'current session exists for this device id'
              : 'previous session exists for this device id',
        });
      }
    }
  } catch (error) {
    c.get('logger').error(
      { err: error },
      'Error getting session end GET /track/device-id',
    );
  }

  return c.json({
    deviceId: deviceIds[0] ?? '',
    sessionId: '',
    message: 'No session exists for this device id',
  });
});
