/*
 * Fetch the ripgrep (`rg`) binary the Claude Code Grep/Glob tools shell out to.
 * Not embedded in the Bun binary — download it from ripgrep's GitHub releases and
 * drop it next to cli.js (the shim puts that dir on PATH). Linux uses the static
 * musl build so it runs on old glibc too. Windows releases are .zip (not .tar.gz)
 * and carry rg.exe; we unzip them in pure Node (no reliance on which `tar` is on
 * PATH — Git Bash's GNU tar can't read zips).
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { downloadTo } from './download';
import type { Logger } from './log';

export const RG_VERSION = '14.1.1';
const RG_BASE = 'https://github.com/BurntSushi/ripgrep/releases/download';

const TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-x64-musl': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-arm64-musl': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc'
};

export async function fetchRipgrep(platform: string, destPath: string, workDir: string, log: Logger): Promise<boolean> {
  const triple = TRIPLES[platform];
  if (!triple) {
    log.warn('No ripgrep build mapped for ' + platform + ' — skipping rg');
    return false;
  }
  const isWin = platform.startsWith('win32-');
  const rgName = isWin ? 'rg.exe' : 'rg';
  const ext = isWin ? '.zip' : '.tar.gz';

  const name = 'ripgrep-' + RG_VERSION + '-' + triple;
  const url = RG_BASE + '/' + RG_VERSION + '/' + name + ext;
  const archive = path.join(workDir, name + ext);

  log.info('ripgrep ' + RG_VERSION + ' (' + triple + ')');
  await downloadTo(url, archive, {});

  const outDir = path.join(workDir, name + '-x');
  fs.mkdirSync(outDir, { recursive: true });
  if (isWin) unzip(archive, outDir);
  else cp.execFileSync('tar', ['-xzf', archive, '-C', outDir], { stdio: 'ignore' });

  let rg = path.join(outDir, name, rgName);
  if (!fs.existsSync(rg)) {
    const found = findRg(outDir);
    if (!found) throw new Error('rg binary not found inside ripgrep archive');
    rg = found;
  }
  fs.copyFileSync(rg, destPath);
  try {
    fs.chmodSync(destPath, 0o755);
  } catch {
    /* ignore (no-op on Windows) */
  }
  return true;
}

function findRg(root: string): string | null {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop() as string;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const fp = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(fp);
      else if (ent.name === 'rg' || ent.name === 'rg.exe') return fp;
    }
  }
  return null;
}

// Minimal pure-Node zip extractor: walks the central directory (authoritative
// sizes/offsets, so no data-descriptor guessing) and inflates each file entry.
// Handles the store (0) and deflate (8) methods ripgrep's zips use; no zip64.
export function unzip(zipPath: string, outDir: string): string[] {
  const buf = fs.readFileSync(zipPath);
  const EOCD = 0x0605_4b50;
  const CEN = 0x0201_4b50;
  // locate End Of Central Directory record (may be followed by a comment)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const written: string[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== CEN) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    // local header's own name/extra lengths locate the compressed data
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? comp : zlib.inflateRawSync(comp);

    const dest = path.join(outDir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    written.push(dest);
  }
  return written;
}
