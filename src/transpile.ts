/*
 * Transpile the de-bunned cli.js to a specific Node target with esbuild (pure
 * transpile, no bundling): lowers syntax the target Node lacks — chiefly `using` /
 * `await using` — then prepends idempotent runtime polyfills esbuild cannot add
 * (Array.prototype.with, …). `target` is an esbuild node target, e.g. "node18".
 *
 * This is the tail of the pipeline for the single-bundle shape only; the
 * code-split ESM shape is lowered by esbuild while bundling (see bundle.ts).
 */
import { ensureReady, esbuild } from './esb';

export async function transpile(debunnedSource: string, polyfills: string, target: string): Promise<string> {
  await ensureReady();
  const src = debunnedSource.replace(/^#![^\n]*\n/, ''); // strip shebang for esbuild
  const result = await esbuild.transform(src, {
    loader: 'js',
    format: 'cjs',
    platform: 'node',
    target,
    legalComments: 'inline',
    logLevel: 'silent'
  });
  return '#!/usr/bin/env node\n' + polyfills.replace(/\s+$/, '') + '\n' + result.code;
}
