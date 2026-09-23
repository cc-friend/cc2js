/*
 * convert: the full pipeline.
 *   obtain binary → parse module graph (unbunjs) → de-bun cli.js → transpile to a
 *   single Node-18 cli.js → write the embedded files → package.json + npm install →
 *   fetch ripgrep → write README.
 *
 * Two bundle shapes ship in the wild and both are handled: one self-contained CJS
 * bundle (up to ~2.1.235) goes through debun() + transpile(); a code-split ESM
 * module graph (~2.1.243 onwards) is re-bundled to the same single-file result by
 * bundle.ts. Everything downstream of step 4 is identical either way.
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { type BunModule, getModuleContents, getModuleSource, type ParsedBunBinary, parseBuffer } from 'unbunjs';

import { type BundledFile, bundleGraph, bunfsRelative, collectGraph, isEsmGraph } from './bundle';
import { debun } from './debun';
import { hostPlatform, obtainBinary } from './download';
import defaultLog, { type Logger } from './log';
import { fetchRipgrep } from './ripgrep';
import { transpile } from './transpile';
import { sniffVersion } from './version';

const ASSETS = path.join(__dirname, '..', 'assets');

// Runtime modules Bun provided natively that the bundle require()s under Node.
// undici pinned to ^6 so ONE install works on Node 18–22+ (undici 7/8 need Node 20+).
export const RUNTIME_DEPS: Record<string, string> = {
  ws: '^8.18.0',
  undici: '^6.21.3',
  ajv: '^8.17.1',
  'ajv-formats': '^3.0.1'
};

export interface ConvertOptions {
  input: string;
  platform?: string;
  target?: string;
  out?: string;
  ripgrep?: boolean;
  install?: boolean;
  keepTemp?: boolean;
  log?: Logger;
}

export interface ConvertResult {
  version: string;
  platform: string;
  outDir: string;
  modules: number;
}

function fmtBytes(n: number): string {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function basename(name: string): string {
  // strip up to the last / or \ (win32 Bun binaries use backslash module paths)
  return name.replace(/^.*[\\/]/, '');
}

// zstd magic. The bundle sniffs it before reaching for Bun.zstdDecompressSync(),
// so an already-inflated asset is simply used as-is.
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const zstdDecompressSync = (zlib as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;

/*
 * Write one embedded file next to cli.js, under the path the bundle asks for.
 *
 * Text modules are stored as encoded JS strings that Bun decoded on read, so they
 * go back out as UTF-8 (unbun's getModuleSource honours the encoding Bun tagged
 * them with — latin1 or UTF-16LE); `binary` ones are byte-exact. Bun served the `.zst` assets
 * compressed and the bundle inflates them with Bun.zstdDecompress — Node only grew
 * zstd in 22.15/23.8, so inflate here whenever the converting Node can, and ship
 * the rest compressed for the shim to handle at runtime.
 */
function writeEmbedded(outDir: string, parsed: ParsedBunBinary, mod: BunModule): number {
  const root = path.resolve(outDir); // `out` may be relative when convert() is called as a library
  const dest = path.resolve(root, ...bunfsRelative(mod.name).split('/'));
  if (!dest.startsWith(root + path.sep)) throw new Error('embedded file escapes the output dir: ' + mod.name);
  let content: Buffer | string;
  if (mod.encoding === 'binary') {
    const raw = getModuleContents(parsed, mod);
    content = raw;
    if (zstdDecompressSync && ZSTD_MAGIC.every((b, i) => raw[i] === b)) {
      try {
        content = zstdDecompressSync(raw);
      } catch {
        /* leave it compressed — the shim inflates it at runtime */
      }
    }
  } else {
    content = getModuleSource(parsed, mod);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  return Buffer.byteLength(content);
}

// entry = the module Bun marked as entry; fall back to a cli.js by name, then largest js.
export function pickEntry(mods: BunModule[]): BunModule | undefined {
  return (
    mods.find((m) => m.is_entry_point) ??
    mods.find((m) => /(^|[\\/])cli\.js$/.test(m.name)) ??
    mods.filter((m) => /\.(c|m)?js$/.test(m.name)).sort((a, b) => b.contents_length - a.contents_length)[0]
  );
}

export async function convert(opts: ConvertOptions): Promise<ConvertResult> {
  const log = opts.log || defaultLog;
  const platform = opts.platform || hostPlatform();
  const doInstall = opts.install !== false;
  const doRipgrep = opts.ripgrep !== false;
  const target = opts.target || 'node18';

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2js-'));
  const cleanup = () => {
    if (opts.keepTemp) {
      log.info('kept temp dir ' + workDir);
      return;
    }
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    // 1) obtain the Bun binary
    const binPath = await obtainBinary(opts.input, platform, workDir, log);
    log.ok('binary ready (' + fmtBytes(fs.statSync(binPath).size) + ')');

    // 2) parse the embedded module graph with unbunjs
    log.step('Parsing Bun module graph (unbunjs)');
    const parsed = parseBuffer(fs.readFileSync(binPath));
    const entry = pickEntry(parsed.modules);
    if (!entry) throw new Error('could not identify the cli.js entry module');
    const entrySource = getModuleSource(parsed, entry);
    const version = sniffVersion(entrySource) || (/^[0-9.]+/.test(String(opts.input)) ? opts.input : 'unknown');
    log.ok(
      'found ' +
        parsed.modules.length +
        ' modules; entry=' +
        basename(entry.name) +
        ' (' +
        fmtBytes(entrySource.length) +
        '); version=' +
        version
    );

    // 3) output dir
    const outDir = opts.out || path.resolve(process.cwd(), 'cc2js-' + version + '-' + platform);
    fs.mkdirSync(outDir, { recursive: true });

    // 4) de-bun + transpile to a single Node-18 cli.js
    log.step('De-bunning + transpiling cli.js (' + target + ')');
    const shimSource = fs.readFileSync(path.join(ASSETS, 'bun-shim.cjs'), 'utf8');
    const polyfills = fs.readFileSync(path.join(ASSETS, 'polyfills.cjs'), 'utf8');

    const graph = isEsmGraph(entry, entrySource) ? collectGraph(parsed, entry) : null;
    let builds: BundledFile[];
    if (graph) {
      log.info('code-split ESM entry — re-bundling ' + graph.files.size + ' modules');
      builds = await bundleGraph(graph, { shim: shimSource, polyfills, version, target, warn: (msg) => log.warn(msg) });
    } else {
      builds = [{ name: 'cli.js', code: await transpile(debun(entrySource, shimSource, version), polyfills, target) }];
    }
    for (const b of builds) {
      const p = path.join(outDir, b.name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, b.code);
      fs.chmodSync(p, 0o755);
      log.ok(b.name + ' (' + fmtBytes(Buffer.byteLength(b.code)) + ')  [target ' + target + ']');
    }
    fs.copyFileSync(path.join(ASSETS, 'bun-shim.cjs'), path.join(outDir, 'bun-shim.cjs'));

    // 5) every embedded file that did NOT get compiled into the builds above —
    // native addons, text/binary assets, and (single-bundle shape) the sibling
    // CJS modules. They keep their path under /$bunfs/root/, which the shim
    // redirects to this dir at runtime.
    const compiled = new Set(graph ? graph.files.keys() : [entry.name]);
    const addons: string[] = [];
    let assets = 0;
    let assetBytes = 0;
    for (const m of parsed.modules) {
      if (compiled.has(m.name)) continue;
      const size = writeEmbedded(outDir, parsed, m);
      assets++;
      assetBytes += size;
      if (/\.(node|wasm)$/.test(m.name)) addons.push(basename(m.name) + ' (' + fmtBytes(size) + ')');
    }
    if (addons.length) log.ok('native addons: ' + addons.join(', '));
    if (assets > addons.length) {
      log.ok('embedded files: ' + assets + ' (' + fmtBytes(assetBytes) + ')');
    }

    // 6) output package.json + runtime deps
    const outPkg = {
      name: 'claude-code-' + version + '-node',
      version: '1.0.0',
      private: true,
      description: 'Pure-Node build of Claude Code ' + version + ' (' + platform + '), de-bunned by cc2js.',
      type: 'commonjs',
      bin: { claude: 'cli.js' },
      engines: { node: '>=18' },
      dependencies: RUNTIME_DEPS
    };
    fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(outPkg, null, 2) + '\n');

    if (doInstall) {
      log.step('Installing runtime deps (ws, undici, ajv, ajv-formats)');
      try {
        cp.execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', { cwd: outDir, stdio: 'inherit' });
        log.ok('node_modules installed');
      } catch (e) {
        log.warn('npm install failed (' + (e as Error).message + '). Run `npm install` in ' + outDir + ' manually.');
      }
    }

    // 7) ripgrep
    if (doRipgrep) {
      log.step('Fetching ripgrep');
      const rgName = platform.startsWith('win32-') ? 'rg.exe' : 'rg';
      try {
        if (await fetchRipgrep(platform, path.join(outDir, rgName), workDir, log)) log.ok('rg bundled');
      } catch (e) {
        log.warn('ripgrep fetch failed (' + (e as Error).message + '). Grep/Glob will use rg from PATH.');
      }
    }

    // 8) output README
    writeOutputReadme(outDir, version, platform);

    log.step('Done → ' + outDir);
    return { version, platform, outDir, modules: parsed.modules.length };
  } finally {
    cleanup();
  }
}

function writeOutputReadme(outDir: string, version: string, platform: string): void {
  const lines = [
    '# Claude Code ' + version + ' — pure-Node build (' + platform + ')',
    '',
    'Produced by **cc2js** from the Bun-compiled `claude` binary. No Bun runtime required.',
    '',
    '```sh',
    'node cli.js --version',
    'node cli.js                    # interactive TUI',
    '```',
    '',
    '`cli.js` runs on Node 18+. Auth/config are read from `~/.claude`, like the official build.',
    '',
    '## Files',
    '- `cli.js` — de-bunned + transpiled bundle (Bun shim + runtime polyfills inlined); Node 18+',
    '- `bun-shim.cjs` — Bun→Node compatibility layer (reference copy; already inlined into cli.js)',
    '- `*.node` — native addons extracted from the Bun binary',
    '- `*.md`, `*.txt`, `*.zst`, … — assets the bundle reads back by `/$bunfs/root/…` path',
    '- `src/…` — modules the bundle loads by path at runtime (e.g. the function-hooks worker)',
    '- `rg` — ripgrep (Grep/Glob); the shim puts this dir on PATH',
    '- `node_modules/` — ws, undici, ajv, ajv-formats (Bun provided these natively)',
    ''
  ];
  fs.writeFileSync(path.join(outDir, 'README.md'), lines.join('\n'));
}
