/// <reference path="./wasm.d.ts" />
// Wrangler and @cloudflare/vitest-plugin load `.wasm` imports as compiled
// WebAssembly.Module objects. Workers refuse to compile WebAssembly from
// bytes at runtime, so a static import is the only way to get the module.
import argon2Wasm from '@phi-ag/argon2/argon2.wasm';

export async function loadArgon2Module(): Promise<WebAssembly.Module> {
  return argon2Wasm;
}
