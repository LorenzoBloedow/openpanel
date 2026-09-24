import { runWithScope } from '@openpanel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDatabase, createTestDatabase } from '../../src/testing/database';
import { generateDataset } from './analytics-dataset';
import { countProjectRows, loadDatasetIntoPostgres } from './load-postgres';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

describe('loadDatasetIntoPostgres', () => {
  it('loads every row and rebuilds the rollups, idempotently', async () => {
    const dataset = generateDataset({
      projectId: 'proj-load',
      anchor: new Date('2026-09-20T12:00:00Z'),
    });
    await runWithScope({ env: { DATABASE_URL: testDb.url }, route: 'direct' }, async () => {
      await loadDatasetIntoPostgres(dataset);
      await loadDatasetIntoPostgres(dataset);
      const counts = await countProjectRows('proj-load');
      expect(counts.events).toBe(dataset.events.length);
      expect(counts.sessions).toBe(dataset.sessions.length);
      expect(counts.profiles).toBe(dataset.profiles.length);
      expect(counts.dau).toBeGreaterThan(0);
      expect(counts.event_names).toBe(new Set(dataset.events.map((e) => e.name)).size);
    });
  });
});
