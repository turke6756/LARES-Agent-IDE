// WP2 provenance spine — DB-layer test for the four provenance tables.
//
// Covers migration idempotence (all four tables survive a double initDatabase),
// the recordPlanSectionTouch cross-source dedup matrix (tool_use_id / 2s bucket),
// getTurnSectionTouches + getTurnSectionChanges windowing, and an insertPlanEvent
// roundtrip (F-A columns, boolean→integer mapping).
//
// better-sqlite3's native binding won't load under the system Node that
// `npm run test:*` uses, so this injects a sql.js (wasm SQLite) stand-in into
// require.cache BEFORE requiring ../database (precedent: plans-data-layer.test.ts).
//
//   npm run build:main
//   node dist/main/main/plans-provenance-db.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// Fix-4 pure module (imports only shared types — safe to load before the DB mock).
import { rollupRepoActivity, serializeRepoActivityEvidence, FILE_OPS } from './plans/repo-activity';
import type { FileActivity } from '../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors plans-data-layer.test.ts) ───

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};

let sqlJsCtor: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  private dbPath: string;
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }
  pragma(_s: string): unknown { return undefined; }
  close(): void { FakeBetterSqlite.stores.delete(this.dbPath); }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          return stmt.step() ? stmt.getAsObject() : undefined;
        } finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }
}

// ── module under test ─────────────────────────────────────────────────────────

type PlanSectionTouchInput = {
  agentId: string; planId: string; sectionAnchor: string; blockAnchor?: string | null;
  tool: string; kind: 'read' | 'edit-target'; readMode?: string | null;
  source: 'handler' | 'transcript'; toolUseId?: string | null;
  resolvePayload?: string | null; observedAt?: string;
};
type PlanSectionTouchRow = PlanSectionTouchInput & { id: string; observedAt: string };
type PlanSectionChangeRow = {
  id: string; planId: string; sectionAnchor: string; blockAnchor: string | null;
  contentHash: string; changedAt: string;
};
type InsertPlanEventInput = {
  planId: string; agentId: string; eventType: string;
  dispatchedSectionAnchor?: string | null; observedSectionAnchor?: string | null;
  observedVia?: string | null; attributionConfidence?: string | null;
  observedCandidatesJson?: string | null; readIntentAnchor?: string | null;
  editTargetAnchor?: string | null; sectionMismatch?: boolean; mismatchReason?: string | null;
  trustedEnvelopeJson: string; claimedPayloadJson?: string | null;
  claimedSectionAnchor?: string | null;
  writtenSectionAnchorsJson?: string | null; changeCount?: number;
  repoActivityJson?: string | null;
  createdAt?: string;
};
type FileActivityRow = {
  id: number; agentId: string; filePath: string; operation: string;
  timestamp: string; generation: number; sessionId: string | null;
};
// Fix-4 evidence shape as read back (loose — the pure module owns the strict type).
type RepoEvidence = {
  schemaVersion: number; status: string;
  totals: { filesRead: number; filesEdited: number; filesCreated: number; fileEvents: number; distinctFiles: number; testsRun: number; testsPassed: number; testsFailed: number };
  files: { truncated: boolean; items: unknown[] };
  window: { sinceIso: string; untilIso: string };
} | null;
type AgentLike = { id: string; status: string; planId: string | null } | null;
type DbModule = {
  initDatabase(): void;
  getDb(): { prepare(sql: string): {
    get(...p: unknown[]): Record<string, unknown> | undefined;
    all(...p: unknown[]): Record<string, unknown>[];
    run(...p: unknown[]): unknown;
  } };
  recordPlanSectionTouch(input: PlanSectionTouchInput): string | null;
  getTurnSectionTouches(agentId: string, sinceIso: string, untilIso: string): PlanSectionTouchRow[];
  recordPlanSectionChange(input: { planId: string; sectionAnchor: string; blockAnchor?: string | null; contentHash: string; changedAt?: string }): string;
  getTurnSectionChanges(planId: string, sinceIso: string, untilIso: string): PlanSectionChangeRow[];
  insertPlanEvent(input: InsertPlanEventInput): string;
  backfillPlanEventWrittenSets(): void;
  getPlanEventsForRender(planId: string): Array<{
    id: string; agentId: string; agentTitle: string | null; createdAt: string;
    observedSectionAnchor: string | null; dispatchedSectionAnchor: string | null;
    observedVia: string | null; attributionConfidence: string | null;
    sectionMismatch: boolean; mismatchReason: string | null;
    claimedSectionAnchor: string | null; claimedPayload: Record<string, unknown> | null;
    changeCount: number; observedCandidates: string[]; writtenSectionAnchors: string[];
    repoActivity: RepoEvidence;
  }>;
  getPlanEventRollup(planId: string): Array<{
    sectionAnchor: string; writeCount: number; presenceCount: number;
    lastWriteAt: string | null; lastPresenceAt: string | null;
    eventCount: number; lastEventAt: string | null;
    repoFilesRead: number; repoFilesEdited: number; repoFilesCreated: number;
    testsRun: number; testsPassed: number; testsFailed: number; lastCommit: string | null;
  }>;
  getTurnRepoActivity(agentId: string, sinceIso: string, untilIso: string): FileActivityRow[];
  getPlanEventRepoActivity(planId: string, planEventId: string): RepoEvidence;
  addFileActivity(agentId: string, filePath: string, operation: string): FileActivityRow | null;
  getLiveRailAgentForPlan(planId: string, exemptAgentIds?: string[]): AgentLike;
  getActiveRailWriterCount(planId: string): number;
  closeDatabaseForTests(): void;
};
let dbm: DbModule;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const T0 = '2026-07-05T00:00:00.000Z';
const T_1_5s = '2026-07-05T00:00:01.500Z';
const T_5s = '2026-07-05T00:00:05.000Z';

let agentSeq = 0;
const nextAgent = () => `agent-${++agentSeq}`;

// ── tests ─────────────────────────────────────────────────────────────────────

test('migration idempotence — initDatabase() twice leaves all four provenance tables', () => {
  dbm.initDatabase(); // second call (runner already did the first)
  const rows = dbm.getDb().prepare(
    `SELECT name FROM sqlite_master WHERE type='table'
       AND name IN ('plan_sections','plan_events','plan_section_touches','plan_section_changes')`,
  ).all();
  const names = new Set(rows.map((r) => r.name));
  for (const t of ['plan_sections', 'plan_events', 'plan_section_touches', 'plan_section_changes']) {
    assert.ok(names.has(t), `table ${t} exists after double init`);
  }
});

test('recordPlanSectionTouch — plain insert returns a uuid id', () => {
  const id = dbm.recordPlanSectionTouch({
    agentId: nextAgent(), planId: 'plan-1', sectionAnchor: 'sec_aaa111',
    tool: 'read_plan_section', kind: 'read', source: 'transcript',
    toolUseId: 'tu-plain', observedAt: T0,
  });
  assert.ok(id && UUID_RE.test(id));
});

test('dedup — same tool_use_id is a no-op across sources (handler + transcript)', () => {
  const agentId = nextAgent();
  const first = dbm.recordPlanSectionTouch({
    agentId, planId: 'plan-1', sectionAnchor: 'sec_aaa111',
    tool: 'read_plan_section', kind: 'read', source: 'handler',
    toolUseId: 'tu-shared', observedAt: T0,
  });
  const second = dbm.recordPlanSectionTouch({
    agentId, planId: 'plan-1', sectionAnchor: 'sec_aaa111',
    tool: 'read_plan_section', kind: 'read', source: 'transcript',
    toolUseId: 'tu-shared', observedAt: T0,
  });
  assert.ok(first, 'first insert lands');
  assert.equal(second, null, 'duplicate tool_use_id deduped');
  const rows = dbm.getTurnSectionTouches(agentId, T0, T_5s);
  assert.equal(rows.length, 1, 'exactly one row persisted');
});

test('dedup — null tool_use_id inside the 2s bucket is a no-op', () => {
  const agentId = nextAgent();
  const first = dbm.recordPlanSectionTouch({
    agentId, planId: 'plan-1', sectionAnchor: 'sec_bbb222',
    tool: 'list_plan_sections', kind: 'read', source: 'handler',
    toolUseId: null, observedAt: T0,
  });
  const within = dbm.recordPlanSectionTouch({
    agentId, planId: 'plan-1', sectionAnchor: 'sec_bbb222',
    tool: 'list_plan_sections', kind: 'read', source: 'transcript',
    toolUseId: null, observedAt: T_1_5s, // 1.5s ≤ 2s bucket
  });
  assert.ok(first);
  assert.equal(within, null, '1.5s within the bucket → deduped');
});

test('dedup — null tool_use_id outside the 2s bucket inserts a fresh row', () => {
  const agentId = nextAgent();
  dbm.recordPlanSectionTouch({
    agentId, planId: 'plan-1', sectionAnchor: 'sec_ccc333',
    tool: 'list_plan_sections', kind: 'read', source: 'handler',
    toolUseId: null, observedAt: T0,
  });
  const outside = dbm.recordPlanSectionTouch({
    agentId, planId: 'plan-1', sectionAnchor: 'sec_ccc333',
    tool: 'list_plan_sections', kind: 'read', source: 'transcript',
    toolUseId: null, observedAt: T_5s, // 5s > 2s bucket
  });
  assert.ok(outside, '5s outside the bucket → fresh insert');
  assert.equal(dbm.getTurnSectionTouches(agentId, T0, T_5s).length, 2);
});

test('dedup — differing section_anchor is not a duplicate even in-bucket', () => {
  const agentId = nextAgent();
  dbm.recordPlanSectionTouch({
    agentId, planId: 'plan-1', sectionAnchor: 'sec_ddd444',
    tool: 'read_plan_section', kind: 'read', source: 'handler', toolUseId: null, observedAt: T0,
  });
  const other = dbm.recordPlanSectionTouch({
    agentId, planId: 'plan-1', sectionAnchor: 'sec_eee555',
    tool: 'read_plan_section', kind: 'read', source: 'transcript', toolUseId: null, observedAt: T0,
  });
  assert.ok(other, 'different anchor → distinct row');
});

test('getTurnSectionTouches — windows to [since, until], ordered by observed_at ASC', () => {
  const agentId = nextAgent();
  // before-window, in-window (two, out of order), after-window
  dbm.recordPlanSectionTouch({ agentId, planId: 'plan-1', sectionAnchor: 'sec_before', tool: 'read_plan_section', kind: 'read', source: 'transcript', toolUseId: 'w-0', observedAt: '2026-07-04T23:59:00.000Z' });
  dbm.recordPlanSectionTouch({ agentId, planId: 'plan-1', sectionAnchor: 'sec_late00', tool: 'read_plan_section', kind: 'read', source: 'transcript', toolUseId: 'w-2', observedAt: '2026-07-05T00:00:08.000Z' });
  dbm.recordPlanSectionTouch({ agentId, planId: 'plan-1', sectionAnchor: 'sec_early0', tool: 'read_plan_section', kind: 'read', source: 'transcript', toolUseId: 'w-1', observedAt: '2026-07-05T00:00:02.000Z' });
  dbm.recordPlanSectionTouch({ agentId, planId: 'plan-1', sectionAnchor: 'sec_after0', tool: 'read_plan_section', kind: 'read', source: 'transcript', toolUseId: 'w-3', observedAt: '2026-07-05T00:01:00.000Z' });

  const win = dbm.getTurnSectionTouches(agentId, T0, '2026-07-05T00:00:10.000Z');
  assert.deepEqual(win.map((r) => r.sectionAnchor), ['sec_early0', 'sec_late00'], 'in-window only, ASC by time');
});

test('recordPlanSectionChange + getTurnSectionChanges — windowed effect store', () => {
  const planId = 'plan-changes-' + nextAgent();
  const id = dbm.recordPlanSectionChange({ planId, sectionAnchor: 'sec_chg001', contentHash: 'h1', changedAt: '2026-07-05T00:00:03.000Z' });
  assert.ok(id && UUID_RE.test(id));
  dbm.recordPlanSectionChange({ planId, sectionAnchor: 'sec_chg000', contentHash: 'h0', changedAt: '2026-07-04T00:00:00.000Z' }); // before
  dbm.recordPlanSectionChange({ planId, sectionAnchor: 'sec_chg002', contentHash: 'h2', changedAt: '2026-07-05T00:00:06.000Z' }); // in
  dbm.recordPlanSectionChange({ planId, sectionAnchor: 'sec_chg999', contentHash: 'h9', changedAt: '2026-07-06T00:00:00.000Z' }); // after

  const win = dbm.getTurnSectionChanges(planId, T0, '2026-07-05T00:00:10.000Z');
  assert.deepEqual(win.map((r) => r.sectionAnchor), ['sec_chg001', 'sec_chg002'], 'in-window, ASC by changed_at');
  assert.equal(win[0].contentHash, 'h1');
  assert.equal(win[0].blockAnchor, null);
});

test('getTurnSectionChanges — scoped to plan_id', () => {
  const a = 'plan-A-' + nextAgent();
  const b = 'plan-B-' + nextAgent();
  dbm.recordPlanSectionChange({ planId: a, sectionAnchor: 'sec_aaa111', contentHash: 'h', changedAt: '2026-07-05T00:00:03.000Z' });
  dbm.recordPlanSectionChange({ planId: b, sectionAnchor: 'sec_bbb222', contentHash: 'h', changedAt: '2026-07-05T00:00:03.000Z' });
  assert.equal(dbm.getTurnSectionChanges(a, T0, T_5s).length, 1);
  assert.equal(dbm.getTurnSectionChanges(a, T0, T_5s)[0].sectionAnchor, 'sec_aaa111');
});

test('insertPlanEvent — full F-A roundtrip incl. boolean→integer + claimed mirror', () => {
  const planId = 'plan-evt';
  const agentId = nextAgent();
  const id = dbm.insertPlanEvent({
    planId, agentId, eventType: 'turn-end',
    dispatchedSectionAnchor: 'sec_disp00',
    observedSectionAnchor: 'sec_obs000',
    observedVia: 'fs-diff',
    attributionConfidence: 'medium',
    observedCandidatesJson: JSON.stringify(['sec_obs000', 'sec_disp00']),
    readIntentAnchor: 'sec_int000',
    editTargetAnchor: null,
    sectionMismatch: true,
    mismatchReason: 'dispatch-drift',
    trustedEnvelopeJson: JSON.stringify({ agentId, planId }),
    claimedPayloadJson: JSON.stringify({ claimed_section_anchor: 'sec_clm000' }),
    claimedSectionAnchor: 'sec_clm000',
    createdAt: T0,
  });
  assert.ok(id && UUID_RE.test(id));

  const row = dbm.getDb().prepare('SELECT * FROM plan_events WHERE id = ?').get(id)!;
  assert.equal(row.plan_id, planId);
  assert.equal(row.agent_id, agentId);
  assert.equal(row.event_type, 'turn-end');
  assert.equal(row.created_at, T0);
  assert.equal(row.dispatched_section_anchor, 'sec_disp00');
  assert.equal(row.observed_section_anchor, 'sec_obs000');
  assert.equal(row.observed_via, 'fs-diff');
  assert.equal(row.attribution_confidence, 'medium');
  assert.equal(row.read_intent_anchor, 'sec_int000');
  assert.equal(row.edit_target_anchor, null);
  assert.equal(row.section_mismatch, 1, 'boolean true → integer 1');
  assert.equal(row.mismatch_reason, 'dispatch-drift');
  assert.equal(row.claimed_section_anchor, 'sec_clm000', 'claimed anchor mirrored');
  assert.deepEqual(JSON.parse(row.observed_candidates_json as string), ['sec_obs000', 'sec_disp00']);
  assert.deepEqual(JSON.parse(row.trusted_envelope_json as string), { agentId, planId });
});

test('insertPlanEvent — section_mismatch defaults to 0 and nullable columns tolerate omission', () => {
  const id = dbm.insertPlanEvent({
    planId: 'plan-evt', agentId: nextAgent(), eventType: 'turn-end',
    trustedEnvelopeJson: '{}',
  });
  const row = dbm.getDb().prepare('SELECT * FROM plan_events WHERE id = ?').get(id)!;
  assert.equal(row.section_mismatch, 0, 'default false → 0');
  assert.equal(row.dispatched_section_anchor, null);
  assert.equal(row.observed_via, null);
  assert.equal(row.claimed_section_anchor, null);
  assert.equal(row.claimed_payload_json, null);
});

test('getPlanEventsForRender — per-event tier-2 rows, ordered, claimed parsed, scoped to plan', () => {
  const planId = 'plan-render';
  const other = 'plan-render-other';
  // Insert out of order to prove created_at ASC ordering.
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    observedSectionAnchor: 'sec_b2', dispatchedSectionAnchor: 'sec_a1',
    observedVia: 'multi-section', attributionConfidence: 'low',
    sectionMismatch: true, mismatchReason: 'intent-effect-divergence',
    trustedEnvelopeJson: '{}',
    claimedPayloadJson: JSON.stringify({ claimed_section_anchor: 'sec_b2', note: 'done' }),
    claimedSectionAnchor: 'sec_b2',
    createdAt: T_5s,
  });
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    observedSectionAnchor: 'sec_a1', dispatchedSectionAnchor: 'sec_a1',
    observedVia: 'edit-target', attributionConfidence: 'high',
    trustedEnvelopeJson: '{}',
    createdAt: T0,
  });
  // A different plan's event must not leak in.
  dbm.insertPlanEvent({ planId: other, agentId: nextAgent(), eventType: 'turn-end', trustedEnvelopeJson: '{}', createdAt: T0 });

  const rows = dbm.getPlanEventsForRender(planId);
  assert.equal(rows.length, 2, 'only this plan\'s events');
  assert.equal(rows[0].createdAt, T0, 'ordered created_at ASC');
  assert.equal(rows[1].createdAt, T_5s);

  const high = rows[0];
  assert.equal(high.observedSectionAnchor, 'sec_a1');
  assert.equal(high.observedVia, 'edit-target');
  assert.equal(high.attributionConfidence, 'high');
  assert.equal(high.sectionMismatch, false, 'integer 0 → boolean false');
  assert.equal(high.claimedPayload, null, 'no claim → null payload');
  assert.equal(high.agentTitle, null, 'no agents row joined → null title (LEFT JOIN)');

  const low = rows[1];
  assert.equal(low.sectionMismatch, true, 'integer 1 → boolean true');
  assert.equal(low.mismatchReason, 'intent-effect-divergence');
  assert.equal(low.claimedSectionAnchor, 'sec_b2');
  assert.deepEqual(low.claimedPayload, { claimed_section_anchor: 'sec_b2', note: 'done' }, 'claimed json parsed to object');
});

test('getPlanEventsForRender — malformed claimed_payload_json degrades to null, never throws', () => {
  const planId = 'plan-render-bad';
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    trustedEnvelopeJson: '{}', claimedPayloadJson: '{not valid json', createdAt: T0,
  });
  let rows: ReturnType<DbModule['getPlanEventsForRender']> = [];
  assert.doesNotThrow(() => { rows = dbm.getPlanEventsForRender(planId); });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claimedPayload, null, 'unparseable payload → null (diagnostics-only, never fatal)');
});

// ── GT-A WP-A1: written-set / change_count columns + backfill ─────────────────

test('WP-A1 migration — written_section_anchors_json + change_count roundtrip after double init', () => {
  const id = dbm.insertPlanEvent({
    planId: 'plan-wp-a1-cols', agentId: nextAgent(), eventType: 'turn-end',
    trustedEnvelopeJson: '{}',
    writtenSectionAnchorsJson: JSON.stringify(['sec_w00001', 'sec_w00002']),
    changeCount: 5, createdAt: T0,
  });
  const row = dbm.getDb().prepare('SELECT * FROM plan_events WHERE id = ?').get(id)!;
  assert.deepEqual(JSON.parse(row.written_section_anchors_json as string), ['sec_w00001', 'sec_w00002']);
  assert.equal(row.change_count, 5);
});

test('WP-A1 migration — omitted written set is NULL (backfill target); change_count defaults 0', () => {
  const id = dbm.insertPlanEvent({
    planId: 'plan-wp-a1-def', agentId: nextAgent(), eventType: 'turn-end',
    trustedEnvelopeJson: '{}', createdAt: T0,
  });
  const row = dbm.getDb().prepare('SELECT * FROM plan_events WHERE id = ?').get(id)!;
  assert.equal(row.written_section_anchors_json, null, 'NULL until written/backfilled');
  assert.equal(row.change_count, 0, 'NOT NULL DEFAULT 0');
});

test('backfillPlanEventWrittenSets — reconstructs uniq(changed) + RAW change_count for NULL rows', () => {
  const planId = 'plan-backfill';
  const since = '2026-07-05T00:00:00.000Z';
  const until = '2026-07-05T00:00:10.000Z';
  dbm.recordPlanSectionChange({ planId, sectionAnchor: 'sec_bf0001', contentHash: 'h1', changedAt: '2026-07-05T00:00:01.000Z' });
  dbm.recordPlanSectionChange({ planId, sectionAnchor: 'sec_bf0002', contentHash: 'h2', changedAt: '2026-07-05T00:00:02.000Z' });
  dbm.recordPlanSectionChange({ planId, sectionAnchor: 'sec_bf0001', contentHash: 'h3', changedAt: '2026-07-05T00:00:03.000Z' }); // dup anchor
  dbm.recordPlanSectionChange({ planId, sectionAnchor: 'sec_bf0009', contentHash: 'h9', changedAt: '2026-07-06T00:00:00.000Z' }); // out of window
  const id = dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    trustedEnvelopeJson: JSON.stringify({ planId, window: { since, until } }), createdAt: since,
  });
  const before = dbm.getDb().prepare('SELECT written_section_anchors_json AS w FROM plan_events WHERE id = ?').get(id)!;
  assert.equal(before.w, null, 'NULL precondition');

  dbm.backfillPlanEventWrittenSets();

  const after = dbm.getDb().prepare('SELECT written_section_anchors_json AS w, change_count AS c FROM plan_events WHERE id = ?').get(id)!;
  assert.deepEqual(JSON.parse(after.w as string), ['sec_bf0001', 'sec_bf0002'], 'uniq(changed), in-window only');
  assert.equal(after.c, 3, 'change_count = RAW in-window cardinality (dup counted), NOT written.length');
});

test('backfillPlanEventWrittenSets — malformed / windowless envelope → [] / 0 (never NULL again)', () => {
  const bad = dbm.insertPlanEvent({ planId: 'plan-bf-bad', agentId: nextAgent(), eventType: 'turn-end', trustedEnvelopeJson: '{not json', createdAt: T0 });
  const noWindow = dbm.insertPlanEvent({ planId: 'plan-bf-nowin', agentId: nextAgent(), eventType: 'turn-end', trustedEnvelopeJson: JSON.stringify({ planId: 'plan-bf-nowin' }), createdAt: T0 });

  dbm.backfillPlanEventWrittenSets();

  for (const id of [bad, noWindow]) {
    const row = dbm.getDb().prepare('SELECT written_section_anchors_json AS w, change_count AS c FROM plan_events WHERE id = ?').get(id)!;
    assert.equal(row.w, '[]', 'malformed/windowless → [] not NULL');
    assert.equal(row.c, 0);
  }
});

test('backfillPlanEventWrittenSets — strict no-op on a second run (NULL-guarded, never reprocesses)', () => {
  const planId = 'plan-bf-noop';
  const since = '2026-07-05T00:00:00.000Z';
  const until = '2026-07-05T00:00:10.000Z';
  dbm.recordPlanSectionChange({ planId, sectionAnchor: 'sec_np0001', contentHash: 'h', changedAt: '2026-07-05T00:00:01.000Z' });
  const id = dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    trustedEnvelopeJson: JSON.stringify({ planId, window: { since, until } }), createdAt: since,
  });
  dbm.backfillPlanEventWrittenSets(); // fills it (written set now non-NULL)
  dbm.getDb().prepare('UPDATE plan_events SET change_count = 999 WHERE id = ?').run(id); // tamper
  dbm.backfillPlanEventWrittenSets(); // second run must skip the non-NULL row
  const row = dbm.getDb().prepare('SELECT change_count AS c FROM plan_events WHERE id = ?').get(id)!;
  assert.equal(row.c, 999, 'already-backfilled (non-NULL) row untouched on re-run');
});

// ── GT-C §3.1: change_count + observedCandidates on the render row ────────────

test('getPlanEventsForRender — surfaces change_count + parsed observedCandidates; malformed → 0 / []', () => {
  const planId = 'plan-render-gtc';
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    observedCandidatesJson: JSON.stringify(['sec_c00001', 'sec_c00002']),
    trustedEnvelopeJson: '{}', changeCount: 4, createdAt: T0,
  });
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    observedCandidatesJson: '{not an array', trustedEnvelopeJson: '{}', createdAt: T_5s,
  });
  const rows = dbm.getPlanEventsForRender(planId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].changeCount, 4);
  assert.deepEqual(rows[0].observedCandidates, ['sec_c00001', 'sec_c00002']);
  assert.equal(rows[1].changeCount, 0, 'omitted → column default 0');
  assert.deepEqual(rows[1].observedCandidates, [], 'malformed candidates JSON → []');
});

test('getPlanEventsForRender — surfaces writtenSectionAnchors via parseAnchorList; malformed → []', () => {
  const planId = 'plan-render-written';
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    writtenSectionAnchorsJson: JSON.stringify(['sec_wr0001', 'sec_wr0002']),
    trustedEnvelopeJson: '{}', changeCount: 2, createdAt: T0,
  });
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    writtenSectionAnchorsJson: '{not an array', trustedEnvelopeJson: '{}', createdAt: T_5s,
  });
  const rows = dbm.getPlanEventsForRender(planId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].writtenSectionAnchors, ['sec_wr0001', 'sec_wr0002']);
  assert.deepEqual(rows[1].writtenSectionAnchors, [], 'malformed written JSON → []');
});

// ── GT-A WP-A2.1: getPlanEventRollup write/presence split + fan-out ───────────

test('getPlanEventRollup — a 3-section write turn fans writeCount:1 onto each of the 3 sections', () => {
  const planId = 'plan-rollup-fan';
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    writtenSectionAnchorsJson: JSON.stringify(['sec_f00001', 'sec_f00002', 'sec_f00003']),
    changeCount: 3, trustedEnvelopeJson: '{}', createdAt: T0,
  });
  const rollup = dbm.getPlanEventRollup(planId);
  const byAnchor = new Map(rollup.map((r) => [r.sectionAnchor, r]));
  assert.equal(byAnchor.size, 3, 'exactly the 3 written sections');
  for (const anchor of ['sec_f00001', 'sec_f00002', 'sec_f00003']) {
    const r = byAnchor.get(anchor)!;
    assert.equal(r.writeCount, 1, `${anchor} writeCount fanned to 1`);
    assert.equal(r.presenceCount, 0);
    assert.equal(r.lastWriteAt, T0);
    assert.equal(r.lastPresenceAt, null);
    assert.equal(r.eventCount, 1, 'eventCount = writeCount + presenceCount');
    assert.equal(r.lastEventAt, T0, 'lastEventAt = max(lastWriteAt, lastPresenceAt)');
  }
});

test('getPlanEventRollup — an empty-written (presence) turn keys dispatched-first, not on observed', () => {
  const planId = 'plan-rollup-presence';
  // presence turn: empty written set, dispatched != observed → must bucket on dispatched (D-6).
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    writtenSectionAnchorsJson: JSON.stringify([]),
    dispatchedSectionAnchor: 'sec_disp01', observedSectionAnchor: 'sec_obs01',
    changeCount: 0, trustedEnvelopeJson: '{}', createdAt: T_5s,
  });
  const rollup = dbm.getPlanEventRollup(planId);
  const byAnchor = new Map(rollup.map((r) => [r.sectionAnchor, r]));
  assert.equal(byAnchor.size, 1, 'presence attributed to exactly one section');
  const disp = byAnchor.get('sec_disp01');
  assert.ok(disp, 'keyed on dispatched anchor');
  assert.equal(disp!.presenceCount, 1);
  assert.equal(disp!.writeCount, 0);
  assert.equal(disp!.lastPresenceAt, T_5s);
  assert.equal(disp!.lastWriteAt, null);
  assert.equal(disp!.eventCount, 1);
  assert.equal(disp!.lastEventAt, T_5s);
  assert.equal(byAnchor.has('sec_obs01'), false, 'observed anchor NOT credited when dispatched present');
});

test('getPlanEventRollup — presence with no dispatched falls back to observed anchor', () => {
  const planId = 'plan-rollup-presence-fallback';
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    writtenSectionAnchorsJson: JSON.stringify([]),
    dispatchedSectionAnchor: null, observedSectionAnchor: 'sec_obs02',
    trustedEnvelopeJson: '{}', createdAt: T0,
  });
  const rollup = dbm.getPlanEventRollup(planId);
  assert.deepEqual(rollup.map((r) => r.sectionAnchor), ['sec_obs02'], 'falls back to observed');
  assert.equal(rollup[0].presenceCount, 1);
});

test('getPlanEventRollup — write + presence on one section combine into eventCount / lastEventAt', () => {
  const planId = 'plan-rollup-combined';
  // A write turn on sec_cmb01 at T0, a presence turn dispatched to sec_cmb01 at T_5s.
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    writtenSectionAnchorsJson: JSON.stringify(['sec_cmb01']),
    changeCount: 1, trustedEnvelopeJson: '{}', createdAt: T0,
  });
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    writtenSectionAnchorsJson: JSON.stringify([]),
    dispatchedSectionAnchor: 'sec_cmb01', trustedEnvelopeJson: '{}', createdAt: T_5s,
  });
  const rollup = dbm.getPlanEventRollup(planId);
  assert.equal(rollup.length, 1);
  const r = rollup[0];
  assert.equal(r.writeCount, 1);
  assert.equal(r.presenceCount, 1);
  assert.equal(r.lastWriteAt, T0);
  assert.equal(r.lastPresenceAt, T_5s);
  assert.equal(r.eventCount, 2, 'writeCount + presenceCount');
  assert.equal(r.lastEventAt, T_5s, 'max(lastWriteAt, lastPresenceAt)');
});

test('getPlanEventRollup — presence turn with neither dispatched nor observed is dropped', () => {
  const planId = 'plan-rollup-orphan';
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end',
    writtenSectionAnchorsJson: JSON.stringify([]),
    dispatchedSectionAnchor: null, observedSectionAnchor: null,
    trustedEnvelopeJson: '{}', createdAt: T0,
  });
  assert.deepEqual(dbm.getPlanEventRollup(planId), [], 'no anchor to attribute → dropped');
});

// ── GT-C §1.8: sec_exectr exclusion + ownership helpers ───────────────────────

test('getTurnSectionChanges — excludes system sec_exectr trail writes', () => {
  const planId = 'plan-exectr-' + nextAgent();
  dbm.recordPlanSectionChange({ planId, sectionAnchor: 'sec_real00', contentHash: 'h', changedAt: '2026-07-05T00:00:01.000Z' });
  dbm.recordPlanSectionChange({ planId, sectionAnchor: 'sec_exectr', contentHash: 'h', changedAt: '2026-07-05T00:00:02.000Z' });
  const win = dbm.getTurnSectionChanges(planId, T0, T_5s);
  assert.deepEqual(win.map((r) => r.sectionAnchor), ['sec_real00'], 'sec_exectr filtered out (attribution safety)');
});

function insertAgent(o: { status: string; planId: string | null; createdAt: string }): string {
  const id = 'ag-' + nextAgent();
  dbm.getDb().prepare(
    `INSERT INTO agents (id, workspace_id, title, slug, working_directory, command, status, plan_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'ws-1', 'T', 'slug-' + id, '/tmp', 'claude', o.status, o.planId, o.createdAt);
  return id;
}

test('getLiveRailAgentForPlan — an IDLE plan-bound agent does NOT reserve the plan (amended §4.4)', () => {
  const planId = 'plan-own-idle';
  insertAgent({ status: 'idle', planId, createdAt: '2026-07-05T00:00:01.000Z' });
  assert.equal(dbm.getLiveRailAgentForPlan(planId), null, 'idle → null (kept-worker pattern stays legal)');
});

test('getLiveRailAgentForPlan — a working / launching plan-bound agent reserves the plan', () => {
  const p1 = 'plan-own-working';
  const w = insertAgent({ status: 'working', planId: p1, createdAt: '2026-07-05T00:00:01.000Z' });
  const live = dbm.getLiveRailAgentForPlan(p1);
  assert.ok(live && live.id === w && live.status === 'working');
  const p2 = 'plan-own-launching';
  const l = insertAgent({ status: 'launching', planId: p2, createdAt: '2026-07-05T00:00:01.000Z' });
  assert.equal(dbm.getLiveRailAgentForPlan(p2)!.id, l);
});

test('getLiveRailAgentForPlan — terminal agents never reserve; exemptAgentIds skips the reserver', () => {
  const planId = 'plan-own-mixed';
  insertAgent({ status: 'done', planId, createdAt: '2026-07-05T00:00:01.000Z' });
  insertAgent({ status: 'crashed', planId, createdAt: '2026-07-05T00:00:02.000Z' });
  const working = insertAgent({ status: 'working', planId, createdAt: '2026-07-05T00:00:03.000Z' });
  assert.equal(dbm.getLiveRailAgentForPlan(planId)!.id, working, 'the working agent reserves');
  assert.equal(dbm.getLiveRailAgentForPlan(planId, [working]), null, 'exempting the sole reserver → null');
});

test('getActiveRailWriterCount — counts only working|launching (idle / terminal excluded)', () => {
  const planId = 'plan-count';
  insertAgent({ status: 'working', planId, createdAt: '2026-07-05T00:00:01.000Z' });
  insertAgent({ status: 'launching', planId, createdAt: '2026-07-05T00:00:02.000Z' });
  insertAgent({ status: 'idle', planId, createdAt: '2026-07-05T00:00:03.000Z' });
  insertAgent({ status: 'done', planId, createdAt: '2026-07-05T00:00:04.000Z' });
  assert.equal(dbm.getActiveRailWriterCount(planId), 2, 'only the two actively-working agents');
});

// ── Fix-4: witnessed repo-activity — column, window query, blob round-trip, fan-out ──

// Build a serialized RepoActivityEvidenceV1 blob for N workspace-relative paths.
const REPO_ROOT = '/ws';
function repoBlob(paths: string[], op: 'read' | 'write' | 'create' = 'write'): string {
  const rows: FileActivity[] = paths.map((p, i) => ({
    id: i + 1, agentId: 'ag', filePath: `${REPO_ROOT}/${p}`, operation: op,
    timestamp: '2026-07-09T12:00:00.000Z', generation: 0, sessionId: null,
  }));
  const ev = rollupRepoActivity(rows, {
    sinceIso: '2026-07-09T12:00:00.000Z', untilIso: '2026-07-09T13:00:00.000Z',
    workspaceRoot: REPO_ROOT, planRelPath: null,
  });
  return serializeRepoActivityEvidence(ev);
}

// Direct insert so the test controls the datetime()-format timestamp column.
function insertFileActivityRaw(agentId: string, filePath: string, operation: string, timestamp: string): void {
  dbm.getDb().prepare(
    `INSERT INTO file_activities (agent_id, file_path, operation, timestamp) VALUES (?, ?, ?, ?)`,
  ).run(agentId, filePath, operation, timestamp);
}

test('fix4 migration — repo_activity_json column present after double init (idempotent)', () => {
  dbm.initDatabase(); // second init
  const cols = dbm.getDb().prepare(`PRAGMA table_info(plan_events)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  assert.ok(names.has('repo_activity_json'), 'repo_activity_json exists (added once, ALTER swallowed on re-run)');
});

test('fix4 getTurnRepoActivity — datetime()-both-sides window spans the datetime/ISO format boundary', () => {
  const agentId = nextAgent();
  // file_activities.timestamp is datetime('now') format; the query window is ISO.
  insertFileActivityRaw(agentId, '/ws/before.ts', 'read',  '2026-07-08 23:59:59'); // 1s+ before
  insertFileActivityRaw(agentId, '/ws/in1.ts',    'write', '2026-07-09 12:00:05'); // in-window
  insertFileActivityRaw(agentId, '/ws/in2.ts',    'read',  '2026-07-09 12:00:09'); // in-window
  insertFileActivityRaw(agentId, '/ws/after.ts',  'write', '2026-07-09 13:00:01'); // after

  const rows = dbm.getTurnRepoActivity(agentId, '2026-07-09T12:00:00.000Z', '2026-07-09T12:00:10.000Z');
  // A raw-string compare (`timestamp >= '…T…Z'`) would drop ALL of these (space < 'T').
  assert.deepEqual(rows.map((r) => r.filePath), ['/ws/in1.ts', '/ws/in2.ts'], 'datetime() normalizes both sides');
});

test('fix4 getTurnRepoActivity — same-second rows return in stable insert (id) order', () => {
  const agentId = nextAgent();
  insertFileActivityRaw(agentId, '/ws/a.ts', 'read',  '2026-07-09 12:00:05');
  insertFileActivityRaw(agentId, '/ws/b.ts', 'read',  '2026-07-09 12:00:05');
  insertFileActivityRaw(agentId, '/ws/c.ts', 'write', '2026-07-09 12:00:05');
  const rows = dbm.getTurnRepoActivity(agentId, '2026-07-09T12:00:00.000Z', '2026-07-09T12:00:10.000Z');
  assert.deepEqual(rows.map((r) => r.filePath), ['/ws/a.ts', '/ws/b.ts', '/ws/c.ts'], 'id ASC tie-break');
});

test('fix4 getTurnRepoActivity — scoped to agent_id', () => {
  const a = nextAgent(), b = nextAgent();
  insertFileActivityRaw(a, '/ws/mine.ts', 'write', '2026-07-09 12:00:05');
  insertFileActivityRaw(b, '/ws/theirs.ts', 'write', '2026-07-09 12:00:05');
  const rows = dbm.getTurnRepoActivity(a, '2026-07-09T12:00:00.000Z', '2026-07-09T12:00:10.000Z');
  assert.deepEqual(rows.map((r) => r.filePath), ['/ws/mine.ts']);
});

test('fix4 insertPlanEvent — NULL repo blob → repoActivity === null on render', () => {
  const planId = 'plan-fix4-null';
  dbm.insertPlanEvent({ planId, agentId: nextAgent(), eventType: 'turn-end', trustedEnvelopeJson: '{}', createdAt: T0 });
  const rows = dbm.getPlanEventsForRender(planId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repoActivity, null, 'no blob → parsed null (pre-fix-4)');
});

test('fix4 insertPlanEvent — captured blob round-trips through getPlanEventsForRender', () => {
  const planId = 'plan-fix4-blob';
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end', trustedEnvelopeJson: '{}',
    repoActivityJson: repoBlob(['src/a.ts', 'src/b.ts']), createdAt: T0,
  });
  const rows = dbm.getPlanEventsForRender(planId);
  assert.equal(rows.length, 1);
  const ev = rows[0].repoActivity!;
  assert.ok(ev, 'blob parsed');
  assert.equal(ev.schemaVersion, 1);
  assert.equal(ev.status, 'captured');
  assert.equal(ev.totals.filesEdited, 2);
  assert.equal(ev.totals.distinctFiles, 2);
});

test('fix4 getPlanEventsForRender — malformed repo blob degrades to null, never throws', () => {
  const planId = 'plan-fix4-bad';
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end', trustedEnvelopeJson: '{}',
    repoActivityJson: '{not valid json', createdAt: T0,
  });
  let rows: ReturnType<DbModule['getPlanEventsForRender']> = [];
  assert.doesNotThrow(() => { rows = dbm.getPlanEventsForRender(planId); });
  assert.equal(rows[0].repoActivity, null, 'unparseable blob → null');
});

test('fix4 getPlanEventRollup — a 3-section write turn fans the full repo counts onto each anchor', () => {
  const planId = 'plan-fix4-fan';
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end', trustedEnvelopeJson: '{}',
    writtenSectionAnchorsJson: JSON.stringify(['sec_f00001', 'sec_f00002', 'sec_f00003']),
    changeCount: 3,
    repoActivityJson: repoBlob(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']), // 5 edited
    createdAt: T0,
  });
  const rollup = dbm.getPlanEventRollup(planId);
  const byAnchor = new Map(rollup.map((r) => [r.sectionAnchor, r]));
  assert.equal(byAnchor.size, 3);
  for (const anchor of ['sec_f00001', 'sec_f00002', 'sec_f00003']) {
    const r = byAnchor.get(anchor)!;
    assert.equal(r.repoFilesEdited, 5, `${anchor} gets the FULL 5 (not split, I-8 fan)`);
    assert.equal(r.testsRun, 0);
    assert.equal(r.testsPassed, 0);
    assert.equal(r.testsFailed, 0);
    assert.equal(r.lastCommit, null, 'no commit capture in cut 1');
  }
});

test('fix4 getPlanEventRollup — presence turn attributes repo counts to the dispatched-first bucket', () => {
  const planId = 'plan-fix4-presence';
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end', trustedEnvelopeJson: '{}',
    writtenSectionAnchorsJson: JSON.stringify([]),
    dispatchedSectionAnchor: 'sec_disp01', observedSectionAnchor: 'sec_obs01',
    repoActivityJson: repoBlob(['src/p.ts'], 'read'),
    createdAt: T_5s,
  });
  const rollup = dbm.getPlanEventRollup(planId);
  const disp = rollup.find((r) => r.sectionAnchor === 'sec_disp01')!;
  assert.ok(disp, 'keyed on dispatched');
  assert.equal(disp.repoFilesRead, 1);
  assert.equal(rollup.find((r) => r.sectionAnchor === 'sec_obs01'), undefined, 'observed not credited');
});

test('fix4 getPlanEventRollup — malformed repo blob contributes 0, never throws', () => {
  const planId = 'plan-fix4-rollup-bad';
  dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end', trustedEnvelopeJson: '{}',
    writtenSectionAnchorsJson: JSON.stringify(['sec_x00001']),
    changeCount: 1, repoActivityJson: '{not json', createdAt: T0,
  });
  let rollup: ReturnType<DbModule['getPlanEventRollup']> = [];
  assert.doesNotThrow(() => { rollup = dbm.getPlanEventRollup(planId); });
  const r = rollup.find((x) => x.sectionAnchor === 'sec_x00001')!;
  assert.equal(r.writeCount, 1, 'attribution intact');
  assert.equal(r.repoFilesEdited, 0, 'bad blob → 0 repo counts');
});

test('fix4 getPlanEventRepoActivity — valid (planId, eventId) → evidence; foreign planId → null', () => {
  const planId = 'plan-fix4-detail';
  const eventId = dbm.insertPlanEvent({
    planId, agentId: nextAgent(), eventType: 'turn-end', trustedEnvelopeJson: '{}',
    repoActivityJson: repoBlob(['src/one.ts', 'src/two.ts', 'src/three.ts']), createdAt: T0,
  });
  const ev = dbm.getPlanEventRepoActivity(planId, eventId);
  assert.ok(ev, 'valid pair → evidence');
  assert.equal(ev!.totals.filesEdited, 3);
  assert.equal(dbm.getPlanEventRepoActivity('plan-fix4-wrong', eventId), null, 'wrong plan_id → null (no cross-plan probe)');
  assert.equal(dbm.getPlanEventRepoActivity(planId, 'no-such-event'), null, 'unknown event → null');
});

test('fix4 getPlanEventRepoActivity — NULL blob event → null (not an error)', () => {
  const planId = 'plan-fix4-detail-null';
  const eventId = dbm.insertPlanEvent({ planId, agentId: nextAgent(), eventType: 'turn-end', trustedEnvelopeJson: '{}', createdAt: T0 });
  assert.equal(dbm.getPlanEventRepoActivity(planId, eventId), null);
});

// ── I-10 capture-drift contract: window semantics via addFileActivity + op set ──

test('fix4 capture drift — addFileActivity row (datetime now) round-trips through getTurnRepoActivity', () => {
  const agentId = nextAgent();
  const added = dbm.addFileActivity(agentId, '/ws/live.ts', 'write');
  assert.ok(added, 'row inserted at datetime(now)');
  // A window spanning any plausible "now" — proves the datetime()-both-sides query
  // still matches a real addFileActivity row (the second consumer of file_activities).
  const rows = dbm.getTurnRepoActivity(agentId, '2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z');
  assert.deepEqual(rows.map((r) => r.filePath), ['/ws/live.ts']);
});

test('fix4 capture drift — FILE_OPS keys are exactly the FileOperation union (compile + runtime pin)', () => {
  assert.deepEqual(Object.keys(FILE_OPS).sort(), ['create', 'read', 'write']);
});

// ── Runner ─────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-provenance-db-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('./database') as DbModule;
  dbm.initDatabase();

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  try { dbm.closeDatabaseForTests(); } catch { /* best-effort */ }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
