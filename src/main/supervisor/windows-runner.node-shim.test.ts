// Focused windows-runner test for the node-shim PATH injection
// (bundled-node-exposure plan §1.3 / §1.6).
//
// The multi-transport matrix stubs WindowsRunner.launch wholesale, so it never
// reaches the env build. This test drives the REAL launch() with spawnBundledNode
// intercepted, and asserts the env it hands the pty-host:
//   (i)  has the userData node-shim dir at the TAIL of PATH (system-first, §0.3);
//   (ii) does NOT contain ELECTRON_RUN_AS_NODE — the real spawnBundledNode adds
//        that AFTER, and it must never be in the env windows-runner assembles
//        (the flag is confined to the shim process, §0.4).
//
// Compile + run:
//   npm run build:main
//   node dist/main/main/supervisor/windows-runner.node-shim.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

// Intercept spawnBundledNode BEFORE requiring windows-runner. The compiled
// module reads node_runtime_1.spawnBundledNode at call time, so patching the
// exported property is sufficient.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeRuntime = require('../node-runtime') as Record<string, unknown>;
const origSpawn = nodeRuntime.spawnBundledNode;
let capturedEnv: NodeJS.ProcessEnv | undefined;
const fakeChild = {
  stdout: { setEncoding() {}, on() {} },
  stderr: { on() {} },
  stdin: { writable: false, write() {} },
  on() {},
  kill() {},
  killed: false,
};
nodeRuntime.spawnBundledNode = (
  _script: string,
  _args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => {
  capturedEnv = opts?.env;
  return fakeChild;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WindowsRunner } = require('./windows-runner') as typeof import('./windows-runner');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getNodeShimDir } = require('../node-shim') as typeof import('../node-shim');

function inTempCwd(fn: (shimDir: string, logPath: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-winrunner-shim-'));
  const savedCwd = process.cwd();
  process.chdir(root);
  try {
    fn(getNodeShimDir(), path.join(root, 'logs', 'agent.log'));
  } finally {
    process.chdir(savedCwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

test('launch() appends the shim dir to PATH (last) and passes no ELECTRON_RUN_AS_NODE', () => {
  inTempCwd((shimDir, logPath) => {
    const runner = new WindowsRunner();
    runner.launch(path.dirname(logPath), 'claude', [], logPath, false, { EXTRA_MARKER: 'yes' });

    assert.ok(capturedEnv, 'spawnBundledNode must have been called with an env');
    const env = capturedEnv!;
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const parts = (env[key] ?? '').split(';').filter(Boolean);
    assert.equal(parts[parts.length - 1], shimDir, 'shim dir must be at the tail of PATH (system-first)');
    // The flag is added by the real spawnBundledNode, AFTER this env is built —
    // it must never appear in the env windows-runner assembles.
    assert.equal('ELECTRON_RUN_AS_NODE' in env, false,
      'windows-runner must not put ELECTRON_RUN_AS_NODE in the pty-host env');
    // Sanity: extraEnv merge still works.
    assert.equal(env.EXTRA_MARKER, 'yes');

    runner.kill();
  });
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error('       ', err instanceof Error ? err.stack || err.message : err);
    failed++;
  }
}
nodeRuntime.spawnBundledNode = origSpawn;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
