import { FeatureUnavailable } from '@/components/feature-unavailable';
import { PageHeader } from '@/components/page-header';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAppContext } from '@/hooks/use-app-context';
import { usePageTabs } from '@/hooks/use-page-tabs';
import { PAGE_TITLES, createProjectTitle } from '@/utils/title';
import { Outlet, createFileRoute, useRouter } from '@tanstack/react-router';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/integrations/_tabs',
)({
  component: Component,
  head: () => {
    return {
      meta: [
        {
          title: createProjectTitle(PAGE_TITLES.INTEGRATIONS),
        },
      ],
    };
  },
});

function Component() {
  const router = useRouter();
  const { features } = useAppContext();

  const { activeTab, tabs } = usePageTabs([
    { id: 'installed', label: 'Installed' },
    { id: 'available', label: 'Available' },
  ]);

  const handleTabChange = (tabId: string) => {
    router.navigate({
      from: Route.fullPath,
      to: tabId,
    });
  };

  if (!features.integrations) {
    return <FeatureUnavailable className="container p-8" feature="integrations" />;
  }

  return (
    <div className="container p-8">
      <PageHeader
        title="Integrations"
        description="Manage your integrations here"
      />

      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="mt-2 mb-8"
      >
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Outlet />
    </div>
  );
}
