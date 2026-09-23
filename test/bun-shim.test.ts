import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bundleGraph } from '../src/bundle';
import { debun } from '../src/debun';
import { transpile } from '../src/transpile';

const shim = fs.readFileSync(path.join(__dirname, '../assets/bun-shim.cjs'), 'utf8');
// Claude Code 2.1.270 guards the method, but assumes the unsafe namespace exists.
const startup = 'if (typeof Bun < "u") Bun.unsafe.setJITPolicy?.(1); console.log("ready");';

function assertStarts(code: string): void {
  // The real shim patches Node's module loader, fs and PATH; isolate those effects.
  const result = spawnSync(process.execPath, ['--input-type=commonjs'], {
    input: code,
    encoding: 'utf8',
    timeout: 10000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ready');
}

test('Bun shim supports the startup JIT probe in a transpiled CJS bundle', async () => {
  const code = await transpile(debun(startup, shim, '2.1.270'), '', 'node18');
  assertStarts(code);
});

test('Bun shim supports the startup JIT probe in ESM entry and worker bundles', async () => {
  const entry = '/$bunfs/root/cli';
  const chunk = '/$bunfs/root/chunk-startup.js';
  const worker = '/$bunfs/root/src/worker.js';
  const files = await bundleGraph(
    {
      entry,
      files: new Map([
        [entry, `import "${chunk}";`],
        [chunk, startup],
        [worker, `import "${chunk}";`]
      ]),
      extras: [worker]
    },
    { shim, polyfills: '', version: '2.1.270', target: 'node18' }
  );
  assert.deepEqual(
    files.map((file) => file.name),
    ['cli.js', 'src/worker.js']
  );
  for (const file of files) assertStarts(file.code);
});

// Run `body` (a function body) in a fresh Node after the shim and parse what it returns.
function withShim(body: string): unknown {
  const result = spawnSync(process.execPath, ['--input-type=commonjs'], {
    input: `${shim}\n;console.log(JSON.stringify((() => {${body}\n})()));`,
    encoding: 'utf8',
    timeout: 10000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// How Claude Code 2.1.273+ builds its ink line segmenter, and how ink reads a segment() back.
const segmenter = `const seg = new Bun.ant.CellSegmenter({ ambiguousIsNarrow: true, substitute: [[1564, 1564], [8234, 8238], [8294, 8297]],
  screen: { widthMask: 3, narrow: 0, wide: 1, spacerTail: 2, spacerHead: 3, emptyCharIndex: 0, spacerCharIndex: 1, emptyWord: 0, tabWidth: 8 } });
const cells = new Int32Array(64), runs = new Int32Array(64);
function decode(text) {
  const n = seg.segment(text, cells, runs, false), out = [];
  for (let i = 0; i < n; i++) {
    const p = cells[2 * i + 1], r = p >>> 10;
    out.push([seg.graphemes[cells[2 * i]], p & 255, (p & 256) !== 0, r, seg.sgrKeys[runs[2 * r]], seg.sgrCloseKeys[runs[2 * r]], seg.uris[runs[2 * r + 1]]]);
  }
  return out;
}
const unpack = (r) => ({ cursor: r % 1048576, from: Math.floor(r / 1048576) % 65536, to: Math.floor(r / 68719476736) });`;

test('CellSegmenter splits a line into grapheme cells, expanding nothing but flagging tabs', () => {
  // a, wide CJK, tab, a bidi override (substituted), e + combining acute, then a BEL
  // and an erase-line escape that paint nothing
  const out = withShim(`${segmenter}\nreturn decode('a中\\t\\u202Ee\\u0301\\x07\\x1b[2K!');`);
  assert.deepEqual(out, [
    ['a', 1, false, 0, '', '', ''],
    ['中', 2, false, 0, '', '', ''],
    [' ', 0, true, 0, '', '', ''],
    ['�', 1, false, 0, '', '', ''],
    ['é', 1, false, 0, '', '', ''],
    ['!', 1, false, 0, '', '', '']
  ]);
});

test('CellSegmenter groups cells into runs by SGR style and OSC 8 link', () => {
  const out = withShim(
    `${segmenter}\nreturn decode('\\x1b[1;31mA\\x1b[39mB\\x1b[0m\\x1b]8;;https://x.test\\x07C\\x1b]8;;\\x1b\\\\D');`
  );
  assert.deepEqual(out, [
    ['A', 1, false, 0, '\x1b[1m\0\x1b[31m', '\x1b[22m\0\x1b[39m', ''],
    ['B', 1, false, 1, '\x1b[1m', '\x1b[22m', ''],
    ['C', 1, false, 2, '', '', 'https://x.test'],
    ['D', 1, false, 3, '', '', '']
  ]);
});

test('CellSegmenter asks for bigger buffers by returning the negated cell count', () => {
  const out = withShim(
    `${segmenter}\nreturn [seg.segment('abc', new Int32Array(4), new Int32Array(4), false), seg.segment('abc', new Int32Array(6), new Int32Array(6), false)];`
  );
  assert.deepEqual(out, [-3, 3]);
});

test('CellSegmenter paints cells onto a screen row: wide tails, tab stops, clipping', () => {
  const out = withShim(`${segmenter}
const n = seg.segment('a中\\tb', cells, runs, false);
const chars = Int32Array.from(seg.graphemes, (_, i) => 10 + i), words = Int32Array.of(5 << 17);
const screen = new Int32Array(2 * 6);
return { ...unpack(seg.paint(screen, 6, 0, 0, cells, n, undefined, chars, words)), screen: [...screen] };`);
  const style = 5 << 17;
  assert.deepEqual(out, {
    cursor: 7, // the tab ran to the screen edge; the clipped "b" still advances
    from: 0,
    to: 6,
    screen: [10, style, 11, style | 1, 1, 2, 0, 0, 0, 0, 0, 0]
  });
});

test('CellSegmenter leaves a spacer head where a wide char would overflow the row', () => {
  const out = withShim(`${segmenter}
const n = seg.segment('ab中', cells, runs, false);
const screen = new Int32Array(2 * 3);
return { ...unpack(seg.paint(screen, 3, 0, 0, cells, n, undefined, Int32Array.of(7, 8, 9), Int32Array.of(0))), screen: [...screen] };`);
  assert.deepEqual(out, { cursor: 3, from: 0, to: 3, screen: [7, 0, 8, 0, 0, 3, 0, 0].slice(0, 6) });
});

test('CellSegmenter.setCell clears the other half of a wide char it overwrites', () => {
  const out = withShim(`${segmenter}
const screen = new Int32Array(2 * 4), steps = [];
steps.push([unpack(seg.setCell(screen, 4, 1, 0, 7, 1)), [...screen]]); // wide at 1 → tail at 2
steps.push([unpack(seg.setCell(screen, 4, 2, 0, 8, 0)), [...screen]]); // narrow over the tail → head cleared
seg.setCell(screen, 4, 0, 0, 9, 1);
steps.push([unpack(seg.setCell(screen, 4, 0, 0, 6, 0)), [...screen]]); // narrow over a head → tail cleared
return steps;`);
  assert.deepEqual(out, [
    [{ cursor: 2, from: 1, to: 3 }, [0, 0, 7, 1, 1, 2, 0, 0]],
    [{ cursor: 3, from: 1, to: 3 }, [0, 0, 0, 0, 8, 0, 0, 0]],
    [{ cursor: 1, from: 0, to: 2 }, [6, 0, 0, 0, 8, 0, 0, 0]]
  ]);
});

test('Bun.sliceAnsi slices by columns and keeps the styles and links open across the cut', () => {
  const out = withShim(`return [
  Bun.sliceAnsi('hello', 1, 3),
  Bun.sliceAnsi('\\x1b[31mhello\\x1b[39m', 1, 3),
  Bun.sliceAnsi('a中b', 0, 2),
  Bun.sliceAnsi('a中b', 1),
  Bun.sliceAnsi('\\x1b]8;;u\\x07link\\x1b]8;;\\x07', 0, 2),
  Bun.sliceAnsi('\\x1b[31mab', 5, 6)
];`);
  assert.deepEqual(out, [
    'el',
    '\x1b[31mel\x1b[39m',
    'a', // the wide char would straddle the end
    '中b',
    '\x1b]8;;u\x07li\x1b]8;;\x07',
    ''
  ]);
});

test('Bun.sleepSync blocks and Bun.hash.xxHash64 gives a stable 64-bit key', () => {
  const out = withShim(`const t = Date.now(); Bun.sleepSync(30);
return [Date.now() - t >= 25, typeof Bun.hash.xxHash64('abc'), Bun.hash.xxHash64('abc') === Bun.hash.xxHash64('abc')];`);
  assert.deepEqual(out, [true, 'bigint', true]);
});
