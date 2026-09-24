import type { GoldenCase } from '../harness';

interface CaseModule {
  group: string;
  cases: GoldenCase[];
}

// Every `<group>.cases.ts` in this directory is a captured group.
const modules = import.meta.glob<CaseModule>('./*.cases.ts', { eager: true });

export const GOLDEN_GROUPS: Record<string, GoldenCase[]> = Object.fromEntries(
  Object.values(modules).map((module) => [module.group, module.cases]),
);
