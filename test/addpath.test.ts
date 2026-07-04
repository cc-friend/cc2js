import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addToRc, manualLineFor, pickRcFile, rcHasEntry, shellName, unixExportLine } from '../src/addpath';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cc2js-path-'));

test('shellName takes the basename of $SHELL', () => {
  assert.equal(shellName('/usr/bin/zsh'), 'zsh');
  assert.equal(shellName('/bin/bash'), 'bash');
  assert.equal(shellName('fish'), 'fish');
  assert.equal(shellName(''), '');
});

test('unixExportLine prepends the dir to PATH', () => {
  assert.equal(unixExportLine('/home/u/.local/bin'), 'export PATH="/home/u/.local/bin:$PATH"');
});

test('manualLineFor uses the right syntax per shell', () => {
  assert.equal(manualLineFor('/usr/bin/fish', '/x/bin'), 'fish_add_path /x/bin');
  assert.equal(manualLineFor('/bin/tcsh', '/x/bin'), 'setenv PATH "/x/bin:$PATH"');
  assert.equal(manualLineFor('/bin/bash', '/x/bin'), 'export PATH="/x/bin:$PATH"');
});

test('pickRcFile maps shells to rc files (and null for the rest)', () => {
  const home = '/home/u';
  assert.equal(pickRcFile('/bin/zsh', 'linux', home), path.join(home, '.zshrc'));
  assert.equal(pickRcFile('/bin/bash', 'linux', home), path.join(home, '.bashrc'));
  assert.equal(pickRcFile('/bin/bash', 'darwin', home), path.join(home, '.bash_profile'));
  assert.equal(pickRcFile('/bin/sh', 'linux', home), path.join(home, '.profile'));
  assert.equal(pickRcFile('/usr/bin/fish', 'linux', home), null); // not auto-edited
  assert.equal(pickRcFile('/bin/tcsh', 'linux', home), null);
});

test('rcHasEntry is true when the dir is already referenced', () => {
  assert.equal(rcHasEntry('export PATH="/x/bin:$PATH"\n', '/x/bin'), true);
  assert.equal(rcHasEntry('nothing here\n', '/x/bin'), false);
});

test('addToRc appends once and is idempotent (no duplicate on re-run)', () => {
  const rc = path.join(tmp(), '.zshrc');
  fs.writeFileSync(rc, 'export EDITOR=vim'); // no trailing newline

  const r1 = addToRc(rc, '/opt/cc2/bin');
  assert.equal(r1.changed, true);
  assert.equal(r1.ok, true);
  const after1 = fs.readFileSync(rc, 'utf8');
  assert.ok(after1.startsWith('export EDITOR=vim\n')); // leading newline inserted
  assert.ok(after1.includes('export PATH="/opt/cc2/bin:$PATH"'));

  const r2 = addToRc(rc, '/opt/cc2/bin');
  assert.equal(r2.changed, false); // already there → not re-added
  assert.equal(r2.ok, true);
  const after2 = fs.readFileSync(rc, 'utf8');
  const count = after2.split('/opt/cc2/bin').length - 1;
  assert.equal(count, 1); // referenced exactly once
});

test('addToRc creates the rc file when missing', () => {
  const rc = path.join(tmp(), '.bashrc');
  const r = addToRc(rc, '/opt/cc2/bin');
  assert.equal(r.changed, true);
  assert.ok(fs.existsSync(rc));
  assert.ok(fs.readFileSync(rc, 'utf8').includes('/opt/cc2/bin'));
});
