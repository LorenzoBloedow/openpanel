import {
  Arctic,
  COOKIE_OPTIONS,
  type OAuth2Tokens,
  createSession,
  generateSessionToken,
  github,
  google,
  googleGsc,
  setLastAuthProviderCookie,
  setSessionTokenCookie,
} from '@openpanel/auth';
import { type Account, connectUserToOrganization, db, encrypt, getIsRegistrationAllowed } from '@openpanel/db';
import type { ILogger } from '@openpanel/logger';
import type { ISetCookie } from '@openpanel/validation';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';

import type { AppEnv } from '@/env';
import { createSetCookie, unsignCookieValue } from '@/utils/cookies';
import { LogError } from '@/utils/errors';

/**
 * OAuth callbacks: sign-in with GitHub / Google, and the Google Search
 * Console connection. Both end in a redirect to the dashboard.
 */

type Provider = 'github' | 'google';

interface OAuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName?: string;
}

const zCallbackQuery = z.object({ code: z.string(), state: z.string() });

/** A redirect carrying the Set-Cookie headers `write` produced. */
function redirectWithCookies(
  c: Context<AppEnv>,
  location: string,
  write: (setCookie: ISetCookie) => void,
) {
  const headers = new Headers({ Location: location });
  write(createSetCookie(headers, c.env.COOKIE_SECRET));
  return new Response(null, { status: 302, headers });
}

function clearCookies(setCookie: ISetCookie, names: string[]) {
  for (const name of names) {
    setCookie(name, '', { maxAge: 0, ...COOKIE_OPTIONS });
  }
}

function dashboardUrl(env: Env): string {
  return env.DASHBOARD_URL;
}

function errorRedirect(
  c: Context<AppEnv>,
  error: unknown,
  fallback: string,
  clear: string[],
) {
  const url = new URL(dashboardUrl(c.env));
  url.pathname = '/login';
  url.searchParams.set(
    'error',
    error instanceof LogError ? error.message : fallback,
  );
  url.searchParams.set('correlationId', c.get('requestId'));
  return redirectWithCookies(c, url.toString(), (setCookie) =>
    clearCookies(setCookie, clear),
  );
}

async function getGithubEmail(accessToken: string) {
  const response = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'OpenPanel',
    },
  });
  const result: unknown = await response.json();
  if (!Array.isArray(result) || result.length < 1) {
    return null;
  }
  const zEmail = z.object({
    primary: z.boolean(),
    verified: z.boolean(),
    email: z.string(),
  });
  let email: string | null = null;
  for (const record of result) {
    const parsed = zEmail.safeParse(record);
    if (parsed.success && parsed.data.primary && parsed.data.verified) {
      email = parsed.data.email;
    }
  }
  return email;
}

async function fetchGithubUser(accessToken: string): Promise<OAuthUser> {
  const email = await getGithubEmail(accessToken);
  if (!email) {
    throw new LogError('GitHub email not found or not verified');
  }
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'OpenPanel',
    },
  });
  const json = await response.json();
  const parsed = z
    .object({
      id: z.number(),
      login: z.string(),
      name: z
        .string()
        .nullish()
        .transform((value) => value || ''),
    })
    .safeParse(json);
  if (!parsed.success) {
    throw new LogError('Error fetching Github user', {
      error: parsed.error,
      githubUser: json,
    });
  }
  return {
    id: String(parsed.data.id),
    email,
    firstName: parsed.data.name || parsed.data.login || '',
  };
}

function fetchGoogleUser(tokens: OAuth2Tokens): OAuthUser {
  const claims = Arctic.decodeIdToken(tokens.idToken());
  const parsed = z
    .object({
      sub: z.string(),
      email: z.string(),
      email_verified: z.boolean(),
      given_name: z.string().optional(),
      family_name: z.string().optional(),
    })
    .safeParse(claims);
  if (!parsed.success) {
    throw new LogError('Error fetching Google user', {
      error: parsed.error,
      claims,
    });
  }
  if (!parsed.data.email_verified) {
    throw new LogError('Email not verified with Google');
  }
  return {
    id: parsed.data.sub,
    email: parsed.data.email,
    firstName: parsed.data.given_name || '',
    lastName: parsed.data.family_name || '',
  };
}

function validateCallback(c: Context<AppEnv>, provider: Provider) {
  const query = zCallbackQuery.safeParse(c.req.query());
  if (!query.success) {
    throw new LogError('Invalid callback query params', {
      error: query.error,
      provider,
    });
  }
  const { code, state } = query.data;
  const storedState = getCookie(c, `${provider}_oauth_state`) ?? null;
  const codeVerifier =
    provider === 'google' ? (getCookie(c, 'google_code_verifier') ?? null) : null;
  if (storedState === null || (provider === 'google' && codeVerifier === null)) {
    throw new LogError('Missing oauth parameters', {
      storedState: storedState === null,
      codeVerifier: provider === 'google' ? codeVerifier === null : undefined,
      provider,
    });
  }
  if (state !== storedState) {
    throw new LogError('OAuth state mismatch', { provider });
  }
  return { code, codeVerifier };
}

/** Sign an OAuth user in (linking or creating the account) and redirect. */
async function signIn(
  c: Context<AppEnv>,
  {
    oauthUser,
    provider,
    account,
    clear,
  }: {
    oauthUser: OAuthUser;
    provider: Provider;
    account: Account | null;
    clear: string[];
  },
) {
  const logger: ILogger = c.get('logger');
  const inviteId = getCookie(c, 'inviteId') ?? null;
  let userId: string;

  if (account) {
    await db.account.update({
      where: { id: account.id },
      data: {
        provider,
        providerId: oauthUser.id,
        email: oauthUser.email,
      },
    });
    userId = account.userId;
    if (inviteId) {
      try {
        const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
        await connectUserToOrganization({ user, inviteId });
      } catch (error) {
        logger.error(
          { err: error, inviteId, userId },
          'error connecting existing user to organization',
        );
      }
    }
  } else {
    const existingUser = await db.user.findFirst({
      where: { email: oauthUser.email },
    });
    if (existingUser) {
      throw new LogError(
        'Please sign in using your original authentication method',
        { providerName: provider },
      );
    }
    // The registration policy applies here, the first point where we know
    // the user is new, so returning users are never caught by it.
    if (!(await getIsRegistrationAllowed(inviteId))) {
      throw new LogError('Registrations are not allowed', {
        providerName: provider,
        inviteId,
      });
    }
    const user = await db.user.create({
      data: {
        email: oauthUser.email,
        firstName: oauthUser.firstName,
        lastName: oauthUser.lastName,
        accounts: { create: { provider, providerId: oauthUser.id } },
      },
    });
    userId = user.id;
    if (inviteId) {
      try {
        await connectUserToOrganization({ user, inviteId });
      } catch (error) {
        logger.error(
          { err: error, inviteId, userId },
          'error connecting user to organization',
        );
      }
    }
  }

  const sessionToken = generateSessionToken();
  const session = await createSession(sessionToken, userId);
  return redirectWithCookies(c, dashboardUrl(c.env), (setCookie) => {
    clearCookies(setCookie, clear);
    setSessionTokenCookie(setCookie, sessionToken, session.expiresAt);
    setLastAuthProviderCookie(setCookie, provider);
  });
}

export const oauthRoutes = new Hono<AppEnv>();

oauthRoutes.get('/github/callback', async (c) => {
  const clear = ['github_oauth_state'];
  try {
    const { code } = validateCallback(c, 'github');
    const tokens = await github.validateAuthorizationCode(code);
    const oauthUser = await fetchGithubUser(tokens.accessToken());
    const account = await db.account.findFirst({
      where: {
        OR: [
          { provider: 'github', providerId: oauthUser.id },
          // Accounts from before provider ids were stored.
          { provider: 'github', providerId: null, email: oauthUser.email },
          { provider: 'oauth', user: { email: oauthUser.email } },
        ],
      },
    });
    return await signIn(c, { oauthUser, provider: 'github', account, clear });
  } catch (error) {
    c.get('logger').error({ err: error }, 'GitHub OAuth callback error');
    return errorRedirect(c, error, 'An error occurred', clear);
  }
});

oauthRoutes.get('/google/callback', async (c) => {
  const clear = ['google_code_verifier', 'google_oauth_state'];
  try {
    const { code, codeVerifier } = validateCallback(c, 'google');
    const tokens = await google.validateAuthorizationCode(code, codeVerifier!);
    const oauthUser = fetchGoogleUser(tokens);
    const account = await db.account.findFirst({
      where: {
        OR: [
          { provider: 'google', providerId: oauthUser.id },
          { provider: 'google', providerId: null, email: oauthUser.email },
          { provider: 'oauth', user: { email: oauthUser.email } },
        ],
      },
    });
    return await signIn(c, { oauthUser, provider: 'google', account, clear });
  } catch (error) {
    c.get('logger').error({ err: error }, 'Google OAuth callback error');
    return errorRedirect(c, error, 'An error occurred', clear);
  }
});

const GSC_COOKIES = ['gsc_oauth_state', 'gsc_code_verifier', 'gsc_project_id'];

export const gscCallbackRoutes = new Hono<AppEnv>();

/** Google Search Console connection: stores the (encrypted) tokens. */
gscCallbackRoutes.get('/callback', async (c) => {
  try {
    const query = zCallbackQuery.safeParse(c.req.query());
    if (!query.success) {
      throw new LogError('Invalid GSC callback query params');
    }
    const { code, state } = query.data;
    const [storedState, codeVerifier, projectId] = GSC_COOKIES.map((name) => {
      const raw = getCookie(c, name);
      return raw ? unsignCookieValue(raw, c.env.COOKIE_SECRET) : null;
    });
    if (!(storedState?.value && codeVerifier?.value && projectId?.value)) {
      throw new LogError('Missing GSC OAuth cookies', {
        storedState: !storedState?.value,
        codeVerifier: !codeVerifier?.value,
        projectId: !projectId?.value,
      });
    }
    if (state !== storedState.value) {
      throw new LogError('GSC OAuth state mismatch', { stateMismatch: true });
    }

    const tokens = await googleGsc.validateAuthorizationCode(
      code,
      codeVerifier.value,
    );
    const accessToken = tokens.accessToken();
    const refreshToken = tokens.hasRefreshToken() ? tokens.refreshToken() : null;
    const accessTokenExpiresAt = tokens.accessTokenExpiresAt();
    if (!refreshToken) {
      throw new LogError('No refresh token returned from Google GSC OAuth');
    }

    const project = await db.project.findUnique({
      where: { id: projectId.value },
      select: { id: true, organizationId: true },
    });
    if (!project) {
      throw new LogError('Project not found for GSC connection', {
        projectId: projectId.value,
      });
    }

    await db.gscConnection.upsert({
      where: { projectId: project.id },
      create: {
        projectId: project.id,
        accessToken: encrypt(accessToken),
        refreshToken: encrypt(refreshToken),
        accessTokenExpiresAt,
        siteUrl: '',
      },
      update: {
        accessToken: encrypt(accessToken),
        refreshToken: encrypt(refreshToken),
        accessTokenExpiresAt,
        lastSyncStatus: null,
        lastSyncError: null,
      },
    });

    return redirectWithCookies(
      c,
      `${dashboardUrl(c.env)}/${project.organizationId}/${project.id}/settings/gsc`,
      (setCookie) => clearCookies(setCookie, GSC_COOKIES),
    );
  } catch (error) {
    c.get('logger').error({ err: error }, 'GSC OAuth callback error');
    return errorRedirect(
      c,
      error,
      'Failed to connect Google Search Console',
      GSC_COOKIES,
    );
  }
});
