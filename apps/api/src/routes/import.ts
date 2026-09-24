import { uuidv7 } from '@openpanel/common/server';
import { withDbRoute } from '@openpanel/db/src/db-routing';
import { type ImportedEvent, importEvents } from '@openpanel/db/src/ingest/import';
import { Hono } from 'hono';

import { documentRoute } from '@/compat/fastify';
import type { AppEnv } from '@/env';
import { readJsonBody } from '@/ingest/body';
import { validateImportRequest } from '@/utils/auth';

export const importRoutes = new Hono<AppEnv>();

documentRoute({
  method: 'POST',
  path: '/import/events',
  schema: { tags: ['Import'], description: 'Bulk import historical events.' },
});

importRoutes.post('/events', async (c) => {
  let projectId: string | null;
  try {
    const client = await validateImportRequest(c.req.raw.headers);
    projectId = client.projectId;
  } catch (error) {
    return c.json(
      {
        error: 'Unauthorized',
        message: error instanceof Error ? error.message : 'Unexpected error',
      },
      401,
    );
  }

  if (!projectId) {
    return c.json(
      { status: 400, error: 'Bad Request', message: 'Client has no project' },
      400,
    );
  }

  const body = await readJsonBody(c);
  if (!Array.isArray(body)) {
    return c.json(
      { status: 400, error: 'Bad Request', message: 'body must be an array' },
      400,
    );
  }

  try {
    // Bulk writes nobody waits on in real time: the direct route.
    const inserted = await withDbRoute('importEvents', () =>
      importEvents(projectId!, body as ImportedEvent[], uuidv7),
    );
    c.get('logger').info({ projectId, inserted }, 'events imported');
    return c.text('OK');
  } catch (error) {
    c.get('logger').error({ err: error, projectId }, 'Import failed');
    return c.text('Error', 500);
  }
});
