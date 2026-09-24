/**
 * The one piece of the Workers runtime the dashboard reads: `env` from
 * `cloudflare:workers` during SSR (see integrations/tanstack-query). The
 * full workers-types would clash with the DOM types the app compiles with.
 */
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;
}
