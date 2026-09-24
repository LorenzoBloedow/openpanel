import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';

/** Features a deployment ships with; the Cloudflare build leaves these off. */
export interface PlatformFeatures {
  ai: boolean;
  integrations: boolean;
  importers: boolean;
  billing: boolean;
  mcp: boolean;
}

export const getServerEnvs = createServerFn().handler(() => {
  const envs = {
    apiUrl: String(process.env.API_URL || process.env.NEXT_PUBLIC_API_URL),
    dashboardUrl: String(
      process.env.DASHBOARD_URL || process.env.NEXT_PUBLIC_DASHBOARD_URL
    ),
    isSelfHosted: process.env.SELF_HOSTED !== undefined,
    isMaintenance: process.env.MAINTENANCE === '1',
    isDemo: process.env.DEMO_USER_ID !== undefined,
    // Features the Cloudflare build ships without (the API answers 501).
    features: {
      ai: process.env.FEATURE_AI === 'true',
      integrations: process.env.FEATURE_INTEGRATIONS === 'true',
      importers: process.env.FEATURE_IMPORTERS === 'true',
      billing: process.env.FEATURE_BILLING === 'true',
      mcp: process.env.FEATURE_MCP === 'true',
    } satisfies PlatformFeatures,
  };

  return envs;
});

export const getServerEnvsQueryOptions = queryOptions({
  queryKey: ['server-envs'],
  queryFn: getServerEnvs,
  staleTime: Number.POSITIVE_INFINITY,
});
