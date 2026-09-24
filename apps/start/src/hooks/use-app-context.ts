import { useRouteContext } from '@tanstack/react-router';
import type { PlatformFeatures } from '@/server/get-envs';

const NO_FEATURES: PlatformFeatures = {
  ai: false,
  integrations: false,
  importers: false,
  billing: false,
  mcp: false,
};

export function useAppContext() {
  const params = useRouteContext({
    strict: false,
  });

  if (
    !(params.apiUrl && params.dashboardUrl) ||
    typeof params.isSelfHosted === 'undefined'
  ) {
    throw new Error('API URL or dashboard URL is not set');
  }

  return {
    apiUrl: params.apiUrl,
    dashboardUrl: params.dashboardUrl,
    isSelfHosted: params.isSelfHosted,
    isMaintenance: params.isMaintenance ?? false,
    isDemo: params.isDemo ?? false,
    features: params.features ?? NO_FEATURES,
  };
}
