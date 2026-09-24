import { readFile, writeFile } from 'node:fs/promises';
import { type JSONPath, applyEdits, modify, parse } from 'jsonc-parser';

/**
 * Edits to the Workers' wrangler.jsonc files that keep their comments and
 * layout (setup fills in account-specific ids and URLs).
 */

export interface ConfigEdit {
  path: JSONPath;
  /** `undefined` removes the key. */
  value: unknown;
}

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };

export function applyConfigEdits(text: string, edits: ConfigEdit[]): string {
  let next = text;
  for (const edit of edits) {
    next = applyEdits(next, modify(next, edit.path, edit.value, FORMAT));
  }
  return next;
}

export function readConfigValue(text: string, path: JSONPath): unknown {
  let value: unknown = parse(text, [], { allowTrailingComma: true });
  for (const key of path) {
    if (value === null || typeof value !== 'object') {
      return undefined;
    }
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

/** Apply edits to a config file; returns whether it changed. */
export async function editConfigFile(
  file: string,
  edits: ConfigEdit[],
  options: { dryRun?: boolean } = {},
): Promise<boolean> {
  const text = await readFile(file, 'utf8');
  const next = applyConfigEdits(text, edits);
  if (next === text) {
    return false;
  }
  if (!options.dryRun) {
    await writeFile(file, next);
  }
  return true;
}

/** A custom domain route, or none (the Worker stays on workers.dev). */
export function routesEdit(domain: string | undefined): ConfigEdit[] {
  return domain ? [{ path: ['routes'], value: [{ pattern: domain, custom_domain: true }] }] : [];
}
