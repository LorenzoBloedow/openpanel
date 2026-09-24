import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

/** Node (tests, scripts): compile the module from the package's file. */
export async function loadResvgWasm(): Promise<WebAssembly.Module> {
  const require = createRequire(import.meta.url);
  const path = require.resolve('@resvg/resvg-wasm/index_bg.wasm');
  return WebAssembly.compile(await readFile(path));
}
