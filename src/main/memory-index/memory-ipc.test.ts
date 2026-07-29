// memory-ipc.test.ts — WP-H1 review READ IPC boundary.
//
// Covers:
//   - registerMemoryReviewIpc wires the `memory:listReview` channel and its
//     handler projects WP-B pending findings + WP-C index state into the DTO
//     (pendingCount / capPressure / capPercent / hardInvalid / runtime state);
//   - a blank / non-string workspace id yields the empty summary (never a throw)
//     and never calls the store;
//   - capPercent is computed from the persisted last-good source (max of the
//     byte/line ratios), and is null when no source is persisted or the JSON is
//     unusable;
//   - the channel constant is exactly `memory:listReview`.
//
//   npm run build:main
//   node dist/main/main/memory-index/memory-ipc.test.js

import assert from 'node:assert/strict';
import {
  MEMORY_REVIEW_CHANNELS,
  buildReviewSummary,
  registerMemoryReviewIpc,
  summarizeReview,
  type IpcLike,
  type MemoryReviewIpcDeps,
} from './memory-ipc';
import { MEMORY_INDEX_BUDGET_BYTES, MEMORY_INDEX_BUDGET_LINES } from '../../shared/memory-index-core';
import type { IndexStateRow, ReviewFindingRow } from './review-store';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── fixtures ───────────────────────────────────────────────────────────────
function finding(over: Partial<ReviewFindingRow> & { kind: string }): ReviewFindingRow {
  return {
    findingId: `f-${over.kind}-${over.entryId ?? 'x'}`,
    workspaceId: 'ws-1',
    entryId: over.entryId ?? null,
    sourceHash: 'h',
    reason: over.reason ?? `${over.kind} reason`,
    exitCondition: over.exitCondition ?? null,
    status: 'pending',
    firstSeen: over.firstSeen ?? '2026-07-01T00:00:00Z',
    lastSeen: over.lastSeen ?? '2026-07-28T00:00:00Z',
    ...over,
  };
}

function indexState(over: Partial<IndexStateRow> = {}): IndexStateRow {
  return {
    workspaceId: 'ws-1',
    sourceText: '<!-- disclosure-format: v2 -->',
    sourceHash: 'h',
    parsedJson: JSON.stringify({ raw: '', byteLength: 0, lineCount: 0, entries: [] }),
    validatedAt: '2026-07-28T00:00:00Z',
    lastRuntimeError: null,
    lastRuntimeErrorAt: null,
    ...over,
  };
}

/** A recording fake store: captures every call so we can assert the handler
 *  short-circuits a bad workspace id without touching the store. */
function makeDeps(over: {
  pending?: ReviewFindingRow[];
  state?: IndexStateRow | null;
}): { deps: MemoryReviewIpcDeps; listCalls: Array<[string, string | undefined]>; stateCalls: string[] } {
  const listCalls: Array<[string, string | undefined]> = [];
  const stateCalls: string[] = [];
  return {
    listCalls,
    stateCalls,
    deps: {
      listFindings(ws, status) { listCalls.push([ws, status]); return over.pending ?? []; },
      getIndexState(ws) { stateCalls.push(ws); return over.state ?? null; },
    },
  };
}

function makeIpc(): { ipc: IpcLike; handlers: Map<string, (e: unknown, ...a: unknown[]) => unknown> } {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  return { handlers, ipc: { handle(ch, l) { handlers.set(ch, l); } } };
}

// ── tests ──────────────────────────────────────────────────────────────────
test('channel constant is exactly memory:listReview', () => {
  assert.equal(MEMORY_REVIEW_CHANNELS.listReview, 'memory:listReview');
});

test('registerMemoryReviewIpc registers the read channel', () => {
  const { ipc, handlers } = makeIpc();
  const { deps } = makeDeps({});
  registerMemoryReviewIpc(ipc, deps);
  assert.ok(handlers.has('memory:listReview'), 'channel handler registered');
  assert.equal(handlers.size, 1, 'exactly one channel — WP-H1 owns only the read');
});

test('handler projects pending findings + index state into the summary', () => {
  const { ipc, handlers } = makeIpc();
  const pending = [
    finding({ kind: 'hard-invalid' }),
    finding({ kind: 'cap-pressure' }),
    finding({ kind: 'condition-review', entryId: 'mb-2026-07-01-x', exitCondition: 'pi-integration lands' }),
  ];
  const state = indexState({
    parsedJson: JSON.stringify({ raw: '', byteLength: MEMORY_INDEX_BUDGET_BYTES, lineCount: 0, entries: [] }),
    lastRuntimeError: 'boom',
    lastRuntimeErrorAt: '2026-07-28T01:00:00Z',
  });
  const { deps } = makeDeps({ pending, state });
  registerMemoryReviewIpc(ipc, deps);

  const out = handlers.get('memory:listReview')!(null, 'ws-1') as ReturnType<typeof summarizeReview>;
  assert.equal(out.pendingCount, 3);
  assert.equal(out.capPressure, true);
  assert.equal(out.hardInvalid, true);
  assert.equal(out.capPercent, 100, 'byteLength === budget → 100%');
  assert.equal(out.lastRuntimeError, 'boom');
  assert.equal(out.lastRuntimeErrorAt, '2026-07-28T01:00:00Z');
  assert.equal(out.items.length, 3);
  const cond = out.items.find((i) => i.kind === 'condition-review')!;
  assert.equal(cond.exitCondition, 'pi-integration lands');
  assert.equal(cond.entryId, 'mb-2026-07-01-x');
});

test('a clean workspace (no findings, valid small source) summarizes to a quiet surface', () => {
  const { ipc, handlers } = makeIpc();
  const state = indexState({
    parsedJson: JSON.stringify({ raw: '', byteLength: 100, lineCount: 5, entries: [] }),
  });
  const { deps } = makeDeps({ pending: [], state });
  registerMemoryReviewIpc(ipc, deps);
  const out = handlers.get('memory:listReview')!(null, 'ws-1') as ReturnType<typeof summarizeReview>;
  assert.equal(out.pendingCount, 0);
  assert.equal(out.capPressure, false);
  assert.equal(out.hardInvalid, false);
  assert.equal(out.lastRuntimeError, null);
  assert.equal(out.items.length, 0);
  // 100/25000 ≈ 0.4% vs 5/200 = 2.5% → max → 3 (rounded).
  assert.equal(out.capPercent, 3);
});

test('capPercent takes the LARGER of the byte/line ratios', () => {
  // lines dominate: 180/200 = 90% > 100/25000 ≈ 0.4%.
  const state = indexState({
    parsedJson: JSON.stringify({ raw: '', byteLength: 100, lineCount: 180, entries: [] }),
  });
  const out = summarizeReview([], state);
  assert.equal(out.capPercent, 90);
});

test('capPercent is null with no persisted source and with unusable JSON', () => {
  assert.equal(summarizeReview([], null).capPercent, null);
  assert.equal(summarizeReview([], indexState({ parsedJson: null })).capPercent, null);
  assert.equal(summarizeReview([], indexState({ parsedJson: 'not json{' })).capPercent, null);
});

test('blank / non-string workspace id → empty summary, store untouched', () => {
  for (const bad of ['', null, undefined, 42, {}]) {
    const { deps, listCalls, stateCalls } = makeDeps({ pending: [finding({ kind: 'cap-pressure' })], state: indexState() });
    const out = buildReviewSummary(deps, bad as unknown);
    assert.equal(out.pendingCount, 0, `empty for ${String(bad)}`);
    assert.equal(out.capPressure, false);
    assert.equal(out.capPercent, null);
    assert.equal(out.items.length, 0);
    assert.equal(listCalls.length, 0, 'store.listFindings never called on bad id');
    assert.equal(stateCalls.length, 0, 'store.getIndexState never called on bad id');
  }
});

test('handler requests the PENDING status only', () => {
  const { ipc, handlers } = makeIpc();
  const { deps, listCalls } = makeDeps({ pending: [], state: null });
  registerMemoryReviewIpc(ipc, deps);
  handlers.get('memory:listReview')!(null, 'ws-1');
  assert.deepEqual(listCalls, [['ws-1', 'pending']]);
});

// ── runner ───────────────────────────────────────────────────────────────
let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); }
  catch (e) { failed++; console.error(`FAIL  ${t.name}\n`, e); }
}
if (failed > 0) { console.error(`\n${failed} failed`); process.exit(1); }
console.log(`\nmemory-ipc.test: ${tests.length} passed`);
