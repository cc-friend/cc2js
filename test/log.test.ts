import assert from 'node:assert/strict';
import { test } from 'node:test';
import log from '../src/log';

test('log exposes the Logger methods', () => {
  for (const m of ['step', 'info', 'ok', 'warn', 'err', 'raw', 'reset'] as const) {
    assert.equal(typeof log[m], 'function');
  }
});

test('log methods do not throw', () => {
  assert.doesNotThrow(() => log.ok('hello'));
});

// Run fn with stderr posing as a terminal, returning everything written to it.
function onTty(fn: () => void): string {
  const err = process.stderr as NodeJS.WriteStream & { isTTY: boolean };
  const { isTTY, write } = err;
  let out = '';
  err.isTTY = true;
  err.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof err.write;
  try {
    fn();
  } finally {
    err.isTTY = isTTY;
    err.write = write;
  }
  return out;
}

test('progress draws a live line that the next log line wipes first', () => {
  const out = onTty(() => {
    const stop = log.progress?.(() => 'bundling 3/9 modules');
    log.ok('done');
    stop?.();
  });
  assert.ok(out.startsWith('\r\x1b[K'), 'drawn from column 0 over a clean line');
  assert.ok(out.includes('bundling 3/9 modules\r\x1b[K'), 'cleared before the ok line');
  assert.ok(out.endsWith('done\n'), 'stop() adds nothing once the line is gone');
});

test('stop() wipes the live line', () => {
  const out = onTty(() => log.progress?.(() => 'working')());
  assert.ok(out.endsWith('working\r\x1b[K'));
});

test('progress stays silent off a terminal', () => {
  let out = '';
  const { write } = process.stderr;
  process.stderr.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    if (!process.stderr.isTTY) log.progress?.(() => 'working')();
  } finally {
    process.stderr.write = write;
  }
  assert.equal(out, '');
});
