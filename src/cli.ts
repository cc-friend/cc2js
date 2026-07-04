#!/usr/bin/env node
/*
 * cc2js — convert any Bun-compiled Claude Code release into a pure-Node build.
 *   cc2js [<version|latest|stable|tarball|binary>] [options]
 *   cc2js                # shortcut for `cc2js latest` (install/update `cc2`)
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { convert } from './convert';
import { hostPlatform, PLATFORMS } from './download';
import { cc2Home, defaultBinDir, install } from './install';
import { delinkLauncher } from './link';
import log from './log';
import { clean, type LinkEntry, listLinks, listVersions, removeVersion, type VersionEntry } from './manage';

function pkgVersion(): string {
  const p = path.join(__dirname, '..', 'package.json');
  return (JSON.parse(fs.readFileSync(p, 'utf8')) as { version: string }).version;
}

export interface Args {
  _: string[];
  linkName: string | null; // --link-name <name>: rename the command (null ⇒ default "cc2")
  noLink: boolean; // --no-link: just convert to a folder, install no command
  binDir: string | null;
  target: string | null;
  platform: string | null;
  out: string | null;
  ripgrep: boolean;
  install: boolean;
  force: boolean;
  keepTemp: boolean;
  addPath: boolean;
  ccFlags: string[] | null; // flags after `--` to bake into the launcher (null = not given)
  noCcFlags: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    _: [],
    linkName: null,
    noLink: false,
    binDir: null,
    target: null,
    platform: null,
    out: null,
    ripgrep: true,
    install: true,
    force: false,
    keepTemp: false,
    addPath: true,
    ccFlags: null,
    noCcFlags: false,
    yes: false,
    help: false,
    version: false
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    switch (x) {
      case '-h':
      case '--help':
        a.help = true;
        break;
      case '-v':
      case '--version':
        a.version = true;
        break;
      case '--no-link':
        a.noLink = true;
        break;
      case '--link-name':
        a.linkName = argv[++i];
        break;
      case '--bin-dir':
        a.binDir = argv[++i];
        break;
      case '-t':
      case '--target':
        a.target = argv[++i];
        break;
      case '-p':
      case '--platform':
        a.platform = argv[++i];
        break;
      case '-o':
      case '--out':
        a.out = argv[++i];
        break;
      case '-f':
      case '--force':
        a.force = true;
        break;
      case '--no-ripgrep':
        a.ripgrep = false;
        break;
      case '--no-install':
        a.install = false;
        break;
      case '--add-path':
        a.addPath = true;
        break;
      case '--no-add-path':
        a.addPath = false;
        break;
      case '--keep-temp':
        a.keepTemp = true;
        break;
      case '--':
        a.ccFlags = argv.slice(i + 1);
        i = argv.length;
        break;
      case '--no-cc-flags':
        a.noCcFlags = true;
        break;
      case '-y':
      case '--yes':
        a.yes = true;
        break;
      default:
        if (x.startsWith('--link-name=')) a.linkName = x.slice(12);
        else if (x.startsWith('--bin-dir=')) a.binDir = x.slice(10);
        else if (x.startsWith('--target=')) a.target = x.slice(9);
        else if (x.startsWith('--platform=')) a.platform = x.slice(11);
        else if (x.startsWith('--out=')) a.out = x.slice(6);
        else if (x[0] === '-') throw new Error('unknown option: ' + x);
        else a._.push(x);
    }
  }
  return a;
}

// Validate/normalise a --target value to an esbuild "nodeXX" string, min node18.
export function normalizeTarget(t: string): string {
  const m = String(t).match(/^(?:node)?(\d+)$/);
  if (!m) throw new Error('bad --target "' + t + '" (expected node18, node20, … or a number)');
  const major = Number.parseInt(m[1], 10);
  if (major < 18) throw new Error('minimum --target is node18 (Node < 18 needs extra polyfills; not supported)');
  return 'node' + major;
}

// Default target = the Node running cc2js (>= 18), so the build fits this machine.
export function defaultTarget(major = Number.parseInt(process.versions.node.split('.')[0], 10)): string {
  return 'node' + Math.max(18, major);
}

// Whether to install+link (vs just convert to a folder). Link is the default.
// --no-link opts out; --link-name (naming the command) implies you want it
// linked (so it wins even with -o); otherwise a bare -o means "give me a folder".
export function resolveDoLink(args: Args): boolean {
  if (args.noLink) return false;
  if (args.linkName != null) return true;
  return args.out == null;
}

function help(): void {
  const binDefault = process.platform === 'win32' ? '%USERPROFILE%\\.cc2js\\bin' : '~/.local/bin';
  process.stdout.write(
    'cc2js ' +
      pkgVersion() +
      ' — Bun-compiled Claude Code → pure Node\n\n' +
      'Usage:\n' +
      '  cc2js [<version|latest|stable|tarball|binary>] [options]\n' +
      '  cc2js                  install/update the latest Claude Code as `cc2` (= cc2js latest)\n' +
      '  cc2js ls | rm <version> | delink [name] | clean   manage installed versions & links\n\n' +
      'By default cc2js installs to ~/.cc2js and puts a `cc2` command on PATH.\n' +
      'Pass -o (or --no-link) to just convert into a folder instead.\n\n' +
      'Options:\n' +
      '      --no-link            just convert to a folder; install no `cc2` command\n' +
      '      --link-name <name>   name the installed command (default: cc2)\n' +
      '      --bin-dir <dir>      where the launcher goes (default: ' +
      binDefault +
      ')\n' +
      '      --no-add-path        do not persist the bin dir onto PATH (when linking; default: do)\n' +
      '  -t, --target <nodeXX>    transpile target, node18+ (default: this Node, ' +
      defaultTarget() +
      ')\n' +
      '  -p, --platform <p>       target platform (default: this host)\n' +
      '                           one of: ' +
      PLATFORMS.join(', ') +
      '\n' +
      '  -o, --out <dir>          convert into <dir> (implies --no-link unless --link-name given)\n' +
      '  -f, --force              re-convert even if cached; overwrite a foreign launcher\n' +
      '      --no-ripgrep         do not bundle ripgrep\n' +
      '      --no-install         do not npm install runtime deps into the output\n' +
      '      --keep-temp          keep the temp work directory\n' +
      '  -- <claude flags…>       bake flags into the launcher (e.g. -- --dangerously-skip-permissions)\n' +
      '      --no-cc-flags        clear any previously-baked flags on update\n' +
      '  -y, --yes                skip the confirmation prompt (clean)\n' +
      '  -h, --help / -v, --version\n'
  );
}

function mgmtDirs(args: Args): { versionsDir: string; binDir: string } {
  return {
    versionsDir: path.join(cc2Home(), 'versions'),
    binDir: args.binDir ?? defaultBinDir()
  };
}

export function renderLs(versionsDir: string, versions: VersionEntry[], links: LinkEntry[], binDir: string): string {
  const lines: string[] = [];
  lines.push('Installed versions (' + versionsDir + '):');
  if (!versions.length) lines.push('  (none)');
  for (const v of versions) {
    const mb = (v.bytes / 1e6).toFixed(1) + ' MB';
    const used = links.some((l) => l.target.startsWith(v.dir + path.sep)) ? '  ← linked' : '';
    lines.push('  ' + v.version + '  ' + v.platform + '  ' + mb + used);
  }
  lines.push('');
  lines.push('Links (' + binDir + '):');
  if (!links.length) lines.push('  (none)');
  for (const l of links) {
    const flags = l.ccFlags.length ? '  [' + l.ccFlags.join(' ') + ']' : '';
    const state = l.dangling ? '  MISSING (target gone)' : '';
    lines.push('  ' + l.name + ' → ' + (l.version ?? '?') + ' (' + (l.platform ?? '?') + ')' + flags + state);
  }
  return lines.join('\n') + '\n';
}

export async function runManage(sub: string, args: Args): Promise<void> {
  const { versionsDir, binDir } = mgmtDirs(args);
  const target = args._[1];

  if (sub === 'ls') {
    const versions = listVersions(versionsDir).sort((a, b) =>
      (a.version + a.platform).localeCompare(b.version + b.platform)
    );
    const links = listLinks(binDir).sort((a, b) => a.name.localeCompare(b.name));
    process.stdout.write(renderLs(versionsDir, versions, links, binDir));
    return;
  }

  if (sub === 'rm') {
    if (!target) throw new Error('usage: cc2js rm <version>');
    const r = removeVersion(target, versionsDir, binDir); // throws on unknown version
    for (const d of r.removed) log.ok('removed ' + d);
    for (const d of r.delinked) log.ok('delinked ' + d);
    return;
  }

  if (sub === 'delink') {
    const name = target ?? 'cc2';
    const removed = delinkLauncher(binDir, name);
    if (!removed.length) throw new Error('no cc2js launcher named "' + name + '" in ' + binDir);
    for (const p of removed) log.ok('delinked ' + p);
    return;
  }

  // clean
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new Error('refusing to clean without --yes (non-interactive)');
    if (!(await confirm('Remove ALL cc2js versions and links? [y/N] '))) {
      log.info('aborted');
      return;
    }
  }
  const r = clean(versionsDir, binDir);
  log.ok('removed ' + r.removedVersions.length + ' version(s), ' + r.delinked.length + ' launcher file(s)');
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    log.err((e as Error).message);
    process.exit(2);
  }

  if (args.version) {
    process.stdout.write(pkgVersion() + '\n');
    return;
  }
  if (args.help) {
    help();
    process.exit(0);
  }

  const sub = args._[0];
  if (sub === 'ls' || sub === 'rm' || sub === 'delink' || sub === 'clean') {
    runManage(sub, args).catch((e) => {
      log.err((e as Error).message);
      process.exit(1);
    });
    return;
  }

  const platform = args.platform ?? hostPlatform();
  if (args.platform && !PLATFORMS.includes(args.platform)) {
    log.warn('unusual platform "' + args.platform + '" (known: ' + PLATFORMS.join(', ') + ')');
  }

  let target: string;
  try {
    target = args.target ? normalizeTarget(args.target) : defaultTarget();
  } catch (e) {
    log.err((e as Error).message);
    process.exit(2);
  }

  const input = args._[0] ?? 'latest'; // bare `cc2js` ⇒ latest
  const doLink = resolveDoLink(args); // link by default, unless -o / --no-link
  const linkName = args.linkName ?? 'cc2';

  const fail = (e: unknown) => {
    log.err((e as Error).message);
    if (process.env.DEBUG) console.error((e as Error).stack);
    process.exit(1);
  };

  if (doLink) {
    if (args.platform && args.platform !== hostPlatform()) {
      log.warn('linking a ' + platform + ' build; it will not run on this host (' + hostPlatform() + ')');
    }
    if (!args.install) log.warn('--no-install while linking: the linked command will lack runtime deps');
    install({
      input,
      name: linkName,
      platform,
      target,
      binDir: args.binDir ?? undefined,
      out: args.out ? path.resolve(args.out) : undefined,
      install: args.install,
      ripgrep: args.ripgrep,
      force: args.force,
      keepTemp: args.keepTemp,
      addPath: args.addPath,
      ccFlags: args.ccFlags ?? undefined,
      noCcFlags: args.noCcFlags,
      log
    })
      .then((r) => {
        if (r.status === 'unchanged') {
          log.ok(linkName + ' already up to date → ' + r.launcherPath + '  [Claude Code ' + r.version + ']');
        } else {
          const verb = r.status === 'linked' ? 'linked' : 'updated';
          const ver =
            r.status === 'updated' && r.previousVersion && r.previousVersion !== r.version
              ? r.previousVersion + ' → ' + r.version
              : r.version;
          log.ok(verb + ' ' + linkName + ' → ' + r.launcherPath + '  [Claude Code ' + ver + ']');
        }
        if (r.ccFlags.length) log.info('baked flags: ' + r.ccFlags.join(' '));
        if (!r.onPath) {
          const dir = path.dirname(r.launcherPath);
          const ap = r.addPath;
          if (ap?.changed) {
            log.ok('added to PATH (' + ap.target + ')');
            log.warn('open a NEW terminal to use ' + linkName + (ap.activate ? ', or run now:  ' + ap.activate : ''));
          } else if (ap?.ok) {
            log.warn(
              dir +
                ' is on your PATH but not this shell — open a new terminal' +
                (ap.activate ? ' (or: ' + ap.activate + ')' : '')
            );
          } else {
            log.warn(dir + ' is not on PATH.');
            if (ap?.manualLine) log.warn('add it by hand:  ' + ap.manualLine);
            else if (process.platform === 'win32') {
              log.warn('add it to your user PATH:  ' + r.pathHint);
              log.warn('or: System → Environment Variables → Path → New → ' + dir);
            } else {
              log.warn('add it to your shell rc (~/.bashrc, ~/.zshrc, ~/.profile):  ' + r.pathHint);
            }
          }
        }
        log.step('run:  ' + linkName + ' --version');
        process.exit(0);
      })
      .catch(fail);
    return;
  }

  convert({
    input,
    platform,
    target,
    out: args.out ? path.resolve(args.out) : undefined,
    ripgrep: args.ripgrep,
    install: args.install,
    keepTemp: args.keepTemp,
    log
  })
    .then((r) => {
      log.ok('converted Claude Code ' + r.version + ' → ' + r.outDir);
      process.exit(0);
    })
    .catch(fail);
}

if (require.main === module) main();
