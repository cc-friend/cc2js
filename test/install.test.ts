import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cc2Home, defaultBinDir, resolveCcFlags, staleBuildHint } from '../src/install';

test('cc2Home is ~/.cc2js', () => {
  assert.equal(cc2Home(), path.join(os.homedir(), '.cc2js'));
});

test('defaultBinDir is OS-appropriate', () => {
  const d = defaultBinDir();
  if (process.platform === 'win32') assert.equal(d, path.join(os.homedir(), '.cc2js', 'bin'));
  else assert.equal(d, path.join(os.homedir(), '.local', 'bin'));
});

test('resolveCcFlags: given replaces, --no-cc-flags clears, absent preserves', () => {
  assert.deepEqual(resolveCcFlags(['--a'], false, ['--old']), ['--a']); // explicit replace
  assert.deepEqual(resolveCcFlags([], false, ['--old']), []); // -- with nothing clears
  assert.deepEqual(resolveCcFlags(undefined, true, ['--old']), []); // --no-cc-flags clears
  assert.deepEqual(resolveCcFlags(undefined, false, ['--old']), ['--old']); // preserve
  assert.deepEqual(resolveCcFlags(undefined, false, undefined), []); // nothing anywhere
});

test('staleBuildHint: silent for a build by this cc2js, hints --force otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2js-stale-'));
  const pkg = (extra: object) =>
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', ...extra }));
  try {
    pkg({ cc2js: '1.2.3' });
    assert.equal(staleBuildHint(dir, '2.1.284', undefined, '1.2.3'), undefined);
    pkg({ cc2js: '1.2.2' });
    assert.equal(
      staleBuildHint(dir, '2.1.284', undefined, '1.2.3'),
      'Cached Claude Code 2.1.284 was converted by cc2js 1.2.2, not this cc2js 1.2.3. If you have problems running the old build, run cc2js 2.1.284 --force to rebuild it'
    );
    pkg({});
    assert.match(
      staleBuildHint(dir, '2.1.284', 'darwin-arm64', '1.2.3') ?? '',
      /by an older cc2js, .*run cc2js 2\.1\.284 -p darwin-arm64 --force to rebuild it$/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
