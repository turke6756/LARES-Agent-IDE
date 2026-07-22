// Unit tests for the bundled-Node spawn helper (plan §5.2, ground truth F3).
//
// What these DO cover: the command/argv/env decision. What they cannot cover:
// whether Electron-as-Node actually boots the helper on a machine with no
// system Node — that needs the packaged app and is scripted in
// scripts/verify-bundled-node.ps1.
//
// Compile + run:
//   npm run build:main
//   node dist/main/main/node-runtime.test.js

import assert from 'node:assert/strict';
import { buildBundledNodeSpawn, isElectronRuntime } from './node-runtime';
import { sanitizeClaudeChildEnv } from './supervisor/env-sanitize';

interface TestCase {
  name: string;
  run(): void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

test('packaged/Electron mode targets process.execPath with ELECTRON_RUN_AS_NODE=1', () => {
  const plan = buildBundledNodeSpawn('C:\\app\\pty-host.js', [], {
    env: { PATH: 'C:\\Windows\\system32' },
    electron: true,
  });
  assert.equal(plan.command, process.execPath);
  assert.equal(plan.electronAsNode, true);
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, '1');
  // Never the literal 'node' — that is the whole bug (F3).
  assert.notEqual(plan.command, 'node');
});

test('plain-Node mode uses the current node binary and sets no Electron marker', () => {
  const plan = buildBundledNodeSpawn('/tmp/pty-host.js', [], {
    env: { PATH: '/usr/bin' },
    electron: false,
  });
  assert.equal(plan.command, process.execPath);
  assert.equal(plan.electronAsNode, false);
  assert.equal('ELECTRON_RUN_AS_NODE' in plan.env, false);
});

test('plain-Node mode strips an inherited ELECTRON_RUN_AS_NODE', () => {
  const plan = buildBundledNodeSpawn('/tmp/h.js', [], {
    env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' },
    electron: false,
  });
  assert.equal('ELECTRON_RUN_AS_NODE' in plan.env, false);
});

test('under the plain-Node test runner, runtime detection reports non-Electron', () => {
  // Guards the detection itself: if this ever flipped, the helper would set the
  // marker on a real node binary, which node ignores but every descendant
  // inherits.
  assert.equal(isElectronRuntime(), Boolean(process.versions.electron));
  assert.equal(isElectronRuntime(), false);
});

test('child-session sanitization survives the change (sanitize first, flag second)', () => {
  // The runners sanitize and hand the result in; the helper must add the flag
  // AFTER, never re-introduce a poisoned key, and never drop a legitimate one.
  const env = sanitizeClaudeChildEnv({
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'deadbeef',
    PATH: 'C:\\Windows\\system32',
    AGENT_DASHBOARD_API_TOKEN: 'tok',
  });
  const plan = buildBundledNodeSpawn('C:\\app\\pty-host.js', [], { env, electron: true });
  assert.equal('CLAUDECODE' in plan.env, false);
  assert.equal('CLAUDE_CODE_SESSION_ID' in plan.env, false);
  assert.equal(plan.env.PATH, 'C:\\Windows\\system32');
  assert.equal(plan.env.AGENT_DASHBOARD_API_TOKEN, 'tok');
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, '1');
});

test('the caller env is copied, not mutated', () => {
  const env = { PATH: 'C:\\Windows\\system32' } as NodeJS.ProcessEnv;
  buildBundledNodeSpawn('C:\\app\\h.js', [], { env, electron: true });
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
});

test('a script path containing spaces is passed as one argv element (no quoting)', () => {
  const p = 'C:\\Program Files\\Lares\\resources\\app.asar\\main\\main\\pty-host.js';
  const plan = buildBundledNodeSpawn(p, [], { env: {}, electron: true });
  assert.deepEqual(plan.args, [p]);
  // The path must NOT be pre-quoted: spawn() without a shell passes argv
  // verbatim, so an added quote would become part of the filename.
  assert.equal(plan.args[0].includes('"'), false);
});

test('extra args are appended after the script path, in order', () => {
  const plan = buildBundledNodeSpawn('/a/h.js', ['--flag', 'a b'], { env: {}, electron: false });
  assert.deepEqual(plan.args, ['/a/h.js', '--flag', 'a b']);
});

test('runtime detection is the default when no override is given', () => {
  const plan = buildBundledNodeSpawn('/a/h.js', [], { env: {} });
  assert.equal(plan.electronAsNode, isElectronRuntime());
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
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
