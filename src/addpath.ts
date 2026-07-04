/*
 * Persist the launcher's bin dir onto the user's PATH so a freshly linked `cc2`
 * works in new shells without a manual edit. Driven by --add-path (on by default
 * in the CLI). Best-effort and idempotent:
 *
 *   Windows   -> the User PATH via PowerShell SetEnvironmentVariable(...,'User').
 *                One write covers cmd.exe, PowerShell and Git Bash. (NOT setx —
 *                setx truncates PATH at 1024 chars and can corrupt it.)
 *   bash/zsh  -> append a marker-guarded `export PATH=...` to the shell rc.
 *
 * Other shells (fish, tcsh, …) use different files/syntax, so we don't guess —
 * we hand back the correct line for the caller to print. And nothing can update
 * an ALREADY-OPEN shell: a new terminal (or `source`) is always needed.
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PATH_MARKER = '# cc2js (PATH)';

export interface AddPathResult {
  ok: boolean; // dir is now persistently on PATH (added this run, or already was)
  changed: boolean; // we wrote something this run
  target?: string; // what we wrote (rc file path, or "Windows user PATH")
  manualLine?: string; // when we could not auto-add: the exact line to add by hand
  activate?: string; // enable it in the CURRENT shell right now (no new terminal)
  note?: string; // short human note (detected shell, why manual, etc.)
}

// ---- pure helpers (unit-tested) ----

export function shellName(shell: string): string {
  return shell.replace(/.*[\\/]/, '').trim();
}

export function unixExportLine(binDir: string): string {
  return 'export PATH="' + binDir + ':$PATH"';
}

// The right-syntax manual line for a given shell (fish/tcsh differ from POSIX).
export function manualLineFor(shell: string, binDir: string): string {
  const name = shellName(shell);
  if (name === 'fish') return 'fish_add_path ' + binDir;
  if (name === 'tcsh' || name === 'csh') return 'setenv PATH "' + binDir + ':$PATH"';
  return unixExportLine(binDir);
}

// Which rc file to append to; null => shell we won't auto-edit (caller prints).
export function pickRcFile(shell: string, platform: string, home: string): string | null {
  const name = shellName(shell);
  if (name === 'zsh') return path.join(home, '.zshrc');
  if (name === 'bash') return path.join(home, platform === 'darwin' ? '.bash_profile' : '.bashrc');
  if (name === 'sh' || name === 'dash') return path.join(home, '.profile');
  return null; // fish, tcsh, unknown
}

// Already configured if the dir is referenced at all (our marked block from a
// previous run, or a line the user added by hand) — so we never double-add.
export function rcHasEntry(content: string, binDir: string): boolean {
  return content.includes(binDir);
}

// ---- entry ----

export function addToPath(binDir: string): AddPathResult {
  return process.platform === 'win32' ? addWindows(binDir) : addUnix(binDir);
}

function addWindows(binDir: string): AddPathResult {
  const esc = binDir.replace(/'/g, "''"); // single-quote for PowerShell
  const script = [
    "$ErrorActionPreference='Stop'",
    "$b='" + esc + "'",
    "$p=[Environment]::GetEnvironmentVariable('Path','User'); if($null -eq $p){$p=''}",
    "$parts=@($p -split ';' | Where-Object {$_ -ne ''})",
    "if($parts -contains $b){'PRESENT'}else{[Environment]::SetEnvironmentVariable('Path',(($parts+$b) -join ';'),'User');'ADDED'}"
  ].join('; ');
  try {
    const out = cp
      .execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true
      })
      .trim();
    const changed = out.endsWith('ADDED');
    return { ok: true, changed, target: 'Windows user PATH', note: changed ? undefined : 'already present' };
  } catch (e) {
    // leave manualLine unset so the CLI falls back to its setx / System-settings hint
    return { ok: false, changed: false, note: 'powershell failed: ' + (e as Error).message };
  }
}

function addUnix(binDir: string): AddPathResult {
  const shell = process.env.SHELL || '';
  const rc = pickRcFile(shell, process.platform, os.homedir());
  if (!rc) {
    const manual = manualLineFor(shell, binDir);
    return {
      ok: false,
      changed: false,
      manualLine: manual,
      activate: manual,
      note: 'unrecognized shell (' + (shellName(shell) || '?') + ')'
    };
  }
  return addToRc(rc, binDir);
}

// Idempotently append a marker-guarded `export PATH=...` to an rc file. Exported
// for tests (pure fs, no platform/shell branching).
export function addToRc(rc: string, binDir: string): AddPathResult {
  const line = unixExportLine(binDir);
  let content = '';
  try {
    content = fs.readFileSync(rc, 'utf8');
  } catch {
    /* rc doesn't exist yet — we'll create it */
  }
  if (rcHasEntry(content, binDir)) {
    return { ok: true, changed: false, target: rc, activate: 'source ' + rc, note: 'already in ' + path.basename(rc) };
  }
  const block = (content && !content.endsWith('\n') ? '\n' : '') + PATH_MARKER + '\n' + line + '\n';
  try {
    fs.appendFileSync(rc, block);
    return { ok: true, changed: true, target: rc, activate: 'source ' + rc };
  } catch {
    return { ok: false, changed: false, manualLine: line, activate: line, note: 'could not write ' + rc };
  }
}
