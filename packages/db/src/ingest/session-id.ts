import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { getSessionTimeoutMs } from './session-machine';

/**
 * Deterministic session id for (projectId, deviceId) within a time window,
 * with a grace period at the *start* of each window to avoid boundary
 * splits. Output: base64url of the first `bytes` of a SHA-256.
 *
 * Byte-for-byte the id the Node API minted (it used node:crypto), so ids
 * stay stable across the move.
 */
export function getSessionId(params: {
  projectId: string;
  deviceId: string;
  eventMs?: number;
  windowMs?: number;
  graceMs?: number;
  bytes?: number;
}): string {
  const {
    projectId,
    deviceId,
    eventMs = Date.now(),
    windowMs = 5 * 60 * 1000,
    graceMs = 60 * 1000,
    bytes = 16,
  } = params;

  if (!projectId) {
    throw new Error('projectId is required');
  }
  if (!deviceId) {
    throw new Error('deviceId is required');
  }
  if (windowMs <= 0) {
    throw new Error('windowMs must be > 0');
  }
  if (graceMs < 0 || graceMs >= windowMs) {
    throw new Error('graceMs must be >= 0 and < windowMs');
  }
  if (bytes < 8 || bytes > 32) {
    throw new Error('bytes must be between 8 and 32');
  }

  const bucket = Math.floor(eventMs / windowMs);
  const offset = eventMs - bucket * windowMs;
  // Grace at the start of the bucket: stick to the previous bucket.
  const chosenBucket = offset < graceMs ? bucket - 1 : bucket;

  const digest = sha256(utf8ToBytes(`sess:v1:${projectId}:${deviceId}:${chosenBucket}`));
  let binary = '';
  for (const byte of digest.subarray(0, bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * The id for a device's first event of a session: the bucket window tracks
 * the idle timeout, so a gap longer than the timeout lands in a new bucket
 * and a boundary mints a fresh id.
 */
export function getBucketSessionId(params: {
  projectId: string;
  deviceId: string;
  eventMs: number;
}): string {
  const timeoutMs = getSessionTimeoutMs();
  return getSessionId({
    ...params,
    windowMs: timeoutMs,
    graceMs: Math.min(5_000, Math.floor(timeoutMs / 6)),
  });
}
