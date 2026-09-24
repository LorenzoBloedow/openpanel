import { createHmac, timingSafeEqual } from 'node:crypto';
import { COOKIE_OPTIONS } from '@openpanel/auth';
import type { ISetCookie } from '@openpanel/validation';
import { type CookieOptions, serialize } from 'hono/utils/cookie';

/**
 * Signed cookies in @fastify/cookie's format (`value.base64(hmac-sha256)`,
 * padding stripped), so cookies set before the move keep verifying.
 */
export function signCookieValue(value: string, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(value)
    .digest('base64')
    .replace(/=+$/, '');
  return `${value}.${signature}`;
}

/** The value of a signed cookie, or null when the signature doesn't match. */
export function unsignCookieValue(
  signed: string,
  secret: string,
): { valid: boolean; value: string | null } {
  const index = signed.lastIndexOf('.');
  if (index <= 0) {
    return { valid: false, value: null };
  }
  const value = signed.slice(0, index);
  const expected = Buffer.from(signCookieValue(value, secret));
  const actual = Buffer.from(signed);
  const valid =
    expected.length === actual.length && timingSafeEqual(expected, actual);
  return valid ? { valid: true, value } : { valid: false, value: null };
}

type SetCookieOptions = Parameters<ISetCookie>[2];

function toSameSite(
  value: SetCookieOptions['sameSite'],
): CookieOptions['sameSite'] {
  switch (value) {
    case 'strict':
      return 'Strict';
    case 'none':
      return 'None';
    case 'lax':
      return 'Lax';
    default:
      return undefined;
  }
}

/**
 * The `setCookie` the tRPC context hands to procedures: appends a
 * Set-Cookie header, with the dashboard's COOKIE_OPTIONS (domain, secure,
 * sameSite, httpOnly, path) always applied, as the Fastify context did.
 */
export function createSetCookie(headers: Headers, secret: string): ISetCookie {
  return (key, value, options) => {
    const merged = { ...options, ...COOKIE_OPTIONS };
    const cookieValue = options.signed ? signCookieValue(value, secret) : value;
    headers.append(
      'Set-Cookie',
      serialize(key, cookieValue, {
        maxAge: merged.maxAge,
        domain: merged.domain,
        path: merged.path,
        secure: merged.secure,
        httpOnly: merged.httpOnly,
        sameSite: toSameSite(merged.sameSite),
      }),
    );
  };
}
