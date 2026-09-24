import type { SessionValidationResult } from '@openpanel/auth';
import type { IServiceClientWithProject } from '@openpanel/db/src/services/clients.service';
import type { ILogger } from '@openpanel/logger';

/**
 * Secrets and optional vars `wrangler types` can't see (they live in
 * `wrangler secret put` / .dev.vars). Merged into the generated Env.
 */
interface OpenPanelSecrets {
  /** Neon's pooled endpoint: the direct (non-Hyperdrive) route. */
  DATABASE_URL: string;
  COOKIE_SECRET: string;
  ENCRYPTION_KEY: string;
  SESSION_TIMEOUT_MS?: string;
  /** Comma-separated client ids whose requests log IPs and user agents. */
  ENABLE_VERBOSE_LOGGING?: string;
  API_CORS_ORIGINS?: string;
  DEMO_USER_ID?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_REDIRECT_URI?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GSC_GOOGLE_REDIRECT_URI?: string;
  ALLOW_REGISTRATION?: string;
  ALLOW_INVITATION?: string;
}

// `wrangler types` declares both the global Env and Cloudflare.Env.
declare global {
  interface Env extends OpenPanelSecrets {}
  // biome-ignore lint/style/noNamespace: augments the generated declaration
  namespace Cloudflare {
    interface Env extends OpenPanelSecrets {}
  }
}

/** Per-request values the middleware puts on the Hono context. */
export interface AppVariables {
  requestId: string;
  /** Receive time (ms): event timestamps are validated against it. */
  timestamp: number;
  clientIp: string;
  clientIpHeader: string;
  logger: ILogger;
  /** Set by the SDK auth middleware. */
  client?: IServiceClientWithProject;
  /** True when the request proved the client secret (server-side SDKs). */
  clientSecretAuth?: boolean;
  /** Parsed JSON body, read once by the first middleware that needs it. */
  body?: unknown;
  /** Dashboard routes: parsed cookies and the validated session. */
  cookies: Record<string, string | undefined>;
  session: SessionValidationResult;
}

export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}
