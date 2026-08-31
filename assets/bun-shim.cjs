'use strict';
/*
 * Bun -> Node compatibility shim for the de-bunned Claude Code 2.1.185 bundle.
 * Provides globalThis.Bun with the ~18 APIs the bundle calls directly, and
 * redirects Bun's virtual-fs requires — POSIX /$bunfs/root/ and Windows
 * B:\~BUN\root\ — to the native addons next to cli.js.
 * Goal: run the Bun-target bundle on plain Node, no Bun runtime.
 */
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const util = require('util');
const net = require('net');
const zlib = require('zlib');
const { Readable, Writable } = require('stream');
const Module = require('module');

// ---- redirect Bun's in-binary virtual fs to local files next to cli.js ----
// Bun uses /$bunfs/root/X on POSIX and B:\~BUN\root\X (or B:/~BUN/root/X) on
// Windows. Map any of these prefixes onto the dir cc2js extracted the embedded
// files into — cli.js's own dir. cc2js declares __cc2js_root above this shim so
// the nested worker bundles point at the same place; when this file is required
// directly (the reference copy next to cli.js) it falls back to its own dir.
const BUNFS_ROOT = typeof __cc2js_root === 'string' ? __cc2js_root : __dirname;
const BUNFS_PREFIXES = ['/$bunfs/root/', 'B:\\~BUN\\root\\', 'B:/~BUN/root/'];
function bunfsPath(request) {
  for (const pre of BUNFS_PREFIXES) {
    if (request.startsWith(pre)) return path.join(BUNFS_ROOT, request.slice(pre.length).replace(/\\/g, '/'));
  }
  return null;
}

const _resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  const mapped = typeof request === 'string' ? bunfsPath(request) : null;
  return mapped || _resolveFilename.call(this, request, parent, isMain, options);
};

// Bun also served the embedded files through fs: since 2.1.24x the bundle
// readFileSync()s its skill/doc assets by absolute /$bunfs/root/… path. Redirect
// those reads to the extracted copies; every other path passes through.
function redirectFs(obj, names) {
  for (const name of names) {
    const orig = obj[name];
    if (typeof orig !== 'function') continue;
    obj[name] = function (p, ...rest) {
      return orig.call(this, (typeof p === 'string' && bunfsPath(p)) || p, ...rest);
    };
  }
}
redirectFs(fs, ['readFileSync', 'readFile', 'existsSync', 'statSync', 'openSync', 'accessSync', 'createReadStream']);
redirectFs(fs.promises, ['readFile', 'stat', 'access', 'open']);

// Bun's require() of an embedded .md/.txt asset hands back its text (the `text`
// loader). Node has no loader for those extensions and would parse them as JS.
for (const ext of ['.md', '.txt']) {
  Module._extensions[ext] = (mod, filename) => {
    mod.exports = fs.readFileSync(filename, 'utf8');
  };
}

// make sibling executables (the bundled ripgrep) discoverable on PATH so the
// bundle's system-rg fallback resolves `rg` out of the box.
process.env.PATH = BUNFS_ROOT + path.delimiter + (process.env.PATH || '');

// Bun-only modules the bundle require()s (Bun provided them natively; not bundled).
// `bun:ffi` is used to dlopen the system keychain lib — stub it so the bundle's
// try/catch falls back to file-based credential storage instead of crashing.
const _load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'bun:ffi') {
    return {
      dlopen() { throw new Error('bun:ffi unavailable under Node'); },
      CString: class CString {}, FFIType: {}, suffix: process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so',
      ptr() { return 0n; }, read: {}, toArrayBuffer() { return new ArrayBuffer(0); },
    };
  }
  if (request.startsWith('bun:')) return {};       // bun:jsc, bun:sqlite, … (unused paths)
  return _load.apply(this, arguments);
};

// ---------------------------- ANSI / width ----------------------------------
const ANSI_RE = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)' +
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  'g'
);
const stripANSI = (s) => String(s).replace(ANSI_RE, '');
function cpWidth(c) {
  if (c === 0) return 0;
  if (c < 32 || (c >= 0x7f && c < 0xa0)) return 0;          // control
  // zero-width: combining marks, joiners, variation selectors, BOM
  if ((c>=0x300&&c<=0x36f)||(c>=0x483&&c<=0x489)||(c>=0x591&&c<=0x5bd)||
      (c>=0x610&&c<=0x61a)||(c>=0x64b&&c<=0x65f)||(c>=0x6d6&&c<=0x6dc)||
      (c>=0x200b&&c<=0x200f)||(c>=0x202a&&c<=0x202e)||(c>=0x2060&&c<=0x2064)||
      c===0xfeff||(c>=0xfe00&&c<=0xfe0f)||(c>=0xfe20&&c<=0xfe2f)||
      (c>=0x1ab0&&c<=0x1aff)||(c>=0x1dc0&&c<=0x1dff)||(c>=0xe0100&&c<=0xe01ef)) return 0;
  // wide: East Asian Wide/Fullwidth + emoji
  if ((c>=0x1100&&c<=0x115f)||c===0x2329||c===0x232a||
      (c>=0x2e80&&c<=0x303e)||(c>=0x3041&&c<=0x33ff)||(c>=0x3400&&c<=0x4dbf)||
      (c>=0x4e00&&c<=0x9fff)||(c>=0xa000&&c<=0xa4cf)||(c>=0xa960&&c<=0xa97f)||
      (c>=0xac00&&c<=0xd7a3)||(c>=0xf900&&c<=0xfaff)||(c>=0xfe10&&c<=0xfe19)||
      (c>=0xfe30&&c<=0xfe6f)||(c>=0xff00&&c<=0xff60)||(c>=0xffe0&&c<=0xffe6)||
      (c>=0x1f000&&c<=0x1f0ff)||(c>=0x1f100&&c<=0x1f2ff)||(c>=0x1f300&&c<=0x1f64f)||
      (c>=0x1f900&&c<=0x1f9ff)||(c>=0x1fa00&&c<=0x1faff)||
      (c>=0x20000&&c<=0x3fffd)) return 2;
  return 1;
}
function stringWidth(s) {
  s = stripANSI(String(s));
  let w = 0;
  for (const ch of s) w += cpWidth(ch.codePointAt(0));
  return w;
}
// ANSI-aware word wrap: escapes are kept but contribute 0 width; whole words
// move to the next line, and only over-long words are hard-broken. Never
// overflows `cols`.
function wrapAnsi(s, cols, opts = {}) {
  cols = Math.max(1, cols || 80);
  const tok = (text) => {
    const re = new RegExp(ANSI_RE.source + '|[\\s\\S]', 'gu');
    const arr = []; let m;
    while ((m = re.exec(text))) {
      const t = m[0], code = t.charCodeAt(0), ansi = code === 0x1b || code === 0x9b;
      arr.push({ t, w: ansi ? 0 : cpWidth(t.codePointAt(0)) });
    }
    return arr;
  };
  const out = [];
  for (const rawLine of String(s).split('\n')) {
    // group tokens into words (maximal non-space runs) and single-space separators
    const words = []; let cur = null;
    for (const tk of tok(rawLine)) {
      if (tk.w === 1 && tk.t === ' ') { words.push({ space: true }); cur = null; continue; }
      if (!cur) { cur = { text: '', w: 0 }; words.push(cur); }
      cur.text += tk.t; cur.w += tk.w;
    }
    let line = '', lineW = 0;
    const push = () => { out.push(line); line = ''; lineW = 0; };
    for (const word of words) {
      if (word.space) { if (lineW > 0 && lineW + 1 <= cols) { line += ' '; lineW += 1; } continue; }
      if (lineW > 0 && lineW + word.w > cols) push();          // wrap before whole word
      if (word.w <= cols) { line += word.text; lineW += word.w; continue; }
      for (const tk of tok(word.text)) {                       // hard-break over-long word
        if (lineW > 0 && lineW + tk.w > cols) push();
        line += tk.t; lineW += tk.w;
      }
    }
    push();
  }
  return out.join('\n');
}

// ---------------------------- hash (64-bit) ---------------------------------
// Bun.hash defaults to wyhash; we only need a deterministic 64-bit value
// (used for in-process keys/dedup). FNV-1a 64 returning BigInt suffices.
const U64 = (1n << 64n) - 1n;
function bunHash(data, seed) {
  const buf = Buffer.isBuffer(data) ? data
            : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            : Buffer.from(String(data), 'utf8');
  let h = (0xcbf29ce484222325n ^ (seed != null ? BigInt(seed) & U64 : 0n)) & U64;
  for (let i = 0; i < buf.length; i++) { h = (h ^ BigInt(buf[i])) & U64; h = (h * 0x100000001b3n) & U64; }
  return h; // BigInt; bundle handles bigint and calls .toString()/.toString(36)
}

// ---------------------------- semver ----------------------------------------
function parseV(v) {
  const s = String(v).trim().replace(/^[v=\s]+/, '');
  const [core, pre = ''] = s.split('-');
  const p = core.split('.');
  return { major: +p[0] || 0, minor: +p[1] || 0, patch: +p[2] || 0, pre };
}
function vcmp(a, b) {
  const x = parseV(a), y = parseV(b);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}
function satisfies(v, range) {
  range = String(range).trim();
  if (range === '' || range === '*' || range === 'x') return true;
  if (range.includes('||')) return range.split('||').some((r) => satisfies(v, r));
  const parts = range.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.every((p) => satisfies(v, p));
  const m = range.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/);
  const op = m[1] || '=', ver = m[2], c = vcmp(v, ver), pv = parseV(ver), hv = parseV(v);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '=': return c === 0;
    case '^':
      if (c < 0) return false;
      if (pv.major > 0) return hv.major === pv.major;
      if (pv.minor > 0) return hv.major === 0 && hv.minor === pv.minor;
      return hv.major === 0 && hv.minor === 0 && hv.patch === pv.patch;
    case '~':
      return c >= 0 && hv.major === pv.major && hv.minor === pv.minor;
  }
  return false;
}

// ---------------------------- which -----------------------------------------
function which(cmd, opts) {
  const win = process.platform === 'win32';
  const exts = win ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const tryp = (p) => { for (const e of exts) { const f = p + e; try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {} } return null; };
  if (cmd.includes('/') || (win && cmd.includes('\\'))) return tryp(cmd);
  const PATH = (opts && opts.PATH) || process.env.PATH || '';
  for (const d of PATH.split(path.delimiter)) { if (!d) continue; const r = tryp(path.join(d, cmd)); if (r) return r; }
  return null;
}

// ---------------------------- spawn -----------------------------------------
function toStdio(v) {
  if (v === 'inherit' || v === 'ignore' || v === 'pipe' || v === null) return v;
  if (typeof v === 'number') return v;             // fd
  return 'pipe';                                    // string/Buffer/typedarray input -> pipe & write
}
function bunSpawn(cmd, opts = {}) {
  if (!Array.isArray(cmd)) { opts = cmd; cmd = opts.cmd; }
  const [file, ...args] = cmd;
  const stdin = opts.stdin, stdout = opts.stdout, stderr = opts.stderr;
  const child = cp.spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    argv0: opts.argv0,
    stdio: [toStdio(stdin) ?? 'ignore', toStdio(stdout) ?? 'pipe', toStdio(stderr) ?? 'pipe'],
    windowsHide: true,
  });
  // feed inline stdin input
  if (stdin != null && stdin !== 'inherit' && stdin !== 'ignore' && stdin !== 'pipe' && typeof stdin !== 'number' && child.stdin) {
    const data = typeof stdin === 'string' ? Buffer.from(stdin)
               : ArrayBuffer.isView(stdin) ? Buffer.from(stdin.buffer, stdin.byteOffset, stdin.byteLength)
               : Buffer.from(String(stdin));
    child.stdin.end(data);
  }
  let resolveExit, rejectExit;
  const exited = new Promise((res, rej) => { resolveExit = res; rejectExit = rej; });
  const proc = {
    pid: child.pid,
    exitCode: null,
    signalCode: null,
    exited,
    stdout: child.stdout ? Readable.toWeb(child.stdout) : null,
    stderr: child.stderr ? Readable.toWeb(child.stderr) : null,
    stdin: child.stdin ? {
      write: (d) => child.stdin.write(d),
      end: () => child.stdin.end(),
      flush: () => {},
      ref: () => {}, unref: () => {},
    } : null,
    kill: (sig) => child.kill(sig || 'SIGTERM'),
    ref: () => child.ref && child.ref(),
    unref: () => child.unref && child.unref(),
    resourceUsage: () => ({}),
  };
  child.on('error', (e) => rejectExit(e));
  child.on('exit', (code, signal) => { proc.exitCode = code; proc.signalCode = signal; resolveExit(code == null ? 128 : code); });
  return proc;
}

// ---------------------------- listen (TCP) ----------------------------------
function bunListen(opts) {
  const handlers = opts.socket || {};
  const wrap = (sock) => {
    const w = {
      write: (d) => sock.write(d),
      end: (d) => sock.end(d),
      flush: () => {},
      remoteAddress: sock.remoteAddress,
      ref: () => sock.ref(), unref: () => sock.unref(),
    };
    sock.__bun = w; return w;
  };
  const server = net.createServer((sock) => {
    const w = wrap(sock);
    handlers.open && handlers.open(w);
    sock.on('data', (b) => handlers.data && handlers.data(w, b));
    sock.on('close', () => handlers.close && handlers.close(w));
    sock.on('error', (e) => handlers.error && handlers.error(w, e));
  });
  server.listen(opts.port || 0, opts.hostname || '127.0.0.1');
  return {
    get port() { const a = server.address(); return a && a.port; },
    hostname: opts.hostname || '127.0.0.1',
    stop: () => server.close(),
    ref: () => server.ref(), unref: () => server.unref(),
    reload: () => {},
  };
}

// ---------------------------- transpiler ------------------------------------
// Bun.Transpiler: only the js/replMode path is exercised on common flows.
class Transpiler {
  constructor(o = {}) { this.opts = o; }
  transformSync(code) { return String(code); }
  transform(code) { return Promise.resolve(String(code)); }
  scan() { return { imports: [], exports: [] }; }
  scanImports() { return []; }
}

// ---------------------------- YAML (minimal) --------------------------------
const YAML = {
  parse(src) {
    const lines = String(src).split('\n');
    const root = {};
    const stack = [{ indent: -1, val: root }];
    const scalar = (s) => {
      s = s.trim();
      if (s === '') return '';
      if (s === 'true') return true; if (s === 'false') return false; if (s === 'null' || s === '~') return null;
      if (/^-?\d+(\.\d+)?$/.test(s)) return +s;
      if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) return s.slice(1, -1);
      return s;
    };
    for (let raw of lines) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const indent = raw.match(/^\s*/)[0].length;
      const line = raw.trim();
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const ctx = stack[stack.length - 1].val;
      if (line.startsWith('- ')) {
        if (!Array.isArray(ctx.__list)) ctx.__list = [];
        ctx.__list.push(scalar(line.slice(2)));
        continue;
      }
      const ci = line.indexOf(':');
      if (ci === -1) continue;
      const key = line.slice(0, ci).trim();
      const rest = line.slice(ci + 1).trim();
      if (rest === '') { const obj = {}; ctx[key] = obj; stack.push({ indent, val: obj }); }
      else ctx[key] = scalar(rest);
    }
    const fix = (o) => {
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        if (Array.isArray(o.__list) && Object.keys(o).length === 1) return o.__list.map(fix);
        for (const k of Object.keys(o)) o[k] = fix(o[k]);
      }
      return o;
    };
    return fix(root);
  },
  stringify(obj) {
    const out = [];
    const walk = (o, ind) => {
      const pad = '  '.repeat(ind);
      if (Array.isArray(o)) { for (const v of o) out.push(pad + '- ' + JSON.stringify(v)); return; }
      if (o && typeof o === 'object') { for (const k of Object.keys(o)) {
        const v = o[k];
        if (v && typeof v === 'object') { out.push(pad + k + ':'); walk(v, ind + 1); }
        else out.push(pad + k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));
      } return; }
      out.push(pad + JSON.stringify(o));
    };
    walk(obj, 0);
    return out.join('\n') + '\n';
  },
};

// ---------------------------- JSONL -----------------------------------------
const JSONL = {
  parse: (s) => String(s).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)),
  stringify: (arr) => arr.map((o) => JSON.stringify(o)).join('\n') + '\n',
};

// ---------------------------- Terminal (PTY) --------------------------------
// Bundle has a try/catch fallback ("unavailable (running under Node?)").
class Terminal { constructor() { throw new Error('Bun.Terminal unavailable under Node'); } }

// ---------------------------- zstd ------------------------------------------
// The bundle inflates its embedded .zst assets with these. cc2js inflates them at
// conversion time whenever the converting Node has zstd (Node 22.15+/23.8+), and
// the bundle sniffs the zstd magic before calling in — so this only runs for a
// build converted on an older Node, where zlib may have no zstd to offer.
function zstdSync(buf) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('zstd needs Node 22.15+/23.8+; re-run cc2js on such a Node to inflate the assets up front');
  }
  return zlib.zstdDecompressSync(buf);
}

// ---------------------------- assemble Bun ----------------------------------
const Bun = {
  version: '1.4.0',
  revision: '0000000000000000000000000000000000000000',
  stringWidth,
  wrapAnsi,
  stripANSI,
  hash: bunHash,
  semver: { order: vcmp, satisfies },
  which,
  spawn: bunSpawn,
  listen: bunListen,
  Transpiler,
  YAML,
  JSONL,
  Terminal,
  embeddedFiles: [],
  zstdDecompressSync: zstdSync,
  zstdDecompress: async (buf) => zstdSync(buf),
  deepEquals: (a, b) => util.isDeepStrictEqual(a, b),
  gc: () => { try { global.gc && global.gc(); } catch {} },
  generateHeapSnapshot: () => { try { return require('v8').getHeapStatistics(); } catch { return {}; } },
  get stdin() { return process.stdin; },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  nanoseconds: () => Number(process.hrtime.bigint()),
  inspect: (x) => util.inspect(x),
  env: process.env,
  main: process.argv[1] || '',
};
Bun.hash.wyhash = bunHash;

globalThis.Bun = Bun;
module.exports = Bun;
