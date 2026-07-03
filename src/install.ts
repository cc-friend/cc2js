/*
 * install: convert a release into the managed store (~/.cc2node/versions/<ver>-<plat>/)
 * and link it onto PATH as a command (default `cc2`). Powers the default install
 * path (`cc2node` / `cc2node <version>`). Version inputs are cached (re-running skips re-conversion).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AddPathResult, addToPath } from './addpath';
import { type ConvertOptions, convert } from './convert';
import { hostPlatform, resolveChannel } from './download';
import { linkLauncher } from './link';
import defaultLog, { type Logger } from './log';

export function cc2Home(): string {
  return path.join(os.homedir(), '.cc2node');
}
export function defaultBinDir(): string {
  // ~/.local/bin is a Unix convention; on Windows use %USERPROFILE%\.cc2node\bin
  // (alongside the versions store) since there is no equivalent default on PATH.
  if (process.platform === 'win32') return path.join(cc2Home(), 'bin');
  return path.join(os.homedir(), '.local', 'bin');
}

export interface InstallOptions {
  input: string; // version | "latest" | "stable" | tarball | binary
  name?: string; // launcher name (default "cc2")
  platform?: string;
  target?: string;
  binDir?: string; // default ~/.local/bin
  out?: string; // explicit output dir (overrides the managed store)
  install?: boolean;
  ripgrep?: boolean;
  force?: boolean;
  keepTemp?: boolean;
  addPath?: boolean; // persist binDir onto the user's PATH when it isn't already
  log?: Logger;
}

export interface InstallResult {
  version: string;
  platform: string;
  outDir: string;
  cached: boolean;
  launcherPath: string;
  onPath: boolean;
  pathHint?: string;
  addPath?: AddPathResult; // outcome of the --add-path attempt (only when requested and not onPath)
}

function convertTo(opts: InstallOptions, input: string, platform: string, out: string, log: Logger) {
  const co: ConvertOptions = {
    input,
    platform,
    out,
    log,
    target: opts.target,
    install: opts.install,
    ripgrep: opts.ripgrep,
    keepTemp: opts.keepTemp
  };
  return convert(co);
}

export async function install(opts: InstallOptions): Promise<InstallResult> {
  const log = opts.log || defaultLog;
  const platform = opts.platform || hostPlatform();
  const name = opts.name || 'cc2';
  const binDir = opts.binDir || defaultBinDir();
  const versionsDir = path.join(cc2Home(), 'versions');
  const isFile = !!opts.input && fs.existsSync(opts.input) && fs.statSync(opts.input).isFile();

  let version: string;
  let outDir: string;
  let cached = false;

  if (opts.out) {
    // explicit -o: always convert there
    outDir = opts.out;
    version = (await convertTo(opts, opts.input, platform, outDir, log)).version;
  } else if (isFile) {
    // local file: convert to a pending dir, then move under the sniffed version
    const pending = path.join(versionsDir, '.pending-' + process.pid);
    fs.rmSync(pending, { recursive: true, force: true });
    version = (await convertTo(opts, opts.input, platform, pending, log)).version;
    outDir = path.join(versionsDir, version + '-' + platform);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(versionsDir, { recursive: true });
    fs.renameSync(pending, outDir);
  } else {
    // version / latest / stable: resolve, then cache-skip if already present
    version = await resolveChannel(opts.input, log);
    outDir = path.join(versionsDir, version + '-' + platform);
    if (!opts.force && fs.existsSync(path.join(outDir, 'cli.js'))) {
      cached = true;
      log.ok('already installed: Claude Code ' + version + ' (' + platform + ')');
    } else {
      await convertTo(opts, version, platform, outDir, log);
    }
  }

  const link = linkLauncher({
    cliPath: path.join(outDir, 'cli.js'),
    name,
    binDir,
    version,
    platform,
    force: opts.force
  });

  // Persist binDir onto PATH (opt-out via --no-add-path) only when it isn't
  // already usable in this shell.
  const addPath = opts.addPath && !link.onPath ? addToPath(binDir) : undefined;

  return {
    version,
    platform,
    outDir,
    cached,
    launcherPath: link.launcherPath,
    onPath: link.onPath,
    pathHint: link.pathHint,
    addPath
  };
}
