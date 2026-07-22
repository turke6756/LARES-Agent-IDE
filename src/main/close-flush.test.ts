// Close-flush handshake state machine (edit-loss plan §4.3) — exercised
// without an Electron runtime via the injected target/dialog seams (mirrors
// detached-windows.test.ts).
//
// Covers:
//   - all saved/pristine ⇒ proceed, no dialog;
//   - error ⇒ dialog WITHOUT "Overwrite anyway"; "Keep waiting" sends
//     action:'retry' targeting exactly the error/timeout tabs;
//   - conflict ⇒ dialog WITH "Overwrite anyway"; choosing it sends
//     action:'force' targeting ONLY the conflict tabs;
//   - residual failures after a retry round RETURN to the dialog — never a
//     silent close; "Discard and close" proceeds; "Cancel" aborts;
//   - a window that never replies surfaces as a whole-window timeout row and
//     is re-asked without fabricated tabIds.
//
//   npm run build:main
//   node dist/main/main/close-flush.test.js

import assert from 'node:assert/strict';
import {
  runCloseFlush,
  handleFlushReply,
  __resetCloseFlushForTest,
  type CloseFlushDialogOptions,
  type FlushTarget,
} from './close-flush';
import type { FlushRequestPayload, FlushResult } from '../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── Scripted target ─────────────────────────────────────────────────────
// Replies synchronously through handleFlushReply per a script of rounds;
// `null` for a round = never reply (whole-window timeout).

interface ScriptedTarget extends FlushTarget {
  requests: FlushRequestPayload[];
}

function makeTarget(
  id: string,
  label: string,
  script: Array<((req: FlushRequestPayload) => FlushResult[]) | null>,
): ScriptedTarget {
  const requests: FlushRequestPayload[] = [];
  let round = 0;
  return {
    id,
    label,
    requests,
    isAlive: () => true,
    send(req: FlushRequestPayload) {
      requests.push(req);
      const step = script[Math.min(round, script.length - 1)];
      round += 1;
      if (step === null) return; // never replies — main times the window out
      handleFlushReply({ requestId: req.requestId, results: step(req) });
    },
  };
}

// ── Scripted dialog ─────────────────────────────────────────────────────

function makeDialog(choices: string[]) {
  const seen: CloseFlushDialogOptions[] = [];
  let i = 0;
  return {
    seen,
    showDialog: async (opts: CloseFlushDialogOptions): Promise<number> => {
      seen.push(opts);
      const want = choices[Math.min(i, choices.length - 1)];
      i += 1;
      const idx = opts.buttons.indexOf(want);
      assert.notEqual(idx, -1, `dialog is missing the scripted button "${want}" (has: ${opts.buttons.join(', ')})`);
      return idx;
    },
  };
}

const row = (tabId: string, outcome: FlushResult['outcome'], error?: string): FlushResult => ({
  tabId,
  fileName: `${tabId}.md`,
  outcome,
  ...(error !== undefined ? { error } : {}),
});

// ── Tests ───────────────────────────────────────────────────────────────

test('all saved/pristine ⇒ proceed without a dialog', async () => {
  const main = makeTarget('main', 'Main window', [
    () => [row('t1', 'saved'), row('t2', 'pristine')],
  ]);
  const detached = makeTarget('d1', 'notes.md', [() => [row('t3', 'saved')]]);
  const dialog = makeDialog([]);

  const proceed = await runCloseFlush({
    targets: () => [main, detached],
    showDialog: dialog.showDialog,
    deadlineMs: 50,
    replyMarginMs: 10,
  });

  assert.equal(proceed, true);
  assert.equal(dialog.seen.length, 0);
  assert.equal(main.requests[0].action, 'flush');
  assert.equal(detached.requests[0].action, 'flush');
});

test("error ⇒ dialog without Overwrite; Keep waiting retries exactly the error/timeout tabs", async () => {
  const main = makeTarget('main', 'Main window', [
    () => [row('ok', 'saved'), row('bad', 'error', 'disk on fire')],
    (req) => {
      // Second round must be a targeted retry of ONLY the failed tab.
      assert.equal(req.action, 'retry');
      assert.deepEqual(req.tabIds, ['bad']);
      return [row('bad', 'saved')];
    },
  ]);
  const dialog = makeDialog(['Keep waiting']);

  const proceed = await runCloseFlush({
    targets: () => [main],
    showDialog: dialog.showDialog,
    deadlineMs: 50,
    replyMarginMs: 10,
  });

  assert.equal(proceed, true);
  assert.equal(dialog.seen.length, 1);
  assert.ok(!dialog.seen[0].buttons.includes('Overwrite anyway'), 'no conflicts ⇒ no Overwrite button');
  assert.match(dialog.seen[0].detail, /bad\.md — error: disk on fire/);
  assert.equal(main.requests.length, 2);
});

test("conflict ⇒ Overwrite anyway forces ONLY the conflict tabs", async () => {
  const main = makeTarget('main', 'Main window', [
    () => [row('c1', 'conflict'), row('e1', 'error', 'io')],
    (req) => {
      assert.equal(req.action, 'force');
      assert.deepEqual(req.tabIds, ['c1']); // the error tab is NOT forced
      return [row('c1', 'saved')];
    },
    (req) => {
      // The error tab survived the force round ⇒ the dialog returned; the
      // user then chose Keep waiting ⇒ retry targets it.
      assert.equal(req.action, 'retry');
      assert.deepEqual(req.tabIds, ['e1']);
      return [row('e1', 'saved')];
    },
  ]);
  const dialog = makeDialog(['Overwrite anyway', 'Keep waiting']);

  const proceed = await runCloseFlush({
    targets: () => [main],
    showDialog: dialog.showDialog,
    deadlineMs: 50,
    replyMarginMs: 10,
  });

  assert.equal(proceed, true);
  assert.equal(dialog.seen.length, 2, 'residual failure returned to the dialog');
  assert.ok(dialog.seen[0].buttons.includes('Overwrite anyway'));
  assert.ok(!dialog.seen[1].buttons.includes('Overwrite anyway'), 'no conflicts left in round 2');
  assert.equal(main.requests.length, 3);
});

test('Discard and close ⇒ proceed despite failures', async () => {
  const main = makeTarget('main', 'Main window', [
    () => [row('bad', 'error', 'nope')],
  ]);
  const dialog = makeDialog(['Discard and close']);

  const proceed = await runCloseFlush({
    targets: () => [main],
    showDialog: dialog.showDialog,
    deadlineMs: 50,
    replyMarginMs: 10,
  });

  assert.equal(proceed, true);
  assert.equal(main.requests.length, 1, 'discard runs no further rounds');
});

test('Cancel ⇒ abort the close', async () => {
  const main = makeTarget('main', 'Main window', [
    () => [row('bad', 'timeout')],
  ]);
  const dialog = makeDialog(['Cancel']);

  const proceed = await runCloseFlush({
    targets: () => [main],
    showDialog: dialog.showDialog,
    deadlineMs: 50,
    replyMarginMs: 10,
  });

  assert.equal(proceed, false);
});

test('a window that never replies ⇒ whole-window timeout row; re-ask carries no fabricated tabIds', async () => {
  const silent = makeTarget('d9', 'stuck.md', [
    null, // never replies in round 1
    (req) => {
      assert.equal(req.action, 'retry');
      assert.equal(req.tabIds, undefined, 'whole-window re-ask, not a synthetic tab id');
      return [row('t9', 'saved')];
    },
  ]);
  const dialog = makeDialog(['Keep waiting']);

  const proceed = await runCloseFlush({
    targets: () => [silent],
    showDialog: dialog.showDialog,
    deadlineMs: 20,
    replyMarginMs: 10,
  });

  assert.equal(proceed, true);
  assert.equal(dialog.seen.length, 1);
  assert.match(dialog.seen[0].detail, /stuck\.md — timeout/);
});

// ── Runner (mirrors detached-windows.test.ts) ───────────────────────────

async function main(): Promise<void> {
  let failed = 0;
  for (const t of tests) {
    __resetCloseFlushForTest();
    try {
      await t.run();
      console.log(`  ok - ${t.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL - ${t.name}`);
      console.error(err);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed}/${tests.length} close-flush tests failed`);
    process.exit(1);
  }
  console.log(`\nclose-flush: ${tests.length} tests passed`);
}

void main();
