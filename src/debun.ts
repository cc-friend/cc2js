/*
 * de-bun: turn the raw `cli.js` extracted from a Bun standalone binary into a file
 * that runs on plain Node — strip the `// @bun` directive, invoke the CJS wrapper
 * Bun would call itself, and prepend the Bun→Node compatibility shim.
 */
const WRAP_ARGS = '(module.exports, require, module, __filename, __dirname)';

/*
 * Wrap a CJS bundle in the module wrapper Bun would have called, and call it.
 * The wrapper is what keeps the bundle's top-level names (`fs`, `path`, … after
 * minification) out of the shim's scope, so it is needed for the re-bundled ESM
 * graph just as much as for a bundle lifted straight out of the binary.
 */
export function invokeCjs(bundle: string): string {
  if (/^\(\s*(?:async\s+)?function\b/.test(bundle)) return bundle + WRAP_ARGS + ';\n';
  return '(function(exports, require, module, __filename, __dirname) {\n' + bundle + '\n})' + WRAP_ARGS + ';\n';
}

export function debun(rawBundle: string | Buffer, shimSource: string, version: string): string {
  let bundle = Buffer.isBuffer(rawBundle) ? rawBundle.toString('utf8') : String(rawBundle);

  bundle = bundle.replace(/^﻿/, ''); // BOM
  bundle = bundle.replace(/^\/\/ ?@bun\b[^\n]*\r?\n/, ''); // Bun directive line
  bundle = bundle.replace(/^#![^\n]*\r?\n/, ''); // stray shebang
  bundle = bundle.replace(/\s+$/, ''); // trailing ws — expression ends with "})"

  const invoked = invokeCjs(bundle);

  const banner =
    '#!/usr/bin/env node\n' +
    '// Claude Code ' +
    version +
    ' — de-bunned, runs on plain Node. Bun shim inlined below.\n';
  const begin = '\n;/* ---- begin ' + version + ' bundle (Bun CJS wrapper, now invoked) ---- */\n';

  return banner + shimSource.replace(/\s*$/, '\n') + begin + invoked;
}
