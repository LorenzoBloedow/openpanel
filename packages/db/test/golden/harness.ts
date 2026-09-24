/**
 * Golden comparison between the ClickHouse services and their Postgres
 * ports.
 *
 * Case definitions (test/golden/cases/*.ts) call service functions through
 * their normal import paths. The capture run (vitest.golden.config.ts, local
 * ClickHouse 26.1, the original code) records their output into
 * test/golden/data/<group>.json. After a service is ported, its
 * <group>.golden.test.ts runs the same cases against Postgres, loaded with
 * the same deterministic dataset at the same anchor time, and compares.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

import { db } from '../../src/prisma-client';
import {
  DATASET_COHORTS,
  type Dataset,
  generateDataset,
} from '../fixtures/analytics-dataset';

export const GOLDEN_PROJECTS = {
  sthlm: { id: 'golden-sthlm', timezone: 'Europe/Stockholm', seed: 11 },
  ny: { id: 'golden-ny', timezone: 'America/New_York', seed: 22 },
  utc: { id: 'golden-utc', timezone: 'UTC', seed: 33 },
} as const;

export type GoldenProjectKey = keyof typeof GOLDEN_PROJECTS;

export interface GoldenContext {
  anchor: Date;
  projects: typeof GOLDEN_PROJECTS;
  datasets: Record<GoldenProjectKey, Dataset>;
}

export interface GoldenCase {
  name: string;
  run: (ctx: GoldenContext) => Promise<unknown>;
  /**
   * Array paths whose order the service doesn't define (ties in ORDER BY,
   * GROUP BY without ORDER BY). '' is the top-level value; 'series' or
   * 'series.*.data' address nested arrays.
   */
  unordered?: string[];
  /** Relative tolerance for floats (defaults to 1e-6). */
  tolerance?: number;
  /**
   * Keys dropped at any depth before comparing — internal aliases that leak
   * into results (e.g. `_avg_session_duration`) and aren't part of the API.
   */
  ignoreKeys?: string[];
}

export const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));

export function goldenDataPath(group: string) {
  return join(GOLDEN_DIR, 'data', `${group}.json`);
}

export function buildDatasets(anchor: Date): Record<GoldenProjectKey, Dataset> {
  return Object.fromEntries(
    Object.entries(GOLDEN_PROJECTS).map(([key, project]) => [
      key,
      generateDataset({ projectId: project.id, anchor, seed: project.seed }),
    ]),
  ) as Record<GoldenProjectKey, Dataset>;
}

/**
 * The Postgres rows the services read around the analytics data:
 * organizations (time zones), projects, and the cohort definitions of the
 * Stockholm project.
 */
export async function seedGoldenConfig() {
  for (const [key, project] of Object.entries(GOLDEN_PROJECTS)) {
    const organizationId = `golden-org-${key}`;
    await db.organization.upsert({
      where: { id: organizationId },
      create: { id: organizationId, name: `Golden ${key}`, timezone: project.timezone },
      update: { timezone: project.timezone },
    });
    await db.project.upsert({
      where: { id: project.id },
      create: { id: project.id, name: `Golden ${key}`, organizationId },
      update: {},
    });
  }
  for (const cohort of Object.values(DATASET_COHORTS)) {
    await db.cohort.upsert({
      where: { id: cohort.id },
      create: {
        id: cohort.id,
        name: cohort.name,
        projectId: GOLDEN_PROJECTS.sthlm.id,
        isStatic: true,
        // Static cohorts never evaluate their definition; keep the column's
        // default so captured rows compare equal on a fresh database.
        definition: {} as PrismaJson.IPrismaCohortDefinition,
      },
      update: {},
    });
  }
}

// --- normalisation -----------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON-safe, representation-independent view of a service result. */
export function toComparable(value: unknown): Json {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'string') {
    // ClickHouse pads empty FixedString(2) countries with NUL bytes.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
    return value.replace(/\u0000/g, '');
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toComparable);
  }
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value as object).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined && typeof inner !== 'function') {
        out[key] = toComparable(inner);
      }
    }
    return out;
  }
  return String(value);
}

function sortKey(value: Json) {
  return JSON.stringify(value);
}

/** Drop the given keys from every object, at any depth. */
export function dropKeys(value: Json, keys: string[]): Json {
  if (keys.length === 0) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => dropKeys(item, keys));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!keys.includes(key)) {
        out[key] = dropKeys(inner, keys);
      }
    }
    return out;
  }
  return value;
}

/** Sort the arrays at the given paths ('' = root, '*' = every element). */
export function sortUnordered(value: Json, paths: string[]): Json {
  let result = value;
  for (const path of paths) {
    result = sortAt(result, path === '' ? [] : path.split('.'));
  }
  return result;
}

function sortAt(value: Json, segments: string[]): Json {
  if (segments.length === 0) {
    return Array.isArray(value)
      ? [...value].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0))
      : value;
  }
  const [head, ...rest] = segments;
  if (head === '*') {
    return Array.isArray(value) ? value.map((item) => sortAt(item, rest)) : value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && head! in value) {
    return { ...value, [head!]: sortAt(value[head!]!, rest) };
  }
  return value;
}

/** Deep equality with float tolerance; returns the first difference path. */
export function findDifference(
  expected: Json,
  actual: Json,
  tolerance = 1e-6,
  path = '$',
): string | null {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const scale = Math.max(1, Math.abs(expected), Math.abs(actual));
    return Math.abs(expected - actual) <= tolerance * scale
      ? null
      : `${path}: expected ${expected}, got ${actual}`;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!(Array.isArray(expected) && Array.isArray(actual))) {
      return `${path}: expected ${JSON.stringify(expected)?.slice(0, 200)}, got ${JSON.stringify(actual)?.slice(0, 200)}`;
    }
    if (expected.length !== actual.length) {
      return `${path}: expected ${expected.length} items, got ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const diff = findDifference(expected[i]!, actual[i]!, tolerance, `${path}[${i}]`);
      if (diff) {
        return diff;
      }
    }
    return null;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const diff = findDifference(
        (expected as Record<string, Json>)[key] ?? null,
        (actual as Record<string, Json>)[key] ?? null,
        tolerance,
        `${path}.${key}`,
      );
      if (diff) {
        return diff;
      }
    }
    return null;
  }
  return expected === actual
    ? null
    : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

// --- capture and compare ---------------------------------------------------------

export interface GoldenFile {
  group: string;
  anchor: string;
  capturedWith: string;
  cases: Record<string, { output: Json } | { error: string }>;
}

export function freezeTime(anchor: Date) {
  vi.useFakeTimers({ toFake: ['Date'], now: anchor });
}

async function runCase(testCase: GoldenCase, ctx: GoldenContext) {
  try {
    const output = sortUnordered(
      dropKeys(toComparable(await testCase.run(ctx)), testCase.ignoreKeys ?? []),
      testCase.unordered ?? [],
    );
    return { output };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Record every case's output (capture run, original ClickHouse code). */
export async function captureGroup(
  group: string,
  cases: GoldenCase[],
  ctx: GoldenContext,
  capturedWith: string,
) {
  const file: GoldenFile = {
    group,
    anchor: ctx.anchor.toISOString(),
    capturedWith,
    cases: {},
  };
  for (const testCase of cases) {
    file.cases[testCase.name] = await runCase(testCase, ctx);
  }
  mkdirSync(join(GOLDEN_DIR, 'data'), { recursive: true });
  writeFileSync(goldenDataPath(group), `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

export function readGoldenFile(group: string): GoldenFile {
  return JSON.parse(readFileSync(goldenDataPath(group), 'utf8')) as GoldenFile;
}

/** One vitest test per case, comparing the ported service to the golden. */
export function compareCases(
  group: string,
  cases: GoldenCase[],
  getCtx: () => GoldenContext,
) {
  const golden = readGoldenFile(group);
  for (const testCase of cases) {
    it(testCase.name, async () => {
      const expected = golden.cases[testCase.name];
      expect(expected, `no golden output for "${testCase.name}"`).toBeDefined();
      const actual = await runCase(testCase, getCtx());
      if ('error' in expected!) {
        expect(actual).toEqual(expected);
        return;
      }
      expect('error' in actual ? actual.error : null).toBeNull();
      const diff = findDifference(
        expected!.output,
        (actual as { output: Json }).output,
        testCase.tolerance,
      );
      expect(diff).toBeNull();
    });
  }
}
