// Wrangler (and @cloudflare/vitest-plugin) load `.wasm` imports as compiled
// WebAssembly.Module objects; Workers can't compile WebAssembly at runtime.
declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
