/*
 * cc2js E2E harness (manual; network + large downloads).
 *
 *   tsx test/e2e.ts [options]
 *
 * Converts each requested Claude Code version with cc2js (cached under
 * test/.cache/<version>-<platform>), then runs the single produced cli.js under
 * every runnable Node major and checks `--version` prints "<version> (Claude Code)".
 *
 * Options: --versions a,b,c  --platform p  --nodes 18,20  --this-node
 *          --convert-only  --no-convert  --force  --quick
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChannel } from '../src/download';

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(__dirname, '.cache');
const BIN = path.join(ROOT, 'dist', 'cli.js');

// Single-file output (the old cli.node18/20/22.js + raw cli.js matrix collapsed to one).
const BUILDS = [{ file: 'cli.js', min: 18 }];

interface Args {
  versions: string[];
  platform: string;
  nodes: number[] | null;
  force: boolean;
  quick: boolean;
  convertOnly: boolean;
  noConvert: boolean;
  thisNode: boolean;
}

interface NodeInfo {
  v: string;
  bin: string;
}
interface NodeSet {
  map: Record<number, NodeInfo>;
  majors: number[];
  unrunnable: string[];
}
interface Cell {
  ok?: boolean;
  out?: string;
  status?: number | null;
  na?: boolean;
}
interface Rec {
  version: string;
  convertOk: boolean;
  outDir: string;
  cells: Record<string, Record<number, Cell>>;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    versions: ['2.1.113', '2.1.126', '2.1.153', '2.1.185', '2.1.191', 'latest'],
    platform: 'linux-x64',
    nodes: null,
    force: false,
    quick: false,
    convertOnly: false,
    noConvert: false,
    thisNode: false
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--versions') a.versions = argv[++i].split(',').map((s) => s.trim());
    else if (x === '--platform') a.platform = argv[++i];
    else if (x === '--nodes') a.nodes = argv[++i].split(',').map((s) => Number.parseInt(s, 10));
    else if (x === '--force') a.force = true;
    else if (x === '--quick') a.quick = true;
    else if (x === '--convert-only') a.convertOnly = true;
    else if (x === '--no-convert') a.noConvert = true;
    else if (x === '--this-node') a.thisNode = true;
  }
  if (a.quick) a.versions = a.versions.slice(0, 1);
  return a;
}

function cmpVer(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// discover installed node binaries: major -> {v, bin} (prefer nvm, include current)
function discoverNodes(wanted: number[] | null): NodeSet {
  const found: Record<number, NodeInfo> = {};
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvmDir)) {
      const m = v.match(/^v(\d+)\.(\d+)\.(\d+)/);
      if (!m) continue;
      const maj = Number.parseInt(m[1], 10);
      const bin = path.join(nvmDir, v, 'bin', 'node');
      if (!fs.existsSync(bin)) continue;
      if (!found[maj] || cmpVer(v, found[maj].v) > 0) found[maj] = { v, bin };
    }
  } catch {
    /* no nvm */
  }
  const cur = process.versions.node;
  const curMaj = Number.parseInt(cur.split('.')[0], 10);
  if (!found[curMaj]) found[curMaj] = { v: 'v' + cur, bin: process.execPath };

  let majors = Object.keys(found)
    .map(Number)
    .sort((a, b) => a - b);
  if (wanted) majors = majors.filter((m) => wanted.includes(m));
  // verify each binary actually runs on this host (older macOS can't run prebuilt newer Node).
  const unrunnable: string[] = [];
  majors = majors.filter((m) => {
    const r = cp.spawnSync(found[m].bin, ['--version'], { encoding: 'utf8', timeout: 20000 });
    const ok = r.status === 0 && /^v\d+\./.test((r.stdout || '').trim());
    if (!ok) unrunnable.push(found[m].v + (r.stderr ? ' (' + r.stderr.trim().split('\n')[0].slice(0, 60) + ')' : ''));
    return ok;
  });
  return { map: found, majors, unrunnable };
}

function thisNodeOnly(): NodeSet {
  const cur = process.versions.node;
  const maj = Number.parseInt(cur.split('.')[0], 10);
  const map: Record<number, NodeInfo> = {};
  map[maj] = { v: 'v' + cur, bin: process.execPath };
  return { map, majors: [maj], unrunnable: [] };
}

function listCachedVersions(platform: string): string[] {
  const suffix = '-' + platform;
  try {
    return fs
      .readdirSync(CACHE)
      .filter((d) => d.slice(-suffix.length) === suffix && fs.existsSync(path.join(CACHE, d, 'cli.js')))
      .map((d) => d.slice(0, d.length - suffix.length))
      .sort();
  } catch {
    return [];
  }
}

function convertVersion(
  version: string,
  platform: string,
  force: boolean,
  noConvert: boolean
): { outDir: string; cached: boolean; ok: boolean } {
  const outDir = path.join(CACHE, version + '-' + platform);
  const marker = path.join(outDir, 'cli.js');
  if (noConvert) return { outDir, cached: true, ok: fs.existsSync(marker) };
  if (!force && fs.existsSync(marker)) return { outDir, cached: true, ok: true };
  const local = '/tmp/cc-' + version + '.tar.gz';
  const input = fs.existsSync(local) ? local : version;
  process.stdout.write(
    '\n=== converting ' +
      version +
      ' (' +
      platform +
      ') from ' +
      (input === version ? 'downloads.claude.ai' : path.basename(input)) +
      ' ===\n'
  );
  const r = cp.spawnSync(process.execPath, [BIN, input, '--platform', platform, '--out', outDir], { stdio: 'inherit' });
  return { outDir, cached: false, ok: r.status === 0 };
}

function runBuild(nodeBin: string, buildPath: string, expectVersion: string): Cell {
  const r = cp.spawnSync(nodeBin, [buildPath, '--version'], { encoding: 'utf8', timeout: 60000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const ok = r.status === 0 && out.includes(expectVersion + ' (Claude Code)');
  return { ok, out: out.split('\n')[0] || '', status: r.status };
}

function pad(s: string, n: number): string {
  let str = String(s);
  while (str.length < n) str += ' ';
  return str;
}

async function resolveVersions(list: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const v of list) {
    const real = await resolveChannel(v);
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE, { recursive: true });

  // cc2js runs from dist/; build it before converting (unless only reading cache).
  if (!args.noConvert) {
    process.stdout.write('building cc2js (npm run build)...\n');
    cp.execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  }

  const versions = args.noConvert ? listCachedVersions(args.platform) : await resolveVersions(args.versions);
  if (!versions.length) {
    console.error(
      args.noConvert ? 'no cached conversions for ' + args.platform + ' in ' + CACHE : 'no versions to test'
    );
    process.exit(2);
  }

  // ---- convert-only: just build + cache ----
  if (args.convertOnly) {
    console.log('cc2js convert-only — ' + args.platform + ' — ' + versions.join(', '));
    let allOk = true;
    for (const v of versions) {
      const c = convertVersion(v, args.platform, args.force, false);
      console.log((c.ok ? 'OK   ' : 'FAIL ') + v + (c.cached ? ' (cached)' : ''));
      if (!c.ok) allOk = false;
    }
    process.exit(allOk ? 0 : 1);
  }

  const nodes = args.thisNode ? thisNodeOnly() : discoverNodes(args.nodes);
  if (!nodes.majors.length) {
    console.error('no runnable Node versions found');
    process.exit(2);
  }

  console.log('cc2js e2e harness');
  console.log('  platform : ' + args.platform);
  console.log('  versions : ' + versions.join(', '));
  console.log('  node     : ' + nodes.majors.map((m) => nodes.map[m].v).join(', '));
  if (nodes.unrunnable.length) {
    console.log('  skipped  : ' + nodes.unrunnable.join(', ') + '  — cannot run on this host');
  }

  const results: Rec[] = [];
  for (const version of versions) {
    const conv = convertVersion(version, args.platform, args.force, args.noConvert);
    const rec: Rec = { version, convertOk: conv.ok, outDir: conv.outDir, cells: {} };
    if (conv.ok) {
      for (const b of BUILDS) {
        const bpath = path.join(conv.outDir, b.file);
        if (!fs.existsSync(bpath)) continue;
        rec.cells[b.file] = {};
        for (const maj of nodes.majors) {
          if (maj < b.min) {
            rec.cells[b.file][maj] = { na: true };
            continue;
          }
          rec.cells[b.file][maj] = runBuild(nodes.map[maj].bin, bpath, version);
        }
      }
    }
    results.push(rec);
  }

  // ---- report ----
  let totalPass = 0;
  let totalRun = 0;
  let totalFail = 0;
  console.log('\n================ RESULTS ================');
  for (const r of results) {
    console.log('\nClaude Code ' + r.version + (r.convertOk ? '' : '   <-- CONVERSION/CACHE MISSING'));
    if (!r.convertOk) {
      totalFail++;
      continue;
    }
    let header = '  ' + pad('build', 18);
    for (const maj of nodes.majors) header += pad('node' + maj, 9);
    console.log(header);
    for (const file of Object.keys(r.cells)) {
      let row = '  ' + pad(file, 18);
      for (const maj of nodes.majors) {
        const c = r.cells[file][maj];
        let cell: string;
        if (!c) cell = '-';
        else if (c.na) cell = '·';
        else {
          totalRun++;
          if (c.ok) {
            totalPass++;
            cell = 'PASS';
          } else {
            totalFail++;
            cell = 'FAIL';
          }
        }
        row += pad(cell, 9);
      }
      console.log(row);
    }
  }
  console.log('\n=========================================');
  console.log('legend: PASS=ran & printed version  ·=N/A (build needs newer Node)  FAIL=error/wrong output');
  console.log(
    'totals: ' +
      totalPass +
      '/' +
      totalRun +
      ' runs passed; ' +
      results.filter((r) => r.convertOk).length +
      '/' +
      results.length +
      ' versions converted'
  );
  process.exit(totalFail === 0 && totalRun > 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error((e as Error)?.stack || e);
  process.exit(1);
});
