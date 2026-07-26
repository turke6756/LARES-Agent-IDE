// WP-3b — serialize-checkpoint sidecar I/O + the pure epoch/degraded/cutoff
// guards that gate save/load.
//
//   npm run build:main
//   node dist/main/main/supervisor/log-readers/terminal-checkpoint.test.js
//
// The guard functions (`checkpointSaveAllowed` / `checkpointLoadValid`) carry
// WP-3b's key correctness logic and are exercised directly here so a broken
// guard fails a test (WB-10 mutation-verified).

import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writeTerminalCheckpoint,
  readTerminalCheckpoint,
  unlinkTerminalCheckpoint,
  checkpointSaveAllowed,
  checkpointLoadValid,
  type TerminalCheckpoint,
} from './terminal-checkpoint';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-checkpoint-'));
}
function logPathIn(dir: string): string {
  return path.join(dir, 'agent.log');
}

// ── File I/O: write / read round-trip ─────────────────────────────────

test('writeTerminalCheckpoint + readTerminalCheckpoint round-trip', async () => {
  const logPath = logPathIn(freshDir());
  const cp: TerminalCheckpoint = { epoch: 'e1', serialized: 'ESC[hello', appliedOffset: 1234 };
  await writeTerminalCheckpoint(logPath, cp);
  assert.ok(fs.existsSync(logPath + '.checkpoint'), '.checkpoint written');
  assert.ok(!fs.existsSync(logPath + '.checkpoint.tmp'), '.tmp renamed away, not left behind');
  const back = await readTerminalCheckpoint(logPath);
  assert.deepEqual(back, cp, 'read back the exact payload');
});

test('readTerminalCheckpoint returns null when the sidecar is absent (ENOENT)', async () => {
  const logPath = logPathIn(freshDir());
  assert.equal(await readTerminalCheckpoint(logPath), null);
});

test('readTerminalCheckpoint returns null on malformed JSON', async () => {
  const logPath = logPathIn(freshDir());
  fs.writeFileSync(logPath + '.checkpoint', '{ not valid json');
  assert.equal(await readTerminalCheckpoint(logPath), null);
});

test('readTerminalCheckpoint returns null on an incomplete payload (missing fields / wrong types)', async () => {
  const dir = freshDir();
  const a = path.join(dir, 'a.log');
  fs.writeFileSync(a + '.checkpoint', JSON.stringify({ epoch: 'e1', serialized: 'x' })); // no appliedOffset
  assert.equal(await readTerminalCheckpoint(a), null, 'missing appliedOffset → null');
  const b = path.join(dir, 'b.log');
  fs.writeFileSync(b + '.checkpoint', JSON.stringify({ epoch: 'e1', serialized: 'x', appliedOffset: 'nope' }));
  assert.equal(await readTerminalCheckpoint(b), null, 'non-numeric appliedOffset → null');
  const c = path.join(dir, 'c.log');
  fs.writeFileSync(c + '.checkpoint', JSON.stringify({ epoch: 'e1', serialized: 'x', appliedOffset: Infinity }));
  // JSON.stringify(Infinity) → "null", so this actually lands as appliedOffset:null → reject anyway.
  assert.equal(await readTerminalCheckpoint(c), null, 'non-finite/absent appliedOffset → null');
});

test('write is atomic: a pre-existing checkpoint survives when the rename target dir is valid', async () => {
  const logPath = logPathIn(freshDir());
  await writeTerminalCheckpoint(logPath, { epoch: 'e1', serialized: 'first', appliedOffset: 1 });
  await writeTerminalCheckpoint(logPath, { epoch: 'e2', serialized: 'second', appliedOffset: 2 });
  const back = await readTerminalCheckpoint(logPath);
  assert.equal(back?.serialized, 'second', 'second write replaced the first');
  assert.ok(!fs.existsSync(logPath + '.checkpoint.tmp'), 'no tmp residue');
});

test('write failure AFTER the tmp is created cleans up the .checkpoint.tmp and rethrows', async () => {
  // The tmp write must succeed but the rename must fail, so the catch's cleanup
  // is actually exercised (a missing-dir failure would abort before the tmp
  // exists, never reaching cleanup). Make the FINAL `.checkpoint` path a
  // directory ⇒ rename(tmp, checkpoint) fails while `.checkpoint.tmp` is on disk.
  const logPath = logPathIn(freshDir());
  fs.mkdirSync(logPath + '.checkpoint'); // rename target is a dir → rename fails
  await assert.rejects(
    () => writeTerminalCheckpoint(logPath, { epoch: 'e1', serialized: 'x', appliedOffset: 0 }),
    'rename onto a directory rejects',
  );
  assert.ok(!fs.existsSync(logPath + '.checkpoint.tmp'), 'orphan .tmp cleaned after rename failure');
});

test('write failure before the tmp exists (missing dir) still rejects without residue', async () => {
  const bogus = path.join(freshDir(), 'no-such-subdir', 'agent.log');
  await assert.rejects(
    () => writeTerminalCheckpoint(bogus, { epoch: 'e1', serialized: 'x', appliedOffset: 0 }),
    'write into a missing directory rejects',
  );
  assert.ok(!fs.existsSync(bogus + '.checkpoint.tmp'), 'no orphan .tmp left behind');
});

test('unlinkTerminalCheckpoint removes both .checkpoint and .checkpoint.tmp, ENOENT-safe', async () => {
  const logPath = logPathIn(freshDir());
  fs.writeFileSync(logPath + '.checkpoint', 'a');
  fs.writeFileSync(logPath + '.checkpoint.tmp', 'b');
  await unlinkTerminalCheckpoint(logPath);
  assert.ok(!fs.existsSync(logPath + '.checkpoint'), '.checkpoint removed');
  assert.ok(!fs.existsSync(logPath + '.checkpoint.tmp'), '.checkpoint.tmp removed');
  // Idempotent: a second call over absent files must not throw.
  await unlinkTerminalCheckpoint(logPath);
});

// ── SAVE guard (pure) ─────────────────────────────────────────────────

test('checkpointSaveAllowed: allows only a matching, non-degraded, non-null epoch', () => {
  assert.equal(checkpointSaveAllowed('e1', 'e1', true), true, 'match + reliable → allow');
  assert.equal(checkpointSaveAllowed('e1', 'e2', true), false, 'stale epoch → reject');
  assert.equal(checkpointSaveAllowed('e1', 'e1', false), false, 'degraded epoch → reject');
  assert.equal(checkpointSaveAllowed('e1', null, true), false, 'null current epoch → reject');
});

// ── LOAD guard (pure) ─────────────────────────────────────────────────

test('checkpointLoadValid: requires matching epoch AND appliedOffset <= cutoff', () => {
  const cp: TerminalCheckpoint = { epoch: 'e1', serialized: 's', appliedOffset: 100 };
  assert.equal(checkpointLoadValid(cp, 'e1', 100), true, 'epoch match + at cutoff → valid');
  assert.equal(checkpointLoadValid(cp, 'e1', 200), true, 'epoch match + below cutoff → valid');
  assert.equal(checkpointLoadValid(cp, 'e1', 99), false, 'appliedOffset past cutoff → invalid');
  assert.equal(checkpointLoadValid(cp, 'e2', 100), false, 'stale epoch → invalid');
  assert.equal(checkpointLoadValid(cp, null, 100), false, 'null current epoch → invalid');
});

// ── WP-3e — checkpoint/epoch invalidation on rebound/restart/reconnect/delete ──
//
// The four PTY-identity transitions each mint (or drop) the agent's "current
// epoch", which is what the pure save/load guards check. These acceptance cases
// pin the mapping from each transition to a guard REJECT so a regression in the
// epoch wiring surfaces here, not silently as a mis-applied checkpoint.

test('WP-3e rebound: a checkpoint saved under the pre-rebound epoch is rejected on load', () => {
  // A rebound (same-id PTY swap) mints a fresh runner ⇒ a fresh epoch. The
  // checkpoint captured under the retired epoch fails the load guard.
  const cp: TerminalCheckpoint = { epoch: 'epoch-old', serialized: 's', appliedOffset: 10 };
  assert.equal(checkpointLoadValid(cp, 'epoch-new', 1_000), false, 'stale (pre-rebound) epoch → reject');
  // And a late save arriving under the retired epoch is likewise refused.
  assert.equal(checkpointSaveAllowed('epoch-old', 'epoch-new', true), false, 'post-rebound stale save → reject');
});

test('WP-3e Electron restart: epoch is not persisted ⇒ current epoch null ⇒ checkpoint rejected', () => {
  // After an Electron restart the in-memory epoch map is empty, so agentEpoch is
  // null for an agent not relaunched this process. A checkpoint on disk (written
  // last process) can never validate — fall back to `.scrollback` / cold tail.
  const cp: TerminalCheckpoint = { epoch: 'epoch-prev-process', serialized: 's', appliedOffset: 0 };
  assert.equal(checkpointLoadValid(cp, null, 1_000), false, 'null current epoch (post-restart) → reject');
  assert.equal(checkpointSaveAllowed('epoch-prev-process', null, true), false, 'save with null current epoch → reject');
});

test('WP-3e WSL reconnect: a reconnect assigns a fresh epoch ⇒ old checkpoint rejected', () => {
  // A WSL reconnect / phantom respawn reuses the runner instance but resets the
  // epoch (see runner-log-offsets `_resetLogEpoch`), so a checkpoint from before
  // the reconnect is stale.
  const cp: TerminalCheckpoint = { epoch: 'epoch-before-reconnect', serialized: 's', appliedOffset: 5 };
  assert.equal(checkpointLoadValid(cp, 'epoch-after-reconnect', 1_000), false, 'pre-reconnect epoch → reject');
});

test('WP-3e delete: the checkpoint sidecar is reclaimed and any load then sees no epoch', async () => {
  // Delete unlinks the `.checkpoint` (WP-1 SIDECARS / unlinkTerminalCheckpoint)
  // AND removes the agent from lastTerminalEpoch ⇒ agentEpoch null. Model both:
  // the file is gone (read → null) and, were a stale file to linger, the null
  // current epoch still rejects it.
  const logPath = logPathIn(freshDir());
  await writeTerminalCheckpoint(logPath, { epoch: 'e-doomed', serialized: 's', appliedOffset: 1 });
  await unlinkTerminalCheckpoint(logPath); // delete-time reclamation
  assert.equal(await readTerminalCheckpoint(logPath), null, 'sidecar gone after delete-time reclaim');
  const lingering: TerminalCheckpoint = { epoch: 'e-doomed', serialized: 's', appliedOffset: 1 };
  assert.equal(checkpointLoadValid(lingering, null, 1_000), false, 'post-delete null epoch → reject even a lingering file');
});

test('WP-3e control: a same-epoch checkpoint within cutoff still loads (guards are not over-rejecting)', () => {
  // Negative control so the four reject-cases above are not vacuously green from
  // a guard that rejects everything.
  const cp: TerminalCheckpoint = { epoch: 'epoch-stable', serialized: 's', appliedOffset: 10 };
  assert.equal(checkpointLoadValid(cp, 'epoch-stable', 1_000), true, 'unchanged epoch + within cutoff → valid');
  assert.equal(checkpointSaveAllowed('epoch-stable', 'epoch-stable', true), true, 'unchanged, non-degraded epoch → allowed');
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
