import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { linkLauncher } from '../src/link';
import { clean, listLinks, listVersions, removeVersion } from '../src/manage';

const isWin = process.platform === 'win32';
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cc2node-manage-'));

function seedVersion(root: string, version: string, platform: string): string {
  const dir = path.join(root, version + '-' + platform);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cli.js'), '// x\n');
  return dir;
}

test('listVersions parses 2- and 3-segment platforms with sizes', () => {
  const root = tmp();
  seedVersion(root, '2.1.199', 'linux-x64');
  seedVersion(root, '2.1.199', 'linux-x64-musl'); // 3-segment platform must parse
  seedVersion(root, '2.1.200', 'darwin-arm64');
  const vs = listVersions(root);
  assert.equal(vs.length, 3);
  const musl = vs.find((v) => v.platform === 'linux-x64-musl');
  assert.ok(musl);
  assert.equal(musl?.version, '2.1.199');
  assert.ok(vs.every((v) => v.bytes > 0));
});

test('listLinks reports version/flags and dangling when target is gone', () => {
  const root = tmp();
  const bin = path.join(root, 'bin');
  const dir = seedVersion(root, '2.1.199', isWin ? 'win32-x64' : 'linux-x64');
  linkLauncher({
    cliPath: path.join(dir, 'cli.js'),
    name: 'cc2',
    binDir: bin,
    version: '2.1.199',
    platform: isWin ? 'win32-x64' : 'linux-x64',
    ccFlags: ['--x']
  });
  let links = listLinks(bin);
  assert.equal(links.length, 1);
  assert.equal(links[0].name, 'cc2');
  assert.equal(links[0].dangling, false);
  assert.deepEqual(links[0].ccFlags, ['--x']);

  fs.rmSync(dir, { recursive: true, force: true });
  links = listLinks(bin);
  assert.equal(links[0].dangling, true);
});

test('removeVersion deletes the version dir and cascades delink', () => {
  const root = tmp();
  const bin = path.join(root, 'bin');
  const plat = isWin ? 'win32-x64' : 'linux-x64';
  const dir = seedVersion(root, '2.1.199', plat);
  linkLauncher({ cliPath: path.join(dir, 'cli.js'), name: 'cc2', binDir: bin, version: '2.1.199', platform: plat });

  const res = removeVersion('2.1.199', root, bin);
  assert.equal(res.removed.length, 1);
  assert.ok(res.delinked.length >= 1);
  assert.ok(!fs.existsSync(dir));
  assert.equal(listLinks(bin).length, 0);
  assert.throws(() => removeVersion('9.9.9', root, bin), /no such installed version/);
});

test('clean removes all versions and all links', () => {
  const root = tmp();
  const bin = path.join(root, 'bin');
  const plat = isWin ? 'win32-x64' : 'linux-x64';
  const dir = seedVersion(root, '2.1.199', plat);
  seedVersion(root, '2.1.200', plat);
  linkLauncher({ cliPath: path.join(dir, 'cli.js'), name: 'cc2', binDir: bin, version: '2.1.199', platform: plat });

  const res = clean(root, bin);
  assert.equal(res.removedVersions.length, 2);
  assert.ok(res.delinked.length >= 1);
  assert.equal(listVersions(root).length, 0);
  assert.equal(listLinks(bin).length, 0);
});

test('removeVersion: bare version removes all platforms; exact version-platform removes only one', () => {
  const root = tmp();
  const bin = path.join(root, 'bin');
  const a = seedVersion(root, '2.1.199', 'linux-x64');
  const b = seedVersion(root, '2.1.199', 'linux-x64-musl');
  linkLauncher({
    cliPath: path.join(a, 'cli.js'),
    name: 'cc2',
    binDir: bin,
    version: '2.1.199',
    platform: 'linux-x64'
  });

  // exact <version>-<platform>: removes only that dir; sibling platform + nothing else survives
  const r1 = removeVersion('2.1.199-linux-x64', root, bin);
  assert.equal(r1.removed.length, 1);
  assert.ok(!fs.existsSync(a));
  assert.ok(fs.existsSync(b));
  assert.ok(r1.delinked.length >= 1); // the cc2 launcher pointed under `a`
  assert.equal(listLinks(bin).length, 0);

  // bare version: removes all remaining platform dirs of that version
  const _r2 = removeVersion('2.1.199', root, bin);
  assert.ok(!fs.existsSync(b));
  assert.equal(listVersions(root).length, 0);
});

test('removeVersion with no launchers still removes the version dir', () => {
  const root = tmp();
  const bin = path.join(root, 'bin'); // no launchers linked
  const a = seedVersion(root, '2.1.199', 'linux-x64');
  const r = removeVersion('2.1.199', root, bin);
  assert.equal(r.removed.length, 1);
  assert.deepEqual(r.delinked, []);
  assert.ok(!fs.existsSync(a));
});

test('removeVersion error lists installed versions', () => {
  const root = tmp();
  const bin = path.join(root, 'bin');
  seedVersion(root, '2.1.199', 'linux-x64');
  assert.throws(() => removeVersion('9.9.9', root, bin), /installed: 2\.1\.199-linux-x64/);
});
