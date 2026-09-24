/// <reference path="../types/wasm.d.ts" />
// Workers can't compile WebAssembly at runtime: wrangler bundles the
// `.wasm` import as a compiled module.
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';

export async function loadResvgWasm(): Promise<WebAssembly.Module> {
  return resvgWasm;
}
