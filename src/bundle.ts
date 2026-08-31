/*
 * The code-split shape. Up to ~2.1.235 a Claude Code binary held the whole CLI in
 * one self-contained CJS bundle, which debun.ts wraps and transpile.ts lowers.
 * From ~2.1.243 the entry is ~20 KB of ESM that `import`s ~1800 sibling
 * `/$bunfs/root/chunk-*.js` modules, statically and dynamically — wrapping that in
 * Bun's CJS wrapper is a syntax error (`Unexpected "{"` on the first `import{…}`).
 *
 * So re-bundle the graph back into one self-contained CommonJS file with esbuild:
 * chunk specifiers resolve out of the in-memory module map, everything else stays
 * external (node builtins, the runtime deps Bun provided natively, and the
 * `/$bunfs/root/*.node` addons and text assets the shim redirects at runtime), and
 * Bun's `import.meta` is mapped onto its CommonJS equivalents. esbuild lowers to
 * `target` while bundling, so the result needs no second transpile pass —
 * bundleGraph() returns finished files, shim and polyfills included.
 *
 * A few graph modules are also loaded by *path* at runtime (the function-hooks
 * worker is spawned from `/$bunfs/root/src/plugins/…/hooks-worker.js`), so those
 * get their own bundled file too, at the path the bundle looks them up by.
 *
 * CommonJS cannot express top-level await, so a future entry that used one would
 * stop here with esbuild saying exactly that. Every release so far keeps its
 * awaits inside an async main() — the shim is CJS, so CJS is what we emit.
 */
import type { Plugin } from 'esbuild-wasm';
import { type BunModule, getModuleSource, type ParsedBunBinary } from 'unbunjs';

import { invokeCjs } from './debun';
import { ensureReady, esbuild } from './esb';

const NS = 'bunfs';
const OUTDIR = '/cc2js';
const BUNFS_PREFIX = /^(?:\/\$bunfs\/root\/|B:[\\/]~BUN[\\/]root[\\/])/;
// Entry of a graph binary: `import`/`export` naming another embedded module.
const GRAPH_IMPORT = /(?:^|[\n;])\s*(?:import|export)\b[^\n;]*["']\/\$bunfs\//;
// A quoted /$bunfs/… path, and the tokens that mean it is only an import
// specifier rather than a path the bundle will hand to the runtime.
const BUNFS_LITERAL = /["'](\/\$bunfs\/[^"']+)["']/g;
const SPECIFIER_OF = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*$/;

// `import.meta` has no meaning once the graph is CommonJS; map what the bundle
// actually reads onto the CJS equivalents. Bun's `import.meta.require` is plain
// require(); `dirname` is the virtual root every embedded module sees, which is
// the output dir — not `__dirname`, which differs in the nested worker bundles.
// The `__cc2js_*` bindings are declared in the preamble below.
const IMPORT_META: Record<string, string> = {
  'import.meta.require': 'require',
  'import.meta.dirname': '__cc2js_root',
  'import.meta.path': '__filename',
  'import.meta.filename': '__filename',
  'import.meta.url': '__cc2js_meta_url',
  'import.meta.main': '__cc2js_meta_main'
};

export interface EsmGraph {
  /** bunfs name of the entry module */
  entry: string;
  /** bunfs name → source, for every module compiled into the output */
  files: Map<string, string>;
  /** graph modules also loaded by path at runtime; each needs its own file */
  extras: string[];
}

export interface BundleOptions {
  shim: string;
  polyfills: string;
  version: string;
  target: string;
}

export interface BundledFile {
  /** path relative to the output dir; the entry is always `cli.js` */
  name: string;
  code: string;
}

/** Is this binary the code-split ESM shape (rather than one CJS bundle)? */
export function isEsmGraph(entry: BunModule, entrySource: string): boolean {
  if (entry.module_format === 'esm') return true;
  if (entry.module_format === 'cjs') return false;
  return GRAPH_IMPORT.test(entrySource); // a Bun layout with no format tag
}

/** The JS modules to compile into the output, and which need their own file. */
export function collectGraph(parsed: ParsedBunBinary, entry: BunModule): EsmGraph {
  const files = new Map<string, string>();
  for (const m of parsed.modules) {
    if (m.module_format === 'esm' || m.module_format === 'cjs') files.set(m.name, getModuleSource(parsed, m));
  }
  files.set(entry.name, getModuleSource(parsed, entry));
  return { entry: entry.name, files, extras: pathReferenced(files, entry.name) };
}

/*
 * Which graph modules the bundle also names by path, and so must exist as files
 * of their own: the function-hooks worker, say, is spawned from its
 * `/$bunfs/root/…` URL rather than imported. Import specifiers name modules too,
 * so drop the occurrences an `import`/`require` is reaching for and keep the rest.
 */
function pathReferenced(files: Map<string, string>, entry: string): string[] {
  const found = new Set<string>();
  for (const source of files.values()) {
    for (const m of source.matchAll(BUNFS_LITERAL)) {
      const name = m[1];
      if (name === entry || found.has(name) || !files.has(name)) continue;
      if (!SPECIFIER_OF.test(source.slice(Math.max(0, m.index - 12), m.index))) found.add(name);
    }
  }
  return [...found].sort();
}

/** `/$bunfs/root/a/b.js` (or the Windows `B:\~BUN\root\a\b.js`) → `a/b.js`. */
export function bunfsRelative(name: string): string {
  return name.replace(BUNFS_PREFIX, '').replace(/\\/g, '/');
}

export async function bundleGraph(graph: EsmGraph, opts: BundleOptions): Promise<BundledFile[]> {
  await ensureReady();

  // `out` is the output path minus the `.js` esbuild appends. The entry always
  // lands on cli.js; the extras keep the path the bundle looks them up by.
  const entryPoints = [
    { in: graph.entry, out: 'cli' },
    ...graph.extras.map((n) => ({ in: n, out: bunfsRelative(n).replace(/\.[cm]?js$/, '') }))
  ];
  const result = await esbuild.build({
    entryPoints,
    bundle: true,
    write: false,
    outdir: OUTDIR,
    format: 'cjs',
    platform: 'node',
    target: opts.target,
    legalComments: 'inline',
    logLevel: 'silent',
    define: IMPORT_META,
    plugins: [graphPlugin(graph.files)]
  });

  const named = new Map(entryPoints.map((e) => [OUTDIR + '/' + e.out + '.js', e.out + '.js']));
  const header = noticeOf(graph.files.get(graph.entry) ?? '');
  const files = (result.outputFiles ?? []).map((o) => {
    const key = o.path.replace(/\\/g, '/');
    const name = named.get(key) ?? key.slice(key.lastIndexOf(OUTDIR + '/') + OUTDIR.length + 1);
    return { name, code: preamble(name, header, opts) + invokeCjs(o.text) };
  });
  // cli.js first, so callers need not hunt for the one they must chmod and report
  return files.sort(
    (a, b) => Number(b.name === 'cli.js') - Number(a.name === 'cli.js') || a.name.localeCompare(b.name)
  );
}

function graphPlugin(files: Map<string, string>): Plugin {
  return {
    name: NS,
    setup(build) {
      // Every specifier inside the graph is an absolute /$bunfs/root/… path, so a
      // hit in the map is a graph module and everything else — node builtins, the
      // runtime deps, the .node addons and text assets the shim redirects — is
      // left for the runtime to resolve.
      build.onResolve({ filter: /.*/ }, (args) =>
        files.has(args.path) ? { path: args.path, namespace: NS } : { path: args.path, external: true }
      );
      build.onLoad({ filter: /.*/, namespace: NS }, (args) => ({ contents: files.get(args.path), loader: 'js' }));
    }
  };
}

// esbuild drops plain comments, so carry the entry's own header (the Anthropic
// legal notice and version line) across by hand.
function noticeOf(entrySource: string): string {
  const out: string[] = [];
  for (const line of entrySource.split('\n')) {
    if (/^\/\/ ?@bun\b/.test(line)) continue; // Bun directive, not part of the notice
    if (line.trim() !== '' && !line.startsWith('//')) break;
    out.push(line.replace(/\r$/, ''));
  }
  return out.join('\n').trim();
}

function preamble(name: string, notice: string, opts: BundleOptions): string {
  const up = name.split('/').length - 1;
  const root = up ? 'require("path").resolve(__dirname, "' + Array(up).fill('..').join('/') + '")' : '__dirname';
  return (
    '#!/usr/bin/env node\n' +
    '// Claude Code ' +
    opts.version +
    ' — de-bunned, runs on plain Node. Bun shim inlined below.\n' +
    (notice ? notice + '\n' : '') +
    opts.polyfills.replace(/\s+$/, '') +
    '\n' +
    // The shim resolves /$bunfs/root/* against this, so every output — the nested
    // worker bundles included — points at the dir holding the extracted files.
    'var __cc2js_root = ' +
    root +
    ';\n' +
    'var __cc2js_meta_url = require("url").pathToFileURL(__filename).href;\n' +
    'var __cc2js_meta_main = require.main === module;\n' +
    opts.shim.replace(/\s*$/, '') +
    '\n;/* ---- begin ' +
    opts.version +
    ' bundle (Bun ESM graph, re-bundled) ---- */\n'
  );
}
