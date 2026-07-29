// WP-6 — reader/IPC structured reclaimed-history metadata.
//
//   npm run build:main
//   node dist/main/main/supervisor/log-readers/terminal-history-notice.test.js
//
// Exercises the WP-6 seams that carry the reclaimed-history disclosure onto the
// reader DTOs, and the `missing` history-unavailable signal. Covers the exact
// mutations the plan lists to kill:
//   - deriving reclaimed state from ENOENT instead of the DB marker
//   - `missing` inferred from `snapshotCutoff === 0` / an empty read
//   - fetching the marker BEFORE the bounded read
//   - dropping the notice on a range read that races a deletion
//   - reintroducing epoch-ms / Date.parse conversion (⇒ NaN)

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert/strict';

import { historyNoticeFromMarker, readWithHistoryNotice } from './history-notice';
import { readDeadAgentSnapshot } from './dead-agent-snapshot';
import { readFileRange, readFileTail, readLastLines } from './tail-file';
import { computeTerminalAttachResult, type AttachResultSupervisor } from '../../terminal-attach-result';

const BUDGET = 1_000_000;
const ISO = '2026-07-27T12:34:56.789Z';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hist-notice-'));
}

/** Attach-result fake: `notice` supplies the DB marker; `live` toggles the
 *  runner branch; `logSize` feeds the dead-path cutoff. */
function fakeAttachSupervisor(opts: {
  live?: boolean;
  epoch?: string;
  cutoff?: number;
  logSize?: number;
  notice?: string;
}): AttachResultSupervisor {
  const marker = opts.notice;
  return {
    hasRunner: () => opts.live === true,
    agentLogWriteBarrier: async () => ({ cutoff: opts.cutoff ?? 0, degraded: false }),
    agentEpoch: () => opts.epoch ?? null,
    agentLogSize: async () => opts.logSize ?? 0,
    lastTerminalEpoch: new Map(opts.epoch ? [['a', opts.epoch]] : []),
    agentTerminalHistoryNotice: () => historyNoticeFromMarker(marker),
  };
}

// ── historyNoticeFromMarker: the ONE reclaimed-state authority ──────────────

test('marker = non-empty ISO string → notice carries it VERBATIM (no conversion)', () => {
  const n = historyNoticeFromMarker(ISO);
  assert.deepEqual(n, { kind: 'retention-reclaimed', reclaimedAt: ISO });
  assert.equal(typeof (n as any).reclaimedAt, 'string', 'reclaimedAt stays a string, never a parsed number');
});

test('corrupt/empty-string marker → null (never NaN)', () => {
  assert.equal(historyNoticeFromMarker(''), null);
  assert.equal(historyNoticeFromMarker(null), null);
  assert.equal(historyNoticeFromMarker(undefined), null);
});

test('epoch-ms number marker → null (kills reintroduced Date.parse/epoch conversion)', () => {
  // A number is NOT a valid marker. If someone reintroduces epoch-ms handling
  // this would become a notice with reclaimedAt: NaN — assert it stays null.
  const n = historyNoticeFromMarker(1_764_249_296_789);
  assert.equal(n, null, 'a numeric marker is rejected, not converted');
});

// ── readWithHistoryNotice: fetch-AFTER-read ordering ────────────────────────

test('fetch-after-read: a marker written DURING the read is STILL attached', async () => {
  // Models the reclaim writing the marker (beforeFirstUnlink) while the bounded
  // read is in flight. A fetch-BEFORE-read implementation would see null here.
  let marker: string | null = null;
  const read = async () => { marker = ISO; return { bytes: new Uint8Array(0) }; };
  const res = await readWithHistoryNotice(read, () => historyNoticeFromMarker(marker));
  assert.deepEqual(res.historyNotice, { kind: 'retention-reclaimed', reclaimedAt: ISO },
    'the marker set during the read must be surfaced (fetch-after-read)');
});

test('racing range read: file deleted mid-read → EMPTY bytes PLUS the notice', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'race.log');
  fs.writeFileSync(logPath, Buffer.from('X'.repeat(200)));
  let marker: string | null = null;
  // The reclaim: write the marker, then unlink — exactly WP-3's order.
  const read = async () => {
    marker = ISO;
    fs.unlinkSync(logPath);
    const r = await readFileRange(logPath, 0, 100); // ENOENT-safe → empty
    return { bytes: new Uint8Array(r.bytes), startOffset: r.startOffset, endOffset: r.endOffset, fileSize: r.fileSize };
  };
  const res = await readWithHistoryNotice(read, () => historyNoticeFromMarker(marker));
  assert.equal(res.bytes.length, 0, 'a read racing the deletion returns empty bytes');
  assert.ok(res.historyNotice, 'the notice is NOT dropped on a racing range read');
  assert.equal(res.historyNotice!.reclaimedAt, ISO);
});

test('present file + set marker → real bytes AND the notice (marker not derived from files)', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'present.log');
  fs.writeFileSync(logPath, Buffer.from('HELLO'));
  const read = async () => {
    const r = await readFileTail(logPath, BUDGET);
    return { bytes: new Uint8Array(r.bytes), truncated: r.truncated };
  };
  const res = await readWithHistoryNotice(read, () => historyNoticeFromMarker(ISO));
  assert.equal(Buffer.from(res.bytes).toString('utf8'), 'HELLO', 'bytes present even though the marker is set');
  assert.ok(res.historyNotice, 'the marker drives the notice, NOT the presence/absence of the file');
});

test('present file + NO marker → null notice (reclaimed state never derived from ENOENT)', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'clean.log');
  // Absent file + no marker: absence alone must NOT synthesize a notice.
  const read = async () => {
    const r = await readFileRange(logPath, 0, 100);
    return { bytes: new Uint8Array(r.bytes) };
  };
  const res = await readWithHistoryNotice(read, () => historyNoticeFromMarker(undefined));
  assert.equal(res.bytes.length, 0);
  assert.equal(res.historyNotice, null, 'an absent file with no marker is NOT reclaimed');
});

// ── attach: notice for BOTH live and dead agents ────────────────────────────

test('DEAD attach + marker → notice present, snapshotCutoff preserved', async () => {
  const sup = fakeAttachSupervisor({ live: false, logSize: 4096, epoch: 'ep-old', notice: ISO });
  const res = await computeTerminalAttachResult(sup, 'a');
  assert.equal(res.live, false);
  assert.equal(res.snapshotCutoff, 4096, 'the fstat cutoff is unaffected by the notice');
  assert.deepEqual(res.historyNotice, { kind: 'retention-reclaimed', reclaimedAt: ISO });
});

test('REVIVED (live runner + marker + growing log) → notice present AND live/cutoff preserved', async () => {
  const sup = fakeAttachSupervisor({ live: true, cutoff: 512, epoch: 'ep-new', notice: ISO });
  const res = await computeTerminalAttachResult(sup, 'a');
  assert.equal(res.live, true, 'a revived agent is live');
  assert.equal(res.snapshotCutoff, 512, 'the live barrier cutoff is preserved');
  assert.equal(res.terminalEpoch, 'ep-new');
  assert.deepEqual(res.historyNotice, { kind: 'retention-reclaimed', reclaimedAt: ISO },
    'the surviving marker still discloses on a revived agent');
});

test('attach with NO marker → historyNotice null (not derived from a size-0 log)', async () => {
  const sup = fakeAttachSupervisor({ live: false, logSize: 0 });
  const res = await computeTerminalAttachResult(sup, 'a');
  assert.equal(res.snapshotCutoff, 0);
  assert.equal(res.historyNotice, null, 'a size-0 log is not a reclaimed marker');
});

// ── dead snapshot: `missing` iff BOTH fallback files absent ──────────────────

test('BOTH .scrollback and .log absent → missing:true', async () => {
  const dir = freshDir();
  const snap = await readDeadAgentSnapshot(path.join(dir, 'gone.log'), BUDGET);
  assert.equal(snap.missing, true, 'both fallback files absent ⇒ history unavailable');
  assert.equal(snap.text, '');
});

test('empty-but-PRESENT .log (size 0), no .scrollback → missing:false (NOT inferred from size 0)', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'empty.log');
  fs.writeFileSync(logPath, Buffer.alloc(0)); // present, size 0
  const snap = await readDeadAgentSnapshot(logPath, BUDGET);
  assert.equal(snap.retainedBytes, 0, 'an empty log retains 0 bytes');
  assert.equal(snap.missing, false, 'size 0 but PRESENT ⇒ missing:false (never inferred from retainedBytes)');
});

test('.scrollback present, .log absent → missing:false (the ring is history)', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'ringonly.log');
  fs.writeFileSync(`${logPath}.scrollback`, Buffer.from('ring-only'));
  const snap = await readDeadAgentSnapshot(logPath, BUDGET);
  assert.equal(snap.missing, false, 'a present scrollback means history is available');
});

test('.log present with content, no .scrollback → missing:false', async () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'full.log');
  fs.writeFileSync(logPath, Buffer.from('raw-log-body'));
  const snap = await readDeadAgentSnapshot(logPath, BUDGET);
  assert.equal(snap.missing, false);
});

// ── string readers: reclaimed history yields '' (never synthesized text) ─────

test('string-reader disk primitives return empty for reclaimed (absent) files', async () => {
  const dir = freshDir();
  const gone = path.join(dir, 'reclaimed.log');
  // getAgentRingBuffer's cold-tail primitive and getAgentLog's line reader both
  // resolve to empty on a reclaimed (unlinked) file — they never synthesize a
  // banner; disclosure is DTO-only.
  const tail = await readFileTail(gone, BUDGET);
  assert.equal(Buffer.from(tail.bytes).toString('utf8'), '', 'ring-buffer tail → "" on ENOENT');
  assert.equal(await readLastLines(gone, 50), '', 'getAgentLog line reader → "" on ENOENT');
});

// ── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
