import { db } from '../prisma-client';

// Analytics rows are deleted by the ProjectDelete workflow, in chunks, with
// deleteProjectAnalyticsChunk (analytics/maintenance.ts); schedule a
// deletion by setting `deleteAt` on the project or organization.

export async function deleteOrganization(organizationId: string) {
  return await db.organization.delete({
    where: {
      id: organizationId,
    },
  });
}

export async function deleteProjects(projectIds: string[]) {
  const projects = await db.project.findMany({
    where: {
      id: {
        in: projectIds,
      },
    },
  });

  if (projects.length === 0) {
    return;
  }

  for (const project of projects) {
    await db.project.delete({
      where: {
        id: project.id,
      },
    });
  }

  return projects;
}
