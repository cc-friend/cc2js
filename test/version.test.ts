import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cc2jsVersion, sniffVersion } from '../src/version';

test('sniffVersion reads a // Version: line', () => {
  assert.equal(sniffVersion('// @bun\n// Version: 2.1.185\ncode'), '2.1.185');
});
test('sniffVersion reads a prerelease', () => {
  assert.equal(sniffVersion('// Version: 2.2.0-beta.1\n'), '2.2.0-beta.1');
});
test('sniffVersion returns null when absent', () => {
  assert.equal(sniffVersion('no version marker here'), null);
});
test('cc2jsVersion matches package.json', () => {
  assert.equal(
    cc2jsVersion(),
    (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version
  );
});
