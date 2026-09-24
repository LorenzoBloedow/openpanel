/**
 * Secrets and optional vars `wrangler types` can't see (they live in
 * `wrangler secret put` / .dev.vars). Merged into the generated Env.
 */
interface OpenPanelSecrets {
  /** Neon's pooled endpoint: the only database route of this Worker. */
  DATABASE_URL: string;
  ENCRYPTION_KEY?: string;
  SESSION_TIMEOUT_MS?: string;
  /** '0' disables the session reaper cron. */
  SESSION_REAPER?: string;
}

// `wrangler types` declares both the global Env and Cloudflare.Env.
declare global {
  interface Env extends OpenPanelSecrets {}
  // biome-ignore lint/style/noNamespace: augments the generated declaration
  namespace Cloudflare {
    interface Env extends OpenPanelSecrets {}
  }
}

export {};
