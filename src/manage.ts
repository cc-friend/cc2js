/*
 * Stateless lifecycle queries/ops over the versions store and the marker-tagged
 * launchers. Functions return data (or perform the removal) and never print.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLATFORMS } from './download';
import { delinkLauncher, launcherNames, parseLauncher } from './link';

export interface VersionEntry {
  version: string;
  platform: string;
  dir: string;
  bytes: number;
}
export interface LinkEntry {
  name: string;
  version?: string;
  platform?: string;
  ccFlags: string[];
  target: string;
  dangling: boolean;
  primaryPath: string;
}

function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

export function listVersions(versionsDir: string): VersionEntry[] {
  if (!fs.existsSync(versionsDir)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(versionsDir);
  } catch {
    return [];
  }
  const out: VersionEntry[] = [];
  const platsByLen = [...PLATFORMS].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const dir = path.join(versionsDir, name);
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      /* ignore */
    }
    if (!isDir) continue;
    // Match a known platform suffix (handles 2- and 3-segment platforms like
    // linux-x64-musl, and versions that themselves contain '-', e.g. prereleases).
    const platform = platsByLen.find((p) => name.endsWith('-' + p));
    if (!platform) continue;
    const version = name.slice(0, name.length - platform.length - 1);
    if (!version) continue;
    out.push({ version, platform, dir, bytes: dirBytes(dir) });
  }
  return out;
}

export function listLinks(binDir: string): LinkEntry[] {
  const out: LinkEntry[] = [];
  for (const name of launcherNames(binDir)) {
    const p = parseLauncher(binDir, name);
    if (!p) continue;
    out.push({
      name,
      version: p.version,
      platform: p.platform,
      ccFlags: p.ccFlags,
      target: p.target,
      dangling: !p.target || !fs.existsSync(p.target),
      primaryPath: p.primaryPath
    });
  }
  return out;
}

export function removeVersion(
  version: string,
  versionsDir: string,
  binDir: string
): { removed: string[]; delinked: string[] } {
  const entries = listVersions(versionsDir).filter(
    (v) => v.version === version || v.version + '-' + v.platform === version
  );
  if (!entries.length) {
    const have = listVersions(versionsDir).map((v) => v.version + '-' + v.platform);
    throw new Error(
      'no such installed version: ' +
        version +
        (have.length ? ' (installed: ' + have.join(', ') + ')' : ' (nothing installed)')
    );
  }
  const removed: string[] = [];
  const delinked: string[] = [];
  for (const e of entries) {
    for (const l of listLinks(binDir)) {
      if (l.target.startsWith(e.dir + path.sep)) {
        delinked.push(...delinkLauncher(binDir, l.name));
      }
    }
    fs.rmSync(e.dir, { recursive: true, force: true });
    removed.push(e.dir);
  }
  return { removed, delinked };
}

export function clean(versionsDir: string, binDir: string): { removedVersions: string[]; delinked: string[] } {
  const delinked: string[] = [];
  for (const l of listLinks(binDir)) delinked.push(...delinkLauncher(binDir, l.name));
  const removedVersions: string[] = [];
  for (const v of listVersions(versionsDir)) {
    fs.rmSync(v.dir, { recursive: true, force: true });
    removedVersions.push(v.dir);
  }
  return { removedVersions, delinked };
}
