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
