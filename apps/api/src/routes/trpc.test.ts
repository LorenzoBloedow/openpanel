/**
 * The dashboard's tRPC API over HTTP (fetch adapter): session cookies in
 * and out, POSTed queries (method override), auth errors and the escalating
 * sign-in lockout.
 */
import {
  type TestDatabase,
  createTestDatabase,
} from '@openpanel/db/src/testing/database';
import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type App, createApp } from '@/app';

let testDb: TestDatabase;
let app: App;

function env() {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: testDb.url,
    HYPERDRIVE: { connectionString: testDb.url },
    COOKIE_SECRET: 'test-cookie-secret',
    DASHBOARD_URL: 'http://localhost:3000',
  } as unknown as Env;
}

async function call(
  path: string,
  input: unknown,
  { cookie, ip = '203.0.113.20' }: { cookie?: string; ip?: string } = {},
) {
  const environment = env();
  const res = await runWithScope({ env: environment, route: 'hyperdrive' }, () =>
    app.request(
      `/trpc/${path}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          'cf-connecting-ip': ip,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({ json: input }),
      },
      environment,
    ),
  );
  const body = (await res.json()) as {
    result?: { data: { json: unknown } };
    error?: { json: { message: string; data: { code: string } } };
  };
  return { res, body };
}

function sessionCookie(res: Response): string {
  const header = res.headers
    .getSetCookie()
    .find((value) => value.startsWith('session='));
  if (!header) {
    throw new Error('no session cookie in the response');
  }
  return header.split(';')[0]!;
}

beforeAll(async () => {
  app = await createApp();
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

describe('/trpc', () => {
  const email = 'ada@example.com';
  const password = 'correct horse battery staple';

  it('signs up, sets the session cookie and answers POSTed queries', async () => {
    const signUp = await call('auth.signUpEmail', {
      email,
      password,
      confirmPassword: password,
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    expect(signUp.res.status).toBe(200);
    const cookieHeader = signUp.res.headers
      .getSetCookie()
      .find((value) => value.startsWith('session='))!;
    expect(cookieHeader).toMatch(/HttpOnly/);
    expect(cookieHeader).toMatch(/SameSite=Lax/);
    expect(cookieHeader).toMatch(/Path=\//);

    const session = await call('auth.session', undefined, {
      cookie: sessionCookie(signUp.res),
    });
    expect(session.res.status).toBe(200);
    expect(session.body.result?.data.json).toMatchObject({
      user: { email },
    });
  });

  it('rejects protected procedures without a session', async () => {
    const { res, body } = await call('auth.totpStatus', undefined);
    expect(res.status).toBe(401);
    expect(body.error?.json.data.code).toBe('UNAUTHORIZED');
  });

  it('signs in with the password', async () => {
    const { res } = await call('auth.signInEmail', { email, password });
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    const session = await call('auth.session', undefined, { cookie });
    expect(session.body.result?.data.json).toMatchObject({ user: { email } });
  });

  it('locks out an IP that keeps guessing', async () => {
    const ip = '203.0.113.99';
    const statuses: number[] = [];
    // auth.signInEmail allows 3 attempts per window.
    for (let attempt = 0; attempt < 5; attempt++) {
      const { res } = await call(
        'auth.signInEmail',
        { email, password: 'wrong password' },
        { ip },
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3).every((status) => status !== 429)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429]);

    // Another IP can still sign in.
    const { res } = await call(
      'auth.signInEmail',
      { email, password },
      { ip: '203.0.113.100' },
    );
    expect(res.status).toBe(200);
  });
});
