// Memory-hardening WP-3a — runner log byte-offset instrumentation, write
// barrier, ring snapshot, and epoch.
//
//   npm run build:main
//   node dist/main/main/supervisor/runner-log-offsets.test.js
//
// Drives BOTH runners' private `handleMessage({type:'data'})` path directly
// (no pty-host process) with an injected log stream, plus the private
// `_resetLogEpoch()` the launch/reconnect paths call. Covers:
//   - offset == cumulative UTF-8 byte length (incl. multibyte)
//   - the emitted `data` event carries the logical end offset
//   - `_resetLogEpoch` resets offsets to the file's append base + mints a new
//     epoch and emits `epochChanged` (the reused-instance reconnect contract)
//   - `logWriteBarrier` resolves only after the queued write is readable from an
//     INDEPENDENT fd, and reports the contiguous flushed prefix
//   - on a write error the barrier cutoff never exceeds the fstat file size and
//     `degraded===true`; `_lastFlushedOffset` freezes at the FIRST failed write
//     even when later writes succeed
//   - `getRingSnapshot` captures ring text + the current logical cursor

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert/strict';

import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';

// ── Minimal harness ──────────────────────────────────────────────────
interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

function freshDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'wp3a-')); }

/** A controllable write stream stand-in. Records writes, mirrors successful
 *  writes into an in-memory buffer, and fails writes at/after `failFrom`.
 *  Callbacks fire asynchronously and IN ORDER (Node's Writable guarantees this
 *  for the real stream too). */
class FakeStream {
  writes: string[] = [];
  buffer: Buffer = Buffer.alloc(0);
  // Fail ONLY the writes whose index is in this set — so a test can fail a
  // middle write while a LATER write succeeds (the freeze-even-if-later-succeeds
  // case). Callbacks fire in FIFO order like the real Writable.
  failAt: Set<number> = new Set();
  write(data: string, cb: (err?: Error | null) => void): boolean {
    const idx = this.writes.length;
    this.writes.push(data);
    if (this.failAt.has(idx)) {
      setImmediate(() => cb(new Error('simulated disk error')));
    } else {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(data, 'utf8')]);
      setImmediate(() => cb());
    }
    return true;
  }
  end(): void {}
}

function feed(runner: any, data: string): void {
  runner.handleMessage({ type: 'data', data });
}

/** Attach a real append-mode WriteStream to `runner` and reset its epoch so the
 *  base offset reflects the (possibly non-empty) file. Returns the log path. */
function attachRealStream(runner: any, dir: string, name = 'agent.log'): string {
  const p = path.join(dir, name);
  // Ensure the file exists so statSync in _resetLogEpoch reads a real size.
  fs.writeFileSync(p, '');
  runner._logPath = p;
  runner.logStream = fs.createWriteStream(p, { flags: 'a' });
  runner._resetLogEpoch();
  return p;
}

// ── WindowsRunner ─────────────────────────────────────────────────────

test('win: offset == cumulative UTF-8 byte length (incl. multibyte) and is emitted', async () => {
  const dir = freshDir();
  const runner: any = new WindowsRunner();
  attachRealStream(runner, dir);
  const emitted: number[] = [];
  runner.on('data', (_d: string, off: number) => emitted.push(off));

  feed(runner, 'abc');        // 3 bytes
  feed(runner, '€');          // 3 bytes (E2 82 AC)
  feed(runner, 'x€y');        // 1 + 3 + 1 = 5 bytes

  assert.equal(runner.currentLogOffset, 11, 'currentLogOffset is the UTF-8 byte total');
  assert.deepEqual(emitted, [3, 6, 11], 'each data event carries its logical end offset');
});

test('win: logWriteBarrier resolves only after bytes are readable from an independent fd', async () => {
  const dir = freshDir();
  const runner: any = new WindowsRunner();
  const p = attachRealStream(runner, dir);

  feed(runner, 'hello ');
  feed(runner, 'world');
  const { cutoff, degraded } = await runner.logWriteBarrier();

  assert.equal(degraded, false);
  assert.equal(cutoff, 11, 'cutoff is the flushed prefix');
  // Independent read: the bytes up to `cutoff` are on disk now.
  const onDisk = fs.readFileSync(p);
  assert.ok(onDisk.length >= cutoff, 'file size >= cutoff after barrier');
  assert.equal(onDisk.subarray(0, cutoff).toString('utf8'), 'hello world');
});

test('win: base offset follows the append size of a pre-existing log', async () => {
  const dir = freshDir();
  const p = path.join(dir, 'agent.log');
  fs.writeFileSync(p, 'PRELUDE\n'); // 8 bytes already on disk
  const runner: any = new WindowsRunner();
  runner._logPath = p;
  runner.logStream = fs.createWriteStream(p, { flags: 'a' });
  runner._resetLogEpoch();

  assert.equal(runner.currentLogOffset, 8, 'base starts at the existing file size');
  const emitted: number[] = [];
  runner.on('data', (_d: string, off: number) => emitted.push(off));
  feed(runner, 'more');
  assert.equal(runner.currentLogOffset, 12);
  assert.deepEqual(emitted, [12], 'offset is absolute, not stream-relative');
  const { cutoff } = await runner.logWriteBarrier();
  assert.equal(cutoff, 12);
});

test('win: a write error freezes the flushed cutoff at the first failure and marks degraded', async () => {
  const runner: any = new WindowsRunner();
  runner._logPath = null;
  const fake = new FakeStream();
  fake.failAt = new Set([1]);   // ONLY the 2nd write fails; the 3rd SUCCEEDS
  runner.logStream = fake;
  runner._resetLogEpoch();      // base 0 (no _logPath)

  feed(runner, 'aaaa');         // idx 0 → success, flushed → 4
  feed(runner, 'bbbb');         // idx 1 → FAIL → degraded, flushed frozen at 4
  feed(runner, 'cccc');         // idx 2 → SUCCEEDS, but epoch already degraded → NO advance

  const { cutoff, degraded } = await runner.logWriteBarrier();
  assert.equal(degraded, true, 'epoch permanently degraded after the failed write');
  assert.equal(runner.logOffsetsReliable, false);
  assert.equal(cutoff, 4, 'flushed cutoff frozen at the first failed write, never re-advanced');
  // The logical cursor kept counting all bytes; the cutoff must never exceed
  // what actually reached disk.
  assert.equal(runner.currentLogOffset, 12, 'logical cursor still counts every byte');
  assert.ok(cutoff <= fake.buffer.length, 'cutoff never exceeds bytes actually written');
});

test('win: getRingSnapshot captures ring text + the current logical cursor atomically', async () => {
  const dir = freshDir();
  const runner: any = new WindowsRunner();
  attachRealStream(runner, dir);
  feed(runner, 'line one\n');
  feed(runner, 'line two');
  const snap = runner.getRingSnapshot();
  assert.equal(snap.logicalCutoff, runner.currentLogOffset);
  assert.ok(snap.text.includes('line one'));
  assert.ok(snap.text.includes('line two'));
});

// ── epoch reset (reused-instance reconnect contract) ──────────────────

test('win: _resetLogEpoch mints a new epoch + resets offsets + emits epochChanged', async () => {
  const dir = freshDir();
  const runner: any = new WindowsRunner();
  const epochs: string[] = [];
  runner.on('epochChanged', (e: string) => epochs.push(e));
  const p = attachRealStream(runner, dir);      // reset #1
  const first = runner.terminalEpoch;
  feed(runner, '12345');
  assert.equal(runner.currentLogOffset, 5);
  await runner.logWriteBarrier();               // ensure the 5 bytes are on disk

  // Simulate the file having grown (a reconnect reopens the SAME append file).
  fs.appendFileSync(p, 'XXXXXXX');              // +7 bytes on disk
  runner._resetLogEpoch();                       // reset #2 (reconnect)
  const second = runner.terminalEpoch;

  assert.notEqual(first, second, 'reconnect mints a fresh epoch');
  assert.equal(epochs.length, 2, 'epochChanged emitted on every reset');
  assert.deepEqual(epochs, [first, second]);
  assert.equal(runner.currentLogOffset, 12, 'base reset to the new append size (5 fed + 7 appended)');
  assert.equal(runner.logOffsetsReliable, true, 'a fresh epoch is not degraded');
});

// ── WslRunner (mirrors the Windows instrumentation) ───────────────────

test('wsl: offset == cumulative UTF-8 byte length and is emitted', async () => {
  const dir = freshDir();
  const runner: any = new WslRunner('sess-a', { now: () => 0 });
  attachRealStream(runner, dir, 'wsl.log');
  const emitted: number[] = [];
  runner.on('data', (_d: string, off: number) => emitted.push(off));

  feed(runner, 'ab');    // 2
  feed(runner, '☃');     // 3 (E2 98 83)
  assert.equal(runner.currentLogOffset, 5);
  assert.deepEqual(emitted, [2, 5]);
  const { cutoff, degraded } = await runner.logWriteBarrier();
  assert.equal(degraded, false);
  assert.equal(cutoff, 5);
});

test('wsl: write error freezes cutoff at first failure + marks degraded', async () => {
  const runner: any = new WslRunner('sess-b', { now: () => 0 });
  runner._logPath = null;
  const fake = new FakeStream();
  fake.failAt = new Set([1]);   // only the middle write fails; the last succeeds
  runner.logStream = fake;
  runner._resetLogEpoch();

  feed(runner, 'oooo');  // ok → flushed 4
  feed(runner, 'pppp');  // fail → degraded
  feed(runner, 'qqqq');  // SUCCEEDS but degraded → no advance
  const { cutoff, degraded } = await runner.logWriteBarrier();
  assert.equal(degraded, true);
  assert.equal(cutoff, 4);
  assert.equal(runner.logOffsetsReliable, false);
});

test('wsl: _resetLogEpoch resets offsets + emits epochChanged (reconnect on one instance)', async () => {
  const dir = freshDir();
  const runner: any = new WslRunner('sess-c', { now: () => 0 });
  const epochs: string[] = [];
  runner.on('epochChanged', (e: string) => epochs.push(e));
  const p = attachRealStream(runner, dir, 'wsl.log');
  const first = runner.terminalEpoch;
  feed(runner, 'hello');
  await runner.logWriteBarrier();               // flush the 5 bytes before appending
  fs.appendFileSync(p, '!!');
  runner._resetLogEpoch();
  assert.notEqual(first, runner.terminalEpoch);
  assert.equal(epochs.length, 2);
  assert.equal(runner.currentLogOffset, 7, 'base = 5 fed + 2 appended');
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
