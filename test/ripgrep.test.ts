import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { unzip } from '../src/ripgrep';

interface Entry {
  name: string;
  data: Buffer;
  method: 0 | 8;
}

// Build a minimal but spec-conformant zip (local headers + central directory +
// EOCD) so we can exercise unzip() without a network download or shelling out.
function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const comp = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const nameBuf = Buffer.from(e.name, 'utf8');

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(0, 14); // crc (ignored by reader)
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt32LE(0, 16); // crc
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);

    locals.push(local, comp);
    centrals.push(central);
    offset += local.length + comp.length;
  }

  const cd = Buffer.concat(centrals);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x0605_4b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([...locals, cd, eocd]);
}

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cc2js-rg-'));

test('unzip extracts store + deflate entries with exact bytes', () => {
  const dir = tmp();
  const zip = path.join(dir, 'a.zip');
  const stored = Buffer.from('stored bytes\n');
  const deflated = Buffer.from('x'.repeat(5000)); // compresses well
  fs.writeFileSync(
    zip,
    makeZip([
      { name: 'stored.txt', data: stored, method: 0 },
      { name: 'deflated.txt', data: deflated, method: 8 }
    ])
  );

  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const written = unzip(zip, out);
  assert.equal(written.length, 2);
  assert.deepEqual(fs.readFileSync(path.join(out, 'stored.txt')), stored);
  assert.deepEqual(fs.readFileSync(path.join(out, 'deflated.txt')), deflated);
});

test('unzip creates nested dirs (rg.exe layout) and skips directory entries', () => {
  const dir = tmp();
  const zip = path.join(dir, 'rg.zip');
  const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // "MZ" PE stub
  fs.writeFileSync(
    zip,
    makeZip([
      { name: 'ripgrep-14.1.1-x86_64-pc-windows-msvc/', data: Buffer.alloc(0), method: 0 },
      { name: 'ripgrep-14.1.1-x86_64-pc-windows-msvc/rg.exe', data: exe, method: 8 }
    ])
  );

  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const written = unzip(zip, out);
  assert.equal(written.length, 1); // directory entry skipped
  const rg = path.join(out, 'ripgrep-14.1.1-x86_64-pc-windows-msvc', 'rg.exe');
  assert.ok(fs.existsSync(rg));
  assert.deepEqual(fs.readFileSync(rg), exe);
});

test('unzip rejects a non-zip buffer', () => {
  const dir = tmp();
  const bad = path.join(dir, 'bad.zip');
  fs.writeFileSync(bad, Buffer.from('not a zip at all'));
  assert.throws(() => unzip(bad, dir), /no end-of-central-directory/);
});
