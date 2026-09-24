import type { GoldenCase } from '../harness';

interface CaseModule {
  group: string;
  cases: GoldenCase[];
}

type GlobImportMeta = ImportMeta & {
  glob: <T>(pattern: string, options: { eager: true }) => Record<string, T>;
};

// Every `<group>.cases.ts` in this directory is a captured group (Vite's
// import.meta.glob, resolved by vitest at transform time).
const modules = (import.meta as GlobImportMeta).glob<CaseModule>(
  './*.cases.ts',
  { eager: true },
);

export const GOLDEN_GROUPS: Record<string, GoldenCase[]> = Object.fromEntries(
  Object.values(modules).map((module) => [module.group, module.cases]),
);
