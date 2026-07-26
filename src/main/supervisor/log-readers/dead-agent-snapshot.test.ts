// Unit tests for the WP-3c dead-agent snapshot reader (dead-agent-snapshot.ts).
//
//   npm run build:main
//   node dist/main/main/supervisor/log-readers/dead-agent-snapshot.test.js
//
// Covers the two sources (bounded `.scrollback` preferred, raw `.log` tail
// fallback) and the conservative truncation rule:
//   - `.scrollback` present, `.log` LARGER  → truncated (ring dropped history)
//   - `.scrollback` present, `.log` EQUAL    → NOT truncated (ring is complete)
//   - no `.scrollback`, `.log` under budget  → tail, NOT truncated
//   - no `.scrollback`, `.log` over budget   → tail, truncated
//   - neither file exists                     → empty, NOT truncated

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert/strict';

import { readDeadAgentSnapshot } from './dead-agent-snapshot';

const BUDGET = 1_000_000;

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dead-snap-'));
}
function writeBuf(dir: string, name: string, buf: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

test('.scrollback present and SMALLER than .log → truncated, replays scrollback text', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'a.log');
  fs.writeFileSync(logPath, Buffer.from('X'.repeat(5000)));           // large raw log
  fs.writeFileSync(`${logPath}.scrollback`, Buffer.from('tail-lines')); // bounded ring

  const snap = await readDeadAgentSnapshot(logPath, BUDGET);
  assert.equal(snap.text, 'tail-lines', 'replays the bounded scrollback, not the raw log');
  assert.equal(snap.truncated, true, 'log larger than scrollback ⇒ earlier history dropped');
  assert.equal(snap.retainedBytes, 10);
});

test('.scrollback present and EQUAL to .log size → NOT truncated', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'b.log');
  const body = Buffer.from('complete-history');
  fs.writeFileSync(logPath, body);
  fs.writeFileSync(`${logPath}.scrollback`, body); // same size ⇒ ring holds everything

  const snap = await readDeadAgentSnapshot(logPath, BUDGET);
  assert.equal(snap.text, 'complete-history');
  assert.equal(snap.truncated, false, 'scrollback covers the whole log ⇒ complete');
  assert.equal(snap.retainedBytes, body.length);
});

test('.scrollback present but .log MISSING (size 0) → NOT truncated', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'c.log'); // no raw log written
  fs.writeFileSync(`${logPath}.scrollback`, Buffer.from('ring-only'));

  const snap = await readDeadAgentSnapshot(logPath, BUDGET);
  assert.equal(snap.text, 'ring-only');
  assert.equal(snap.truncated, false, 'absent log (size 0) is not "larger than" the ring');
});

test('no .scrollback, .log UNDER budget → cold tail, NOT truncated', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'd.log');
  fs.writeFileSync(logPath, Buffer.from('raw-log-body'));

  const snap = await readDeadAgentSnapshot(logPath, BUDGET);
  assert.equal(snap.text, 'raw-log-body');
  assert.equal(snap.truncated, false);
  assert.equal(snap.retainedBytes, 'raw-log-body'.length);
});

test('no .scrollback, .log OVER budget → cold tail, truncated + retained==budget-ish', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'e.log');
  fs.writeFileSync(logPath, Buffer.from('Y'.repeat(500)));

  const snap = await readDeadAgentSnapshot(logPath, 100); // tiny budget forces truncation
  assert.equal(snap.truncated, true, 'log exceeds the tail budget');
  assert.equal(snap.text.length, 100, 'retained exactly the budget (ASCII, no rune realign)');
  assert.equal(snap.retainedBytes, 100);
});

test('neither file exists → empty, NOT truncated', async () => {
  const dir = freshDir();
  const snap = await readDeadAgentSnapshot(path.join(dir, 'gone.log'), BUDGET);
  assert.equal(snap.text, '');
  assert.equal(snap.truncated, false);
  assert.equal(snap.retainedBytes, 0);
});

test('.scrollback itself larger than budget → truncated (defensive cap)', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'f.log');
  fs.writeFileSync(logPath, Buffer.from('Z'.repeat(300)));
  fs.writeFileSync(`${logPath}.scrollback`, Buffer.from('Z'.repeat(300))); // equal to log, but > budget

  const snap = await readDeadAgentSnapshot(logPath, 100);
  assert.equal(snap.truncated, true, 'scrollback tail hit its byte cap ⇒ truncated');
  assert.equal(snap.retainedBytes, 100);
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
