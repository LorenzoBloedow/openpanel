import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { IServiceCreateEventPayload } from '../services/event.service';
import { getSessionId } from './session-id';
import { applyEventToSession, fromSessionDate } from './session-machine';

const projectId = 'project-1';
const deviceId = 'device-1';
const TIMEOUT = 30 * 60 * 1000;

function makePayload(
  overrides: Partial<IServiceCreateEventPayload> = {},
): IServiceCreateEventPayload {
  return {
    name: 'screen_view',
    projectId,
    deviceId,
    sessionId: 'session-1',
    profileId: 'profile-1',
    properties: {},
    groups: [],
    createdAt: new Date('2026-06-08T12:00:00.000Z'),
    duration: 0,
    sdkName: 'web',
    sdkVersion: '1.0.0',
    city: '',
    country: '',
    region: '',
    longitude: 0,
    latitude: 0,
    path: '/home',
    origin: '',
    referrer: '',
    referrerName: '',
    referrerType: '',
    os: '',
    osVersion: '',
    browser: '',
    browserVersion: '',
    device: '',
    brand: '',
    model: '',
    ...overrides,
  };
}

const at = (minutes: number) => new Date(Date.UTC(2026, 5, 8, 12, 0) + minutes * 60_000);

describe('session state machine', () => {
  it('opens a new session for the first event', () => {
    const result = applyEventToSession(null, makePayload(), TIMEOUT);
    expect(result?.kind).toBe('new');
    expect(result?.current).toMatchObject({
      id: 'session-1',
      project_id: projectId,
      device_id: deviceId,
      profile_id: 'profile-1',
      is_bounce: true,
      screen_view_count: 1,
      event_count: 0,
      version: 1,
    });
  });

  it('ignores session signals and events without a device', () => {
    expect(applyEventToSession(null, makePayload({ name: 'session_start' }), TIMEOUT)).toBeNull();
    expect(applyEventToSession(null, makePayload({ name: 'session_end' }), TIMEOUT)).toBeNull();
    expect(applyEventToSession(null, makePayload({ deviceId: '' }), TIMEOUT)).toBeNull();
  });

  it('invariant: one visit keeps one id across extends; a >30min gap splits and closes the first', () => {
    let state = applyEventToSession(null, makePayload({ createdAt: at(0), sessionId: 'S1' }), TIMEOUT)!;
    expect(state.kind).toBe('new');
    for (const minutes of [10, 20]) {
      state = applyEventToSession(state.current, makePayload({ createdAt: at(minutes), sessionId: 'S1' }), TIMEOUT)!;
      expect(state.kind).toBe('extend');
      expect(state.current.id).toBe('S1');
    }
    expect(state.current.version).toBe(3);
    expect(state.current.is_bounce).toBe(false);

    const boundary = applyEventToSession(state.current, makePayload({ createdAt: at(55), sessionId: 'S2' }), TIMEOUT)!;
    expect(boundary.kind).toBe('boundary');
    if (boundary.kind === 'boundary') {
      expect(boundary.closed.id).toBe('S1');
      expect(boundary.current.id).toBe('S2');
    }
  });

  it('inherits utm_* fields from properties.__query', () => {
    const result = applyEventToSession(
      null,
      makePayload({
        properties: { __query: { utm_medium: 'cpc', utm_source: 'google', utm_campaign: 'spring' } },
      }),
      TIMEOUT,
    );
    expect(result?.current).toMatchObject({ utm_medium: 'cpc', utm_source: 'google', utm_campaign: 'spring' });
  });

  it('out-of-order events widen the window backwards, never a negative duration', () => {
    const first = applyEventToSession(null, makePayload({ createdAt: at(10), path: '/b' }), TIMEOUT)!;
    const late = applyEventToSession(first.current, makePayload({ createdAt: at(9), path: '/a' }), TIMEOUT)!;
    expect(late.kind).toBe('extend');
    expect(late.current.duration).toBe(60_000);
    expect(late.current.entry_path).toBe('/a');
    expect(late.current.exit_path).toBe('/b');
    expect(fromSessionDate(late.current.created_at)).toEqual(at(9));
  });

  it('counts revenue, stitches profiles and unions groups', () => {
    const first = applyEventToSession(null, makePayload({ profileId: deviceId, groups: ['a'] }), TIMEOUT)!;
    expect(first.current.profile_id).toBe(deviceId);
    const next = applyEventToSession(
      first.current,
      makePayload({ name: 'revenue', revenue: 1999, profileId: 'user-1', groups: ['b'], createdAt: at(1) }),
      TIMEOUT,
    )!;
    expect(next.current).toMatchObject({
      revenue: 1999,
      event_count: 1,
      screen_view_count: 1,
      profile_id: 'user-1',
      groups: ['a', 'b'],
    });
  });
});

describe('getSessionId', () => {
  // The Node API's implementation (apps/api/src/utils/ids.ts before the move).
  function nodeSessionId(projectId: string, deviceId: string, eventMs: number, windowMs: number, graceMs: number) {
    const bucket = Math.floor(eventMs / windowMs);
    const offset = eventMs - bucket * windowMs;
    const chosen = offset < graceMs ? bucket - 1 : bucket;
    return createHash('sha256')
      .update(`sess:v1:${projectId}:${deviceId}:${chosen}`)
      .digest()
      .subarray(0, 16)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  it('matches the ids the Node API minted', () => {
    for (const eventMs of [0, 1_700_000_000_000, 1_700_000_002_000, Date.UTC(2026, 2, 29, 1, 0)]) {
      expect(getSessionId({ projectId: 'p', deviceId: 'd', eventMs, windowMs: TIMEOUT, graceMs: 5000 })).toBe(
        nodeSessionId('p', 'd', eventMs, TIMEOUT, 5000),
      );
    }
  });
});
