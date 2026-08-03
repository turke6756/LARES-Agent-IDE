// WP-P0PRE — demand-probe append service.
//   npm run build:main
//   node dist/main/main/telemetry/demand-probe.test.js
//
// Covers the acceptance criteria: atomic single-line JSONL append under
// `.lares/usage/`, idempotent (non-duplicating) retry by eventId, rotation
// honored, the writer NEVER stamps a "voluntary" boolean, and an aggregation
// query reproduces the three head metrics (N/M/K) with the documented
// exclusions (feature_exercise events + test-harness events excluded).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import {
  recordDemandProbe,
  readDemandProbeEvents,
  aggregateDemand,
  demandProbeFilePath,
  isDemandProbeKind,
  DEMAND_PROBE_FILENAME,
  type DemandProbeEvent,
} from './demand-probe';
import { resetWorkspaceStateDirCacheForTests } from '../workspace-state-dir';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

/** Fresh temp workspace root; caller cleans up. */
function makeWorkspace(): string {
  resetWorkspaceStateDirCacheForTests();
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'demand-probe-'));
}

function rawLines(file: string): string[] {
  return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l !== '');
}

// ── atomic single-line append + on-disk shape + location ────────────────────
test('appends one JSONL line under <stateDir>/usage/demand-probe.jsonl', () => {
  const root = makeWorkspace();
  try {
    const res = recordDemandProbe({
      workspaceRoot: root,
      workspaceId: 'ws-1',
      kind: 'proposal_authored',
      source: 'agent-tool',
      ts: '2026-08-02T00:00:00.000Z',
    });
    assert.equal(res.appended, true);
    assert.equal(res.duplicate, false);

    // Lands under .lares/usage/ with the documented filename.
    const expected = demandProbeFilePath(root);
    assert.equal(res.file, expected);
    assert.ok(expected.replace(/\\/g, '/').endsWith(`/.lares/usage/${DEMAND_PROBE_FILENAME}`), expected);

    const lines = rawLines(expected);
    assert.equal(lines.length, 1, 'exactly one line appended');

    const ev = JSON.parse(lines[0]) as DemandProbeEvent;
    assert.equal(ev.eventId, res.eventId);
    assert.equal(ev.ts, '2026-08-02T00:00:00.000Z');
    assert.equal(ev.workspace_id, 'ws-1');
    assert.equal(ev.kind, 'proposal_authored');
    assert.equal(ev.source, 'agent-tool');
    assert.equal(ev.feature_exercise, false, 'defaults to false');
    assert.ok(!('manual_class' in ev), 'manual_class omitted when unset');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── the writer NEVER stamps a "voluntary" boolean ───────────────────────────
test('the persisted record carries no "voluntary" field (eligibility is read-time)', () => {
  const root = makeWorkspace();
  try {
    recordDemandProbe({
      workspaceRoot: root,
      workspaceId: 'ws-1',
      kind: 'promotion_requested',
      source: 'renderer-user-action',
      feature_exercise: false,
    });
    const raw = fs.readFileSync(demandProbeFilePath(root), 'utf-8');
    assert.ok(!/voluntary/i.test(raw), 'no voluntary key/value written by the sink');
    const ev = JSON.parse(rawLines(demandProbeFilePath(root))[0]);
    assert.deepEqual(
      Object.keys(ev).sort(),
      ['eventId', 'feature_exercise', 'kind', 'source', 'ts', 'workspace_id'],
      'only the factual tags are persisted',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── idempotent, non-duplicating retry by eventId ────────────────────────────
test('retry with the same eventId is a no-op (non-duplicating)', () => {
  const root = makeWorkspace();
  try {
    const first = recordDemandProbe({
      workspaceRoot: root,
      workspaceId: 'ws-1',
      kind: 'proposal_authored',
      source: 'agent-tool',
      eventId: 'evt-fixed',
    });
    assert.equal(first.appended, true);

    const retry = recordDemandProbe({
      workspaceRoot: root,
      workspaceId: 'ws-1',
      kind: 'proposal_authored',
      source: 'agent-tool',
      eventId: 'evt-fixed',
    });
    assert.equal(retry.appended, false);
    assert.equal(retry.duplicate, true);

    assert.equal(rawLines(demandProbeFilePath(root)).length, 1, 'no duplicate line');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── rotation honored (size cap) ─────────────────────────────────────────────
test('rotation moves the current sink to <file>.1 when the cap is exceeded', () => {
  const root = makeWorkspace();
  try {
    const file = demandProbeFilePath(root);
    // Tiny cap so a couple of events trip rotation without writing megabytes.
    for (let i = 0; i < 3; i++) {
      recordDemandProbe({
        workspaceRoot: root,
        workspaceId: 'ws-1',
        kind: 'reader_open',
        source: 'renderer-user-action',
        eventId: `evt-${i}`,
        maxBytes: 200,
      });
    }
    assert.ok(fs.existsSync(`${file}.1`), 'a rotated backup exists');
    // Current file holds only the tail written after the last rotation.
    assert.ok(rawLines(file).length < 3, 'current sink was trimmed by rotation');
    assert.ok(fs.statSync(file).size <= 200 * 2, 'current sink stays near the cap');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── kind guard for the HTTP/IPC boundaries ──────────────────────────────────
test('isDemandProbeKind gates the four known kinds only', () => {
  for (const k of ['proposal_authored', 'promotion_requested', 'reader_open', 'savecard_open']) {
    assert.equal(isDemandProbeKind(k), true, k);
  }
  for (const bad of ['voluntary', 'PROPOSAL_AUTHORED', '', 42, null, undefined, {}]) {
    assert.equal(isDemandProbeKind(bad as unknown), false, String(bad));
  }
});

// ── aggregation reproduces N/M/K with the documented exclusions ──────────────
test('aggregateDemand computes N/M/K excluding feature_exercise + test-harness', () => {
  const root = makeWorkspace();
  try {
    const add = (kind: DemandProbeEvent['kind'], source: DemandProbeEvent['source'], feature_exercise = false, i = 0) =>
      recordDemandProbe({
        workspaceRoot: root, workspaceId: 'ws-1', kind, source, feature_exercise,
        eventId: `${kind}-${source}-${feature_exercise}-${i}`,
      });

    // Eligible signal: N=2 proposals, M=3 opens (2 reader + 1 savecard), K=1 promotion.
    add('proposal_authored', 'agent-tool', false, 0);
    add('proposal_authored', 'renderer-user-action', false, 1);
    add('reader_open', 'renderer-user-action', false, 0);
    add('reader_open', 'renderer-user-action', false, 1);
    add('savecard_open', 'renderer-user-action', false, 0);
    add('promotion_requested', 'agent-tool', false, 0);

    // Excluded — feature_exercise flag (an exercising path), even from a real source.
    add('proposal_authored', 'renderer-user-action', true, 2);
    add('reader_open', 'agent-tool', true, 2);
    // Excluded — test-harness source.
    add('proposal_authored', 'test-harness', false, 3);
    add('promotion_requested', 'test-harness', false, 1);

    const events = readDemandProbeEvents(root);
    assert.equal(events.length, 10, 'all events persisted');

    const m = aggregateDemand(events);
    assert.equal(m.N, 2, 'N = eligible proposal_authored');
    assert.equal(m.M, 3, 'M = eligible reader/savecard opens');
    assert.equal(m.K, 1, 'K = eligible promotion_requested');
    assert.equal(m.eligible, 6, 'six voluntary-eligible events');
    assert.equal(m.total, 10, 'total counts every parsed event');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
