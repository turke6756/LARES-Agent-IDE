// Unit tests for the WP-1a runner delete-shutdown contract:
//   disposeForDelete() / closeLogStream() / persistScrollback() _deleting guard
// on BOTH WindowsRunner and WslRunner.
//
//   npm run build:main
//   node dist/main/main/supervisor/delete-log-reclaim.test.js

import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delete-reclaim-'));
}

/** A fake WriteStream whose `end()` emits exactly one of the settle events on a
 *  later microtask/tick, so we can prove the close Promise waits for it. */
function makeFakeStream(settleEvent: 'finish' | 'close' | 'error'): { stream: any; events: string[] } {
  const events: string[] = [];
  const stream = new EventEmitter() as any;
  stream.end = () => {
    events.push('end');
    process.nextTick(() => stream.emit(settleEvent, settleEvent === 'error' ? new Error('boom') : undefined));
  };
  return { stream, events };
}

// ── WindowsRunner: full disposeForDelete contract ─────────────────────

test('WindowsRunner.disposeForDelete resolves only AFTER the log stream closes', async () => {
  const r = new WindowsRunner();
  const { stream, events } = makeFakeStream('finish');
  (r as any).logStream = stream;

  const p = r.disposeForDelete();
  let done = false;
  p.then(() => { done = true; });
  // Synchronously (before the nextTick that emits 'finish') the delete must be
  // pending — it has awaited closeLogStream() which is still waiting on 'finish'.
  assert.equal(done, false, 'disposeForDelete pending until stream settles');
  assert.deepEqual(events, ['end'], 'stream.end() was called');

  await p;
  assert.equal(done, true, 'disposeForDelete resolved after finish');
  assert.equal((r as any).logStream, null, 'logStream nulled');
  assert.equal((r as any).host, null, 'host cleared');
});

test('WindowsRunner: a late exit -> persistScrollback() after disposeForDelete is a no-op (.scrollback not recreated)', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'agent.log');
  fs.writeFileSync(logPath, 'log');
  const r = new WindowsRunner();
  (r as any)._logPath = logPath;
  (r as any).outputRing = ['line-a', 'line-b'];
  const { stream } = makeFakeStream('finish');
  (r as any).logStream = stream;

  await r.disposeForDelete();
  // Simulate the reclaim pass having already removed the sidecar.
  fs.rmSync(logPath + '.scrollback', { force: true });
  assert.ok(!fs.existsSync(logPath + '.scrollback'), 'precondition: .scrollback gone');

  // A late pty-host `exit` handler would call persistScrollback — it must no-op.
  r.persistScrollback();
  assert.ok(!fs.existsSync(logPath + '.scrollback'), '.scrollback NOT recreated after delete');
});

test('WindowsRunner.closeLogStream settles once on an error-only stream (no stuck delete)', async () => {
  const r = new WindowsRunner();
  const { stream } = makeFakeStream('error');
  (r as any).logStream = stream;
  // Should resolve (not reject, not hang) even though only 'error' fires.
  await (r as any).closeLogStream();
  assert.equal((r as any).logStream, null, 'logStream nulled after close');
});

test('WindowsRunner.closeLogStream resolves immediately when there is no stream', async () => {
  const r = new WindowsRunner();
  (r as any).logStream = null;
  await (r as any).closeLogStream(); // must not hang
});

// ── WslRunner: guard + closeLogStream (avoid real tmux teardown) ───────

test('WslRunner.persistScrollback is a no-op once _deleting is set (guard)', () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'wsl-agent.log');
  const r = new WslRunner('sess-test');
  (r as any)._logPath = logPath;
  (r as any).outputRing = ['x', 'y'];

  // Baseline: without the guard, persistScrollback writes the sidecar.
  r.persistScrollback();
  assert.ok(fs.existsSync(logPath + '.scrollback'), 'baseline: sidecar written');
  fs.rmSync(logPath + '.scrollback', { force: true });

  // With _deleting set, it must no-op.
  (r as any)._deleting = true;
  r.persistScrollback();
  assert.ok(!fs.existsSync(logPath + '.scrollback'), 'guarded persistScrollback did not write');
});

test('WslRunner.closeLogStream settles once on an error-only stream', async () => {
  const r = new WslRunner('sess-test-2');
  const { stream } = makeFakeStream('error');
  (r as any).logStream = stream;
  await (r as any).closeLogStream();
  assert.equal((r as any).logStream, null, 'logStream nulled after close');
});

// ── Runner ────────────────────────────────────────────────────────────

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
