import { CloudOffIcon } from 'lucide-react';
import { FullPageEmptyState } from './full-page-empty-state';
import type { PlatformFeatures } from '@/server/get-envs';

const COPY: Record<keyof PlatformFeatures, { title: string; description: string }> = {
  ai: {
    title: 'AI is not available here yet',
    description: 'AI features are not available on Cloudflare yet.',
  },
  integrations: {
    title: 'Integrations are not available here yet',
    description:
      'Slack, Discord, webhook and export integrations are not available on Cloudflare yet. In-app and email notifications work.',
  },
  importers: {
    title: 'Imports are not available here yet',
    description: 'Importing data from other tools is not available on Cloudflare yet.',
  },
  billing: {
    title: 'Billing is not available here',
    description: 'This deployment is self-hosted: there is nothing to pay for.',
  },
  mcp: {
    title: 'MCP is not available here yet',
    description: 'The MCP server is not available on Cloudflare yet.',
  },
};

/** A page's stand-in when the deployment ships without its feature. */
export function FeatureUnavailable({
  feature,
  className,
}: {
  feature: keyof PlatformFeatures;
  className?: string;
}) {
  const { title, description } = COPY[feature];
  return (
    <FullPageEmptyState
      className={className}
      description={description}
      icon={CloudOffIcon}
      title={title}
    />
  );
}
