/*
 * Install a launcher for a converted cli.js so a converted Claude Code runs as
 * e.g. `cc2`. Every file carries a `# cc2js launcher` marker so we only ever
 * detect/overwrite our own (never clobber a foreign file without --force).
 *
 *   Unix (Linux/macOS): a single `#!/bin/sh` wrapper.
 *   Windows: npm-style shims — `<name>.cmd` (cmd.exe), `<name>.ps1` (PowerShell)
 *     and an extensionless `<name>` sh wrapper (Git Bash / MSYS). No `npm link`.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MARKER = '# cc2js launcher';

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}
function cmdQuote(s: string): string {
  const doubled = s.replace(/%/g, '%%'); // %VAR% expands in .cmd — double for a literal %
  return s === '' || /[\s&|<>^"()!%]/.test(s) ? '"' + doubled.replace(/"/g, '""') + '"' : doubled;
}
function joinFlags(flags: string[], quote: (s: string) => string): string {
  return flags.length ? ' ' + flags.map(quote).join(' ') : '';
}
function flagsComment(flags: string[], open: string, eol: string): string {
  return flags.length ? open + 'cc2js flags: ' + JSON.stringify(flags) + eol : '';
}

export interface LinkOptions {
  cliPath: string; // absolute path to the converted cli.js
  name: string; // launcher command name, e.g. "cc2"
  binDir: string; // directory to write the launcher into
  version?: string; // for the marker comment
  platform?: string; // for the marker comment
  force?: boolean; // overwrite a file we didn't create
  ccFlags?: string[]; // Claude flags baked into the launcher, before the runtime args
}

export interface LinkResult {
  launcherPath: string; // primary launcher (Unix: the sh wrapper; Windows: the .cmd)
  launcherPaths: string[]; // every file written (1 on Unix, 3 on Windows)
  onPath: boolean;
  pathHint?: string; // command to add binDir to PATH when it is not already there
  status: 'linked' | 'updated' | 'unchanged';
  previousVersion?: string;
  ccFlags: string[];
}

interface LauncherFile {
  path: string;
  body: string;
}

export function linkLauncher(opts: LinkOptions): LinkResult {
  fs.mkdirSync(opts.binDir, { recursive: true });
  const label = opts.version
    ? ' — Claude Code ' + opts.version + (opts.platform ? ' (' + opts.platform + ')' : '')
    : '';
  const files = process.platform === 'win32' ? windowsLaunchers(opts, label) : [unixLauncher(opts, label)];

  const existing = parseLauncher(opts.binDir, opts.name);
  const status: LinkResult['status'] = !existing
    ? 'linked'
    : files.every((f) => readIf(f.path) === f.body)
      ? 'unchanged'
      : 'updated';

  // safety: never clobber a file we didn't create
  for (const f of files) guardOverwrite(f.path, opts.force);
  for (const f of files) {
    if (status !== 'unchanged') fs.writeFileSync(f.path, f.body);
    try {
      fs.chmodSync(f.path, 0o755); // executable on Unix; no-op on Windows
    } catch {
      /* ignore */
    }
  }

  const onPath = isOnPath(opts.binDir);
  const result: LinkResult = {
    launcherPath: files[0].path,
    launcherPaths: files.map((f) => f.path),
    onPath,
    status,
    previousVersion: status === 'updated' ? existing?.version : undefined,
    ccFlags: opts.ccFlags ?? []
  };
  if (!onPath) result.pathHint = pathHint(opts.binDir);
  return result;
}

function unixLauncher(opts: LinkOptions, label: string): LauncherFile {
  const flags = opts.ccFlags ?? [];
  const body =
    '#!/bin/sh\n' +
    MARKER +
    label +
    '\n' +
    flagsComment(flags, '# ', '\n') +
    'exec node "' +
    opts.cliPath +
    '"' +
    joinFlags(flags, shQuote) +
    ' "$@"\n';
  return { path: path.join(opts.binDir, opts.name), body };
}

function windowsLaunchers(opts: LinkOptions, label: string): LauncherFile[] {
  const base = path.join(opts.binDir, opts.name);
  const cli = opts.cliPath;
  const flags = opts.ccFlags ?? [];
  return [
    {
      path: base + '.cmd',
      body:
        '@ECHO off\r\nREM ' +
        MARKER +
        label +
        '\r\n' +
        flagsComment(flags, 'REM # ', '\r\n') +
        'node "' +
        cli +
        '"' +
        joinFlags(flags, cmdQuote) +
        ' %*\r\n'
    },
    {
      path: base + '.ps1',
      body:
        '#!/usr/bin/env pwsh\n# ' +
        MARKER +
        label +
        '\n' +
        flagsComment(flags, '# ', '\n') +
        'node "' +
        cli +
        '"' +
        joinFlags(flags, psQuote) +
        ' $args\nexit $LASTEXITCODE\n'
    },
    {
      path: base,
      body:
        '#!/bin/sh\n' +
        MARKER +
        label +
        '\n' +
        flagsComment(flags, '# ', '\n') +
        'exec node "' +
        cli +
        '"' +
        joinFlags(flags, shQuote) +
        ' "$@"\n'
    }
  ];
}

function guardOverwrite(file: string, force?: boolean): void {
  if (fs.existsSync(file) && !force) {
    let existing = '';
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      /* ignore */
    }
    if (!existing.includes(MARKER)) {
      throw new Error(file + ' exists and is not a cc2js launcher — refusing to overwrite (use --force)');
    }
  }
}

function pathHint(binDir: string): string {
  // Windows: persist to the user PATH via setx (takes effect in new shells).
  if (process.platform === 'win32') return 'setx PATH "%PATH%;' + binDir + '"';
  return 'export PATH="' + binDir + ':$PATH"';
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function isOnPath(dir: string): boolean {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((e) => {
      try {
        return samePath(e, dir);
      } catch {
        return false;
      }
    });
}

export interface ParsedLauncher {
  name: string;
  version?: string;
  platform?: string;
  target: string; // cli.js path the launcher runs
  ccFlags: string[];
  paths: string[]; // existing files backing this launcher (trio on Windows)
  primaryPath: string;
}

function launcherPaths(binDir: string, name: string): string[] {
  const base = path.join(binDir, name);
  return process.platform === 'win32' ? [base + '.cmd', base + '.ps1', base] : [base];
}

function readIf(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function parseLauncher(binDir: string, name: string): ParsedLauncher | null {
  const primaryPath = launcherPaths(binDir, name)[0];
  const text = readIf(primaryPath);
  if (text == null || !text.includes(MARKER)) return null;
  const vp = text.match(/Claude Code (\S+) \(([^)]+)\)/);
  const fm = text.match(/cc2js flags:\s*(\[.*\])/);
  const tm = text.match(/^(?:exec )?node "([^"]+)"/m);
  let ccFlags: string[] = [];
  if (fm) {
    try {
      ccFlags = JSON.parse(fm[1]) as string[];
    } catch {
      ccFlags = [];
    }
  }
  return {
    name,
    version: vp?.[1],
    platform: vp?.[2],
    target: tm ? tm[1] : '',
    ccFlags,
    paths: launcherPaths(binDir, name).filter((p) => fs.existsSync(p)),
    primaryPath
  };
}

export function launcherNames(binDir: string): string[] {
  if (!fs.existsSync(binDir)) return [];
  const names = new Set<string>();
  for (const f of fs.readdirSync(binDir)) {
    const full = path.join(binDir, f);
    let isFile = false;
    try {
      isFile = fs.statSync(full).isFile();
    } catch {
      /* ignore */
    }
    if (!isFile) continue;
    const text = readIf(full);
    if (text == null || !text.includes(MARKER)) continue;
    names.add(f.replace(/\.(cmd|ps1)$/i, ''));
  }
  return [...names];
}

export function delinkLauncher(binDir: string, name: string): string[] {
  const removed: string[] = [];
  for (const p of launcherPaths(binDir, name)) {
    const text = readIf(p);
    if (text == null || !text.includes(MARKER)) continue; // never remove foreign/absent
    fs.rmSync(p);
    removed.push(p);
  }
  return removed;
}
