import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultTarget, normalizeTarget, parseArgs, renderLs, resolveDoLink, runManage } from '../src/cli';

test('parseArgs collects input + platform', () => {
  const a = parseArgs(['2.1.185', '-p', 'linux-x64']);
  assert.equal(a._[0], '2.1.185');
  assert.equal(a.platform, 'linux-x64');
});
test('parseArgs supports --out= and negation flags', () => {
  const a = parseArgs(['x', '--out=./build', '--no-ripgrep', '--no-install', '--keep-temp']);
  assert.equal(a.out, './build');
  assert.equal(a.ripgrep, false);
  assert.equal(a.install, false);
  assert.equal(a.keepTemp, true);
});
test('parseArgs rejects --no-transpile and --targets (plural)', () => {
  assert.throws(() => parseArgs(['x', '--no-transpile']), /unknown option/);
  assert.throws(() => parseArgs(['x', '--targets', 'node18']), /unknown option/);
});

test('parseArgs handles --no-link and --link-name', () => {
  assert.equal(parseArgs([]).noLink, false);
  assert.equal(parseArgs([]).linkName, null);
  assert.equal(parseArgs(['--no-link']).noLink, true);
  assert.equal(parseArgs(['--link-name', 'mycc']).linkName, 'mycc');
  assert.equal(parseArgs(['2.1.185', '--link-name=foo']).linkName, 'foo');
  assert.throws(() => parseArgs(['--link']), /unknown option/); // old flag removed
});

test('resolveDoLink: link by default; -o means folder; flags win', () => {
  assert.equal(resolveDoLink(parseArgs([])), true); // bare cc2js
  assert.equal(resolveDoLink(parseArgs(['2.1.199'])), true); // version alone links
  assert.equal(resolveDoLink(parseArgs(['2.1.199', '-o', 'out'])), false); // -o ⇒ folder
  assert.equal(resolveDoLink(parseArgs(['2.1.199', '--no-link'])), false); // explicit off
  assert.equal(resolveDoLink(parseArgs(['2.1.199', '-o', 'out', '--link-name', 'x'])), true); // naming forces link
  assert.equal(resolveDoLink(parseArgs(['--no-link', '--link-name', 'x'])), false); // --no-link wins
});

test('parseArgs handles --target, --bin-dir, -f', () => {
  assert.equal(parseArgs(['-t', 'node20']).target, 'node20');
  assert.equal(parseArgs(['--target=node22']).target, 'node22');
  assert.equal(parseArgs(['--bin-dir=/opt/bin']).binDir, '/opt/bin');
  assert.equal(parseArgs(['-f']).force, true);
});

test('parseArgs: addPath defaults on and --no-add-path turns it off', () => {
  assert.equal(parseArgs([]).addPath, true);
  assert.equal(parseArgs(['--add-path']).addPath, true);
  assert.equal(parseArgs(['--no-add-path']).addPath, false);
});

test('normalizeTarget accepts node18+ and rejects <18', () => {
  assert.equal(normalizeTarget('node20'), 'node20');
  assert.equal(normalizeTarget('22'), 'node22');
  assert.throws(() => normalizeTarget('node16'), /node18/);
  assert.throws(() => normalizeTarget('14'), /node18/);
  assert.throws(() => normalizeTarget('nope'), /bad --target/);
});

test('defaultTarget follows current major, clamped to 18', () => {
  assert.equal(defaultTarget(24), 'node24');
  assert.equal(defaultTarget(18), 'node18');
  assert.equal(defaultTarget(16), 'node18');
});

test('parseArgs collects flags after -- and handles --no-cc-flags/--yes', () => {
  const a = parseArgs(['latest', '--', '--dangerously-skip-permissions', '--mcp-config', 'x.json']);
  assert.deepEqual(a._, ['latest']);
  assert.deepEqual(a.ccFlags, ['--dangerously-skip-permissions', '--mcp-config', 'x.json']);

  const b = parseArgs(['latest']);
  assert.equal(b.ccFlags, null); // not given

  const c = parseArgs(['clean', '--yes']);
  assert.deepEqual(c._, ['clean']);
  assert.equal(c.yes, true);

  const d = parseArgs(['latest', '--no-cc-flags']);
  assert.equal(d.noCcFlags, true);
  assert.deepEqual(d.ccFlags, null);

  assert.equal(parseArgs(['clean', '-y']).yes, true);
  assert.equal(parseArgs(['latest']).yes, false);
  assert.equal(parseArgs(['latest']).noCcFlags, false);
});

test('runManage("clean") without --yes and no TTY rejects', async () => {
  const orig = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    await assert.rejects(
      runManage('clean', parseArgs(['clean', '--bin-dir', path.join(os.tmpdir(), 'cc2js-nope')])),
      /confirm|--yes/i
    );
  } finally {
    if (orig) Object.defineProperty(process.stdin, 'isTTY', orig);
  }
});

test('renderLs shows versions, links, flags, dangling', () => {
  const dir = path.join('/v', '2.1.199-linux-x64'); // build with path.sep so the "← linked" match works on Windows too
  const out = renderLs(
    '/v',
    [{ version: '2.1.199', platform: 'linux-x64', dir, bytes: 1e6 }],
    [
      {
        name: 'cc2',
        version: '2.1.199',
        platform: 'linux-x64',
        ccFlags: ['--x'],
        target: path.join(dir, 'cli.js'),
        dangling: false,
        primaryPath: '/b/cc2'
      },
      {
        name: 'old',
        version: '1.0.0',
        platform: 'linux-x64',
        ccFlags: [],
        target: '/gone/cli.js',
        dangling: true,
        primaryPath: '/b/old'
      }
    ],
    '/b'
  );
  assert.match(out, /2\.1\.199\s+linux-x64\s+1\.0 MB\s+← linked/);
  assert.match(out, /cc2 → 2\.1\.199 \(linux-x64\)\s+\[--x\]/);
  assert.match(out, /old → 1\.0\.0 .*MISSING/);
});
