import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

/**
 * Node (tests, scripts): compile the module from the package's .wasm file.
 * Workers get argon2-wasm.workerd.ts through the "workerd" condition of the
 * `#argon2-wasm` import in package.json.
 */
export async function loadArgon2Module(): Promise<WebAssembly.Module> {
  const require = createRequire(import.meta.url);
  const bytes = await readFile(require.resolve('@phi-ag/argon2/argon2.wasm'));
  return WebAssembly.compile(bytes);
}
