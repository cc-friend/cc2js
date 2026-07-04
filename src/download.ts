/*
 * Obtain a Bun-compiled `claude` binary for a given version + platform.
 *
 * Sources, tried in order:
 *   1. downloads.claude.ai  — official installer source; every version + platform,
 *      plus a manifest.json with SHA-256s.
 *   2. GitHub releases       — `claude-<platform>.tar.gz` (recent versions only).
 *   3. npm                   — `@anthropic-ai/claude-code@<version>` tarball.
 *
 * Pure Node (https + child_process tar), Node 18+, works on old macOS/Linux.
 */

import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { Logger } from './log';

const CLAUDE_BASE = 'https://downloads.claude.ai/claude-code-releases';
const GH_BASE = 'https://github.com/anthropics/claude-code/releases/download';

export const PLATFORMS = [
  'linux-x64',
  'linux-x64-musl',
  'linux-arm64',
  'linux-arm64-musl',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
];

export interface DownloadOpts {
  onProgress?: (pct: number, got: number, total: number) => void;
  timeout?: number;
  _redirects?: number;
}

export function hostPlatform(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return 'win32-' + arch;
  if (process.platform === 'darwin') return 'darwin-' + arch;
  // prefer musl static on Linux when we can detect it (works on old glibc too)
  if (process.platform === 'linux') {
    try {
      if (fs.existsSync('/lib/libc.musl-x86_64.so.1') || fs.existsSync('/lib/libc.musl-aarch64.so.1')) {
        return 'linux-' + arch + '-musl';
      }
    } catch {
      /* ignore */
    }
    return 'linux-' + arch;
  }
  return 'linux-' + arch;
}

// ---- low-level GET with redirects, into a file (with progress) ----
export function downloadTo(url: string, dest: string, opts: DownloadOpts = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const redirects = opts._redirects || 0;
    if (redirects > 10) return reject(new Error('too many redirects'));
    const lib: typeof http = url.startsWith('https:') ? (https as unknown as typeof http) : http;
    const req = lib.get(url, { headers: { 'user-agent': 'cc2js', accept: '*/*' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(downloadTo(next, dest, { ...opts, _redirects: redirects + 1 }));
      }
      if (status !== 200) {
        res.resume();
        return reject(Object.assign(new Error('HTTP ' + status + ' for ' + url), { statusCode: status }));
      }
      const total = Number.parseInt(String(res.headers['content-length'] ?? '0'), 10);
      let got = 0;
      let lastPct = -1;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk: Buffer) => {
        got += chunk.length;
        if (opts.onProgress && total) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            opts.onProgress(pct, got, total);
          }
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => resolve(dest));
      });
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 300000, () => {
      req.destroy(new Error('download timeout for ' + url));
    });
  });
}

// ---- GET a small text/JSON body into memory ----
export function getText(url: string, redirects = 0): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (redirects > 10) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'user-agent': 'cc2js', accept: '*/*' } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve(getText(new URL(res.headers.location, url).toString(), redirects + 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(Object.assign(new Error('HTTP ' + status + ' for ' + url), { statusCode: status }));
        }
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          d += c;
        });
        res.on('end', () => resolve(d));
      })
      .on('error', reject);
  });
}

function sha256(file: string): string {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function progressBar(_log: Logger): (pct: number, got: number, total: number) => void {
  return (pct, got, total) => {
    if (!process.stderr.isTTY) return;
    const mb = (got / 1048576).toFixed(1);
    const tmb = (total / 1048576).toFixed(1);
    process.stderr.write('\r      ' + pct + '%  ' + mb + '/' + tmb + ' MB   ');
    if (pct >= 100) process.stderr.write('\r\x1b[K');
  };
}

// ---- source 1: downloads.claude.ai (raw binary + checksum) ----
function fromClaudeAi(version: string, platform: string, dest: string, log: Logger): Promise<string> {
  return getText(CLAUDE_BASE + '/' + version + '/manifest.json').then((body) => {
    let checksum: string | null = null;
    let binaryName = 'claude'; // win32 manifests use "claude.exe"
    try {
      const manifest = JSON.parse(body) as { platforms?: Record<string, { checksum?: string; binary?: string }> };
      const entry = manifest.platforms?.[platform];
      checksum = entry?.checksum ?? null;
      if (entry?.binary) binaryName = entry.binary;
    } catch {
      /* ignore */
    }
    const url = CLAUDE_BASE + '/' + version + '/' + platform + '/' + binaryName;
    log.info('downloads.claude.ai → ' + version + '/' + platform);
    return downloadTo(url, dest, { onProgress: progressBar(log) }).then(() => {
      if (checksum) {
        const actual = sha256(dest);
        if (actual !== checksum)
          throw new Error('checksum mismatch (' + actual.slice(0, 12) + '… ≠ ' + checksum.slice(0, 12) + '…)');
        log.ok('checksum verified (sha256 ' + checksum.slice(0, 12) + '…)');
      } else {
        log.warn('no checksum in manifest for ' + platform + ' — skipping verification');
      }
      return dest;
    });
  });
}

// ---- source 2: GitHub release tarball ----
function fromGitHub(version: string, platform: string, workDir: string, log: Logger): Promise<string> {
  const asset = 'claude-' + platform + '.tar.gz';
  const url = GH_BASE + '/v' + version + '/' + asset;
  const tgz = path.join(workDir, asset);
  log.info('github → ' + asset);
  return downloadTo(url, tgz, { onProgress: progressBar(log) }).then(() => extractBinaryFromTarball(tgz, workDir, log));
}

// ---- source 3: npm package ----
function fromNpm(version: string, _platform: string, workDir: string, log: Logger): Promise<string> {
  log.info('npm → @anthropic-ai/claude-code@' + version);
  let tarballUrl: string;
  try {
    tarballUrl = cp
      .execSync('npm view @anthropic-ai/claude-code@' + version + ' dist.tarball', { encoding: 'utf8' })
      .trim();
  } catch (e) {
    throw new Error('npm view failed: ' + (e as Error).message);
  }
  if (!tarballUrl) throw new Error('npm has no tarball for ' + version);
  const tgz = path.join(workDir, 'npm-claude-code-' + version + '.tgz');
  return downloadTo(tarballUrl, tgz, { onProgress: progressBar(log) }).then(() => {
    const dir = path.join(workDir, 'npm-' + version);
    fs.mkdirSync(dir, { recursive: true });
    cp.execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'ignore' });
    const bin = findBunBinary(dir);
    if (!bin) throw new Error('npm package contains no Bun binary (likely a launcher-only package for this version)');
    return bin;
  });
}

// Extract a tarball and return the path to the contained Bun `claude` binary.
function extractBinaryFromTarball(tgz: string, workDir: string, _log?: Logger): string {
  const dir = path.join(workDir, path.basename(tgz).replace(/\.(tar\.gz|tgz)$/, '') + '-x');
  fs.mkdirSync(dir, { recursive: true });
  cp.execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'ignore' });
  const bin = findBunBinary(dir);
  if (!bin) throw new Error('no Bun binary found inside ' + path.basename(tgz));
  return bin;
}

// Find the Bun standalone binary: prefer a file named `claude`, else the largest
// file whose tail carries the Bun trailer.
function findBunBinary(root: string): string | null {
  const files: [string, number][] = [];
  const walk = (d: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const fp = path.join(d, ent.name);
      if (ent.isDirectory()) walk(fp);
      else {
        try {
          files.push([fp, fs.statSync(fp).size]);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  files.sort((a, b) => b[1] - a[1]);
  const named = files.filter((f) => /(^|\/)claude(\.exe)?$/.test(f[0]) && f[1] > 1e6);
  const candidates = named.length ? named : files;
  for (const c of candidates) {
    if (c[1] < 1e6) continue; // skip tiny launchers
    if (fileHasBunTrailer(c[0])) return c[0];
  }
  return null;
}

function fileHasBunTrailer(file: string): boolean {
  // Scan backward in chunks (the trailer is near EOF, but macOS code-signs the
  // binary, appending ~size/128 bytes of signature AFTER the Bun trailer).
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const needle = Buffer.from('---- Bun! ----');
    const CHUNK = 32 * 1024 * 1024;
    const overlap = needle.length;
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const readEnd = Math.min(size, end + overlap);
      const len = readEnd - start;
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, start);
      if (b.indexOf(needle) !== -1) {
        fs.closeSync(fd);
        return true;
      }
      end = start;
    }
    fs.closeSync(fd);
    return false;
  } catch {
    if (fd != null)
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    return false;
  }
}

// Resolve a release channel ("latest" / "stable") to a concrete version.
export function resolveChannel(input: string, log?: Logger): Promise<string> {
  const s = String(input).trim();
  if (s === 'latest' || s === 'stable') {
    return getText(CLAUDE_BASE + '/' + s).then((raw) => {
      const v = String(raw).trim();
      if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(v))
        throw new Error('bad version for "' + s + '": ' + JSON.stringify(v.slice(0, 40)));
      if (log) log.info(s + ' → ' + v);
      return v;
    });
  }
  return Promise.resolve(s);
}

// ---- public: resolve `input` (version | latest | stable | tarball | binary) to a binary path ----
export function obtainBinary(input: string, platform: string, workDir: string, log: Logger): Promise<string> {
  // already a local file?
  if (input && fs.existsSync(input) && fs.statSync(input).isFile()) {
    if (/\.(tar\.gz|tgz)$/.test(input)) {
      log.step('Extracting local tarball ' + path.basename(input));
      return Promise.resolve(extractBinaryFromTarball(input, workDir, log));
    }
    log.step('Using local binary ' + path.basename(input));
    if (!fileHasBunTrailer(input)) log.warn('file does not look like a Bun binary (no trailer) — trying anyway');
    return Promise.resolve(input);
  }

  return resolveChannel(input, log).then((version) => {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[\w.]+)?$/.test(version)) {
      throw new Error('input is neither a version (x.y.z), "latest"/"stable", nor an existing file: ' + input);
    }
    const dest = path.join(workDir, 'claude-' + version + '-' + platform);
    log.step('Fetching Claude Code ' + version + ' (' + platform + ')');
    return fromClaudeAi(version, platform, dest, log)
      .catch((e1: unknown) => {
        log.warn('downloads.claude.ai failed: ' + (e1 as Error).message);
        return fromGitHub(version, platform, workDir, log);
      })
      .catch((e2: unknown) => {
        log.warn('github failed: ' + (e2 as Error).message);
        return fromNpm(version, platform, workDir, log);
      });
  });
}
