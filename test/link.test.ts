import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { delinkLauncher, launcherNames, linkLauncher, parseLauncher } from '../src/link';

const isWin = process.platform === 'win32';
const unixOnly = { skip: isWin ? 'unix-only' : false };
const winOnly = { skip: isWin ? false : 'windows-only' };

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cc2js-link-'));

// ---- Unix: single sh wrapper ----
test('linkLauncher writes an executable sh wrapper with marker', unixOnly, () => {
  const dir = tmp();
  const cli = path.join(dir, 'store', 'cli.js');
  const r = linkLauncher({ cliPath: cli, name: 'cc2', binDir: path.join(dir, 'bin') });
  const body = fs.readFileSync(r.launcherPath, 'utf8');
  assert.ok(body.startsWith('#!/bin/sh\n'));
  assert.ok(body.includes('# cc2js launcher'));
  assert.ok(body.includes('exec node "' + cli + '" "$@"'));
  assert.equal(path.basename(r.launcherPath), 'cc2');
  assert.equal(r.launcherPaths.length, 1);
  assert.ok((fs.statSync(r.launcherPath).mode & 0o111) !== 0); // executable
});

// ---- Windows: .cmd / .ps1 / sh shims ----
test('linkLauncher writes .cmd/.ps1/sh shims with markers', winOnly, () => {
  const dir = tmp();
  const cli = path.join(dir, 'store', 'cli.js');
  const bin = path.join(dir, 'bin');
  const r = linkLauncher({ cliPath: cli, name: 'cc2', binDir: bin, version: '2.1.199', platform: 'win32-x64' });
  assert.equal(path.basename(r.launcherPath), 'cc2.cmd'); // primary
  assert.equal(r.launcherPaths.length, 3);

  const cmd = fs.readFileSync(path.join(bin, 'cc2.cmd'), 'utf8');
  assert.ok(cmd.startsWith('@ECHO off'));
  assert.ok(cmd.includes('REM # cc2js launcher'));
  assert.ok(cmd.includes('node "' + cli + '" %*'));
  assert.ok(cmd.includes('\r\n')); // CRLF for cmd.exe

  const ps1 = fs.readFileSync(path.join(bin, 'cc2.ps1'), 'utf8');
  assert.ok(ps1.includes('# cc2js launcher'));
  assert.ok(ps1.includes('node "' + cli + '" $args'));
  assert.ok(ps1.includes('exit $LASTEXITCODE'));

  const sh = fs.readFileSync(path.join(bin, 'cc2'), 'utf8');
  assert.ok(sh.startsWith('#!/bin/sh\n'));
  assert.ok(sh.includes('exec node "' + cli + '" "$@"'));
});

// ---- overwrite safety (both platforms) ----
test('linkLauncher refuses to overwrite a foreign launcher without force', () => {
  const bin = path.join(tmp(), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const foreign = path.join(bin, isWin ? 'cc2.cmd' : 'cc2');
  fs.writeFileSync(foreign, 'echo real tool\n');
  assert.throws(() => linkLauncher({ cliPath: '/x/cli.js', name: 'cc2', binDir: bin }), /refusing to overwrite/);
  const r = linkLauncher({ cliPath: '/x/cli.js', name: 'cc2', binDir: bin, force: true });
  assert.ok(fs.readFileSync(r.launcherPath, 'utf8').includes('# cc2js launcher'));
});

test('linkLauncher overwrites its own previous launcher without force', () => {
  const bin = path.join(tmp(), 'bin');
  linkLauncher({ cliPath: '/a/cli.js', name: 'cc2', binDir: bin });
  const r = linkLauncher({ cliPath: '/b/cli.js', name: 'cc2', binDir: bin });
  assert.ok(fs.readFileSync(r.launcherPath, 'utf8').includes('/b/cli.js'));
});

test('linkLauncher reports onPath + pathHint', () => {
  const bin = path.join(tmp(), 'bin');
  const r1 = linkLauncher({ cliPath: '/x/cli.js', name: 'cc2', binDir: bin });
  assert.equal(r1.onPath, false);
  assert.ok(r1.pathHint?.includes(bin));

  const saved = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (saved || '');
  const r2 = linkLauncher({ cliPath: '/x/cli.js', name: 'cc2', binDir: bin, force: true });
  assert.equal(r2.onPath, true);
  assert.equal(r2.pathHint, undefined);
  process.env.PATH = saved;
});

test('linkLauncher bakes flags before "$@" and records a flags marker', unixOnly, () => {
  const bin = path.join(tmp(), 'bin');
  const cli = '/store/cli.js';
  const r = linkLauncher({
    cliPath: cli,
    name: 'cc2',
    binDir: bin,
    ccFlags: ['--dangerously-skip-permissions', '--mcp-config', '~/a b.json']
  });
  const body = fs.readFileSync(r.launcherPath, 'utf8');
  assert.ok(body.includes('# cc2js flags: ["--dangerously-skip-permissions","--mcp-config","~/a b.json"]'));
  assert.ok(body.includes(`exec node "${cli}" '--dangerously-skip-permissions' '--mcp-config' '~/a b.json' "$@"`));
});

test('linkLauncher with no flags is unchanged (no flags marker)', unixOnly, () => {
  const bin = path.join(tmp(), 'bin');
  const body = fs.readFileSync(linkLauncher({ cliPath: '/x/cli.js', name: 'cc2', binDir: bin }).launcherPath, 'utf8');
  assert.ok(!body.includes('cc2js flags'));
  assert.ok(body.includes('exec node "/x/cli.js" "$@"'));
});

// ---- parseLauncher / launcherNames / delinkLauncher ----
test('parseLauncher round-trips version/platform/flags/target', () => {
  const bin = path.join(tmp(), 'bin');
  const flags = ['--dangerously-skip-permissions'];
  linkLauncher({
    cliPath: '/store/2.1.199-x/cli.js',
    name: 'cc2',
    binDir: bin,
    version: '2.1.199',
    platform: isWin ? 'win32-x64' : 'linux-x64',
    ccFlags: flags
  });
  const p = parseLauncher(bin, 'cc2');
  assert.ok(p);
  assert.equal(p?.version, '2.1.199');
  assert.deepEqual(p?.ccFlags, flags);
  assert.equal(p?.target, '/store/2.1.199-x/cli.js');
  assert.deepEqual(launcherNames(bin), ['cc2']);
});

test('parseLauncher ignores a foreign file; delinkLauncher removes only ours', () => {
  const bin = path.join(tmp(), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const foreign = path.join(bin, isWin ? 'other.cmd' : 'other');
  fs.writeFileSync(foreign, 'echo hi\n');
  assert.equal(parseLauncher(bin, 'other'), null);
  assert.deepEqual(delinkLauncher(bin, 'other'), []); // unmarked → untouched
  assert.ok(fs.existsSync(foreign));

  linkLauncher({ cliPath: '/x/cli.js', name: 'cc2', binDir: bin });
  const removed = delinkLauncher(bin, 'cc2');
  assert.ok(removed.length >= 1);
  assert.equal(parseLauncher(bin, 'cc2'), null);
});

test('parseLauncher round-trips flags with spaces, brackets, and quotes', () => {
  const bin = path.join(tmp(), 'bin');
  const flags = ['--mcp-config', '~/a b.json', '--env', 'FOO=[bar]', '--x', "it's"];
  linkLauncher({ cliPath: '/s/cli.js', name: 'cc2', binDir: bin, ccFlags: flags });
  assert.deepEqual(parseLauncher(bin, 'cc2')?.ccFlags, flags);
});

test('parseLauncher target is not confused by a flag containing node "', () => {
  const bin = path.join(tmp(), 'bin');
  linkLauncher({ cliPath: '/real/cli.js', name: 'cc2', binDir: bin, ccFlags: ['end node ', 'x'] });
  assert.equal(parseLauncher(bin, 'cc2')?.target, '/real/cli.js');
});

test('linkLauncher bakes escaped flags into .cmd/.ps1 shims', winOnly, () => {
  const bin = path.join(tmp(), 'bin');
  const cli = '/store/cli.js';
  linkLauncher({
    cliPath: cli,
    name: 'cc2',
    binDir: bin,
    ccFlags: ['--dangerously-skip-permissions', '--mcp-config', 'a b.json', '']
  });
  const cmd = fs.readFileSync(path.join(bin, 'cc2.cmd'), 'utf8');
  assert.ok(cmd.includes('node "' + cli + '" --dangerously-skip-permissions --mcp-config "a b.json" "" %*')); // empty flag quoted, spaces quoted
  const ps1 = fs.readFileSync(path.join(bin, 'cc2.ps1'), 'utf8');
  assert.ok(ps1.includes('node "' + cli + "\" '--dangerously-skip-permissions' '--mcp-config' 'a b.json' '' $args"));
});

test('cmdQuote doubles % for the .cmd shim', winOnly, () => {
  const bin = path.join(tmp(), 'bin');
  linkLauncher({ cliPath: '/x/cli.js', name: 'cc2', binDir: bin, ccFlags: ['--env=%PATH%'] });
  assert.ok(fs.readFileSync(path.join(bin, 'cc2.cmd'), 'utf8').includes('%%PATH%%'));
});

test('linkLauncher reports status linked / updated / unchanged', () => {
  const bin = path.join(tmp(), 'bin');
  const r1 = linkLauncher({
    cliPath: '/s/199/cli.js',
    name: 'cc2',
    binDir: bin,
    version: '2.1.199',
    platform: isWin ? 'win32-x64' : 'linux-x64'
  });
  assert.equal(r1.status, 'linked');

  const r2 = linkLauncher({
    cliPath: '/s/200/cli.js',
    name: 'cc2',
    binDir: bin,
    version: '2.1.200',
    platform: isWin ? 'win32-x64' : 'linux-x64'
  });
  assert.equal(r2.status, 'updated');
  assert.equal(r2.previousVersion, '2.1.199');

  const mtime = fs.statSync(r2.launcherPath).mtimeMs;
  const r3 = linkLauncher({
    cliPath: '/s/200/cli.js',
    name: 'cc2',
    binDir: bin,
    version: '2.1.200',
    platform: isWin ? 'win32-x64' : 'linux-x64'
  });
  assert.equal(r3.status, 'unchanged');
  assert.equal(fs.statSync(r3.launcherPath).mtimeMs, mtime); // skipped the write
});

test('relink restores the exec bit even when unchanged', unixOnly, () => {
  const bin = path.join(tmp(), 'bin');
  const r = linkLauncher({ cliPath: '/x/cli.js', name: 'cc2', binDir: bin });
  fs.chmodSync(r.launcherPath, 0o644); // strip exec bit externally
  const r2 = linkLauncher({ cliPath: '/x/cli.js', name: 'cc2', binDir: bin });
  assert.equal(r2.status, 'unchanged');
  assert.ok((fs.statSync(r2.launcherPath).mode & 0o111) !== 0); // exec bit restored
});
