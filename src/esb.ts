/*
 * The shared esbuild-wasm service. initialize() may run only once per process,
 * and both pipelines need it — transpile() for the old single-bundle shape,
 * bundleGraph() for the code-split ESM shape — so the promise lives here.
 *
 * esbuild-wasm (the WebAssembly build), not the native binary, so cc2js installs
 * and runs anywhere Node 18+ runs — including older macOS (10.15+), where the
 * native esbuild Go binary refuses to load (it links macOS 12+ symbols). Same
 * APIs; the only cost is a one-time initialize(). In Node it auto-loads its own
 * bundled esbuild.wasm — the wasmURL/wasmModule/worker options are browser-only
 * and throw here.
 */
import * as esbuild from 'esbuild-wasm';

let ready: Promise<void> | undefined;

export function ensureReady(): Promise<void> {
  if (!ready) ready = esbuild.initialize({});
  return ready;
}

export { esbuild };
