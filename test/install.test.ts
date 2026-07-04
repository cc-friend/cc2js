import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cc2Home, defaultBinDir, resolveCcFlags } from '../src/install';

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
