import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import type { BunModule, ParsedBunBinary } from 'unbunjs';
import { bundleGraph, bunfsRelative, collectGraph, isEsmGraph } from '../src/bundle';

const R = '/$bunfs/root/';

// A parsed binary is only ever read through unbun's getModuleSource(), which
// slices the payload at each module's offset and decodes it by the recorded
// encoding — so a handful of modules laid end to end in one buffer stands in
// faithfully. The entry size says "this layout records an encoding".
function fakeBinary(mods: { name: string; body: Buffer | string; encoding?: string; format?: string }[]): {
  parsed: ParsedBunBinary;
  modules: BunModule[];
} {
  const modules: BunModule[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [i, m] of mods.entries()) {
    const buf = Buffer.isBuffer(m.body) ? m.body : Buffer.from(m.body, 'latin1');
    chunks.push(buf);
    modules.push({
      index: i,
      name: m.name,
      contents_offset: offset,
      contents_length: buf.length,
      encoding: m.encoding ?? 'latin1',
      module_format: m.format ?? 'esm',
      is_entry_point: i === 0
    } as BunModule);
    offset += buf.length;
  }
  const parsed = {
    payload: Buffer.concat(chunks),
    offsets: { module_entry_size: 52 }
  } as ParsedBunBinary;
  return { parsed, modules };
}

test('isEsmGraph goes by the module format, then by the entry source', () => {
  const esm = { module_format: 'esm' } as BunModule;
  const cjs = { module_format: 'cjs' } as BunModule;
  const unknown = { module_format: 'none' } as BunModule;
  assert.equal(isEsmGraph(esm, '(function(exports){})'), true);
  assert.equal(isEsmGraph(cjs, 'import{a}from"/$bunfs/root/chunk-x.js";'), false);
  assert.equal(isEsmGraph(unknown, '// @bun\nimport{a}from"/$bunfs/root/chunk-x.js";'), true);
  assert.equal(isEsmGraph(unknown, '(function(exports, require){ return 1; })'), false);
});

test('bunfsRelative strips the POSIX and Windows virtual roots', () => {
  assert.equal(bunfsRelative(R + 'a/b.js'), 'a/b.js');
  assert.equal(bunfsRelative('B:\\~BUN\\root\\a\\b.js'), 'a/b.js');
  assert.equal(bunfsRelative('/elsewhere/a.js'), '/elsewhere/a.js');
});

test('collectGraph takes the JS modules and flags the path-referenced ones as extras', () => {
  const { parsed, modules } = fakeBinary([
    {
      name: R + 'cli',
      body:
        'import"/$bunfs/root/chunk-aa11.js";' +
        'import{q}from"/$bunfs/root/quiet.js";' +
        'new Worker("/$bunfs/root/src/w/worker.js");' +
        'read("/$bunfs/root/notes.md");'
    },
    { name: R + 'chunk-aa11.js', body: 'export const a = 1;' },
    { name: R + 'quiet.js', body: 'export const q = 1;' },
    { name: R + 'src/w/worker.js', body: 'export const w = 1;' },
    { name: R + 'mermaid.min.js', body: Buffer.from([0, 1, 2]), encoding: 'binary', format: 'none' },
    { name: R + 'notes.md', body: 'hi', format: 'none' }
  ]);
  parsed.modules = modules;
  const graph = collectGraph(parsed, modules[0]);
  assert.deepEqual(
    [...graph.files.keys()].sort(),
    [R + 'chunk-aa11.js', R + 'cli', R + 'quiet.js', R + 'src/w/worker.js'] // file assets are not modules
  );
  // only the worker: the others are reached by `import`, and notes.md is no module
  assert.deepEqual(graph.extras, [R + 'src/w/worker.js']);
});

test('bundleGraph re-bundles the graph into runnable CJS files', async () => {
  const { parsed, modules } = fakeBinary([
    {
      name: R + 'cli',
      body:
        '// @bun\n// Claude Code notice.\n// Version: 9.9.9\n' +
        'import{hi}from"/$bunfs/root/chunk-aa11.js";' +
        'async function main(){const{bye}=await import("/$bunfs/root/chunk-bb22.js");' +
        'return{hi:hi(),bye:bye(),root:import.meta.dirname,dir:import.meta.dir,md:import.meta.require("/$bunfs/root/n.md")};}' +
        'module.exports=main();globalThis.W="/$bunfs/root/src/w/worker.js";'
    },
    { name: R + 'chunk-aa11.js', body: 'export const hi=()=>"hi";' },
    { name: R + 'chunk-bb22.js', body: 'export const bye=()=>"bye";' },
    {
      name: R + 'src/w/worker.js',
      body: 'import{hi}from"/$bunfs/root/chunk-aa11.js";module.exports=hi();'
    }
  ]);
  parsed.modules = modules;

  const built = await bundleGraph(collectGraph(parsed, modules[0]), {
    shim: 'globalThis.Bun = {};\n',
    polyfills: '/* POLYFILLS */',
    version: '9.9.9',
    target: 'node18'
  });

  assert.deepEqual(
    built.map((b) => b.name),
    ['cli.js', 'src/w/worker.js']
  );
  const cli = built[0].code;
  assert.ok(cli.startsWith('#!/usr/bin/env node\n'));
  assert.ok(cli.includes('/* POLYFILLS */'));
  assert.ok(cli.includes('// Claude Code notice.')); // entry header carried across
  assert.ok(cli.includes('globalThis.Bun'));
  assert.ok(!/import\s*\{/.test(cli), 'no ESM import survives into the CJS output');
  // the nested output resolves the bunfs root back up to the dir cli.js lives in
  assert.ok(cli.includes('var __cc2js_root = __dirname;'));
  assert.ok(built[1].code.includes('var __cc2js_root = require("path").resolve(__dirname, "../..");'));

  // …and it actually runs: chunks inlined, the .md left for require() to resolve
  const exports: Record<string, unknown> = {};
  const mod = { exports };
  const fn = vm.compileFunction(cli.replace(/^#![^\n]*\n/, ''), [
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname'
  ]);
  const req = (p: string) => (p.startsWith(R) ? 'MD:' + p : require(p)); // the shim resolves bunfs paths for real
  fn(exports, req, mod, '/out/cli.js', '/out');
  // Bun's own `import.meta.dir` (2.1.280's built-in plugins read it) is `dirname` too
  assert.deepEqual(await mod.exports, { hi: 'hi', bye: 'bye', root: '/out', dir: '/out', md: 'MD:/$bunfs/root/n.md' });
});

// A graph whose chunk defines the built-in plugins' hooks-module helper as `lq`.
async function bundleHooksHelper(lq: string, warnings: string[]): Promise<unknown> {
  const helper =
    'function ku(){return typeof Bun<"u"&&Bun.isStandaloneExecutable===!0}' +
    'var Tr=(e,o,r)=>({module:e,scan:o,dir:r});' +
    lq;
  const { parsed, modules } = fakeBinary([
    {
      name: R + 'cli',
      body: 'import{Lq}from"/$bunfs/root/chunk-kt.js";module.exports=Lq(import.meta.dir,"m",()=>"s");'
    },
    { name: R + 'chunk-kt.js', body: helper + 'export{Lq};' }
  ]);
  parsed.modules = modules;
  const [cli] = await bundleGraph(collectGraph(parsed, modules[0]), {
    shim: 'globalThis.Bun = {};\n',
    polyfills: '',
    version: '9.9.9',
    target: 'node18',
    warn: (msg) => warnings.push(msg)
  });
  const mod = { exports: {} };
  vm.compileFunction(cli.code.replace(/^#![^\n]*\n/, ''), ['exports', 'require', 'module', '__filename', '__dirname'])(
    mod.exports,
    require,
    mod,
    '/out/cli.js',
    '/out'
  );
  return mod.exports;
}

test('bundleGraph hands built-in plugins the compiled-in hooks module, not a source folder', async () => {
  // 2.1.280's helper, verbatim but for Tr: ku() is false under Node, which would
  // send every built-in plugin looking for hooks/register.ts on disk
  const warnings: string[] = [];
  const out = await bundleHooksHelper('var Lq=(e,o,r)=>ku()?Tr(o,r(),e):{module:o,folder:e};', warnings);
  assert.deepEqual(out, { module: 'm', scan: 's', dir: '/out' });
  assert.deepEqual(warnings, []);
});

test('bundleGraph warns when a release reshapes the hooks-module helper past the patch', async () => {
  const warnings: string[] = [];
  const out = await bundleHooksHelper('var Lq=(e,o,r)=>ku()&&!0?Tr(o,r(),e):{module:o,folder:e};', warnings);
  assert.deepEqual(out, { module: 'm', folder: '/out' }); // left as is
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /chunk-kt\.js/);
});
