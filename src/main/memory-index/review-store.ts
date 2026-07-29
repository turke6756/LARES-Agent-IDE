// review-store.ts — durable state APIs + evidence reconciliation for Memory &
// Lessons v2 (WP-B). Thin persistence service over the memory_* tables declared
// in src/main/database.ts (reached via getDb()); statements are prepared per-call
// (the shared handle does not exist until initDatabase() runs; better-sqlite3
// caches prepared statements internally, so this is cheap).
//
// Security / semantics of record: plans/memory-lessons-v2-implementation.md §WP-B
// and plans/memory-lessons-v2-proposal.md §6. The reconciliation producer consumes
// WP-A1's pure projection outputs (ParsedIndex) — it imports the ratified
// constants from memory-index-core, never re-deriving them.
//
//   npm run build:main
//   node dist/main/main/memory-index/review-store.test.js

import crypto from 'crypto';
import { getDb } from '../database';
import {
  CAP_PRESSURE_RATIO,
  MEMORY_INDEX_BUDGET_BYTES,
  MEMORY_INDEX_BUDGET_LINES,
  NEVER_RECALLED_MIN_AGE_DAYS,
  type ParsedIndex,
} from '../../shared/memory-index-core';
import { PARSER_VERSION } from '../skill-analytics/parse-runner';
import { BACKFILL_COMPLETE_KEY, BACKFILL_VERSION_KEY } from '../skill-analytics/parse-manager';

// ── small coercion helpers (real handle OR the sql.js test fake) ──
function num(v: unknown): number {
  return typeof v === 'number' ? v : v == null ? 0 : Number(v) || 0;
}
function str(v: unknown): string | null {
  return v == null ? null : String(v);
}
function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── Review-queue findings ─────────────────────────────────────────────────────
export type FindingKind =
  | 'never-recalled'
  | 'never-fired'
  | 'evidence-unavailable'
  | 'cap-pressure'
  // hard-invalid + advisory classes surfaced by the launch path (WP-C) reuse the
  // same queue; the store treats `kind` as opaque.
  | string;

export interface FindingInput {
  kind: FindingKind;
  /** null for whole-index findings (legacy-format, budgets, cap-pressure,
   *  evidence-unavailable). */
  entryId: string | null;
  /** per-entry hash, or the whole-index source hash for index-level findings. */
  sourceHash: string;
  reason: string;
  exitCondition?: string | null;
}

export interface ReviewFindingRow {
  findingId: string;
  workspaceId: string;
  kind: string;
  entryId: string | null;
  sourceHash: string | null;
  reason: string | null;
  exitCondition: string | null;
  status: 'pending' | 'cleared' | 'resolved' | string;
  firstSeen: string;
  lastSeen: string;
}

/** finding_id = sha256(workspace_id | kind | COALESCE(entry_id,'') | source_hash).
 *  Stable across snapshots — a materially-changed entry yields a new source_hash
 *  (or entry hash) and therefore a new finding_id, so it recurs as a fresh row. */
export function computeFindingId(ws: string, f: Pick<FindingInput, 'kind' | 'entryId' | 'sourceHash'>): string {
  return sha256Hex(`${ws}|${f.kind}|${f.entryId ?? ''}|${f.sourceHash}`);
}

/**
 * Idempotent by finding_id. A repeat of the SAME snapshot re-produces the same
 * finding_id and only advances `last_seen` (and refreshes reason/exit_condition),
 * leaving the row count unchanged; a re-produced finding is (re)marked `pending`
 * because it is a live problem this pass. A materially-changed entry hashes to a
 * new finding_id and inserts as a fresh row. Rows are never deleted here.
 */
export function upsertFindings(ws: string, findings: FindingInput[], nowISO: string): string[] {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO memory_review_queue
       (finding_id, workspace_id, kind, entry_id, source_hash, reason, exit_condition, status, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(finding_id) DO UPDATE SET
       last_seen = excluded.last_seen,
       reason = excluded.reason,
       exit_condition = excluded.exit_condition,
       status = 'pending'`,
  );
  const ids: string[] = [];
  for (const f of findings) {
    const id = computeFindingId(ws, f);
    insert.run(id, ws, f.kind, f.entryId, f.sourceHash, f.reason, f.exitCondition ?? null, nowISO, nowISO);
    ids.push(id);
  }
  return ids;
}

/**
 * Clear-not-delete: every `pending` finding for `ws` whose finding_id is NOT in
 * `keepIds` transitions to `cleared` (history preserved; the row is never
 * removed). `resolved`/already-`cleared` rows are left untouched.
 */
export function clearFindings(ws: string, keepIds: string[], nowISO: string): number {
  const db = getDb();
  const keep = new Set(keepIds);
  const rows = db
    .prepare(`SELECT finding_id FROM memory_review_queue WHERE workspace_id = ? AND status = 'pending'`)
    .all(ws) as Array<{ finding_id: unknown }>;
  const clear = db.prepare(
    `UPDATE memory_review_queue SET status = 'cleared', last_seen = ? WHERE finding_id = ? AND status = 'pending'`,
  );
  let n = 0;
  for (const r of rows) {
    const id = String(r.finding_id);
    if (!keep.has(id)) {
      clear.run(nowISO, id);
      n++;
    }
  }
  return n;
}

export function listFindings(ws: string, status?: string): ReviewFindingRow[] {
  const db = getDb();
  const rows = status
    ? db
        .prepare(`SELECT * FROM memory_review_queue WHERE workspace_id = ? AND status = ? ORDER BY first_seen`)
        .all(ws, status)
    : db.prepare(`SELECT * FROM memory_review_queue WHERE workspace_id = ? ORDER BY first_seen`).all(ws);
  return (rows as Record<string, unknown>[]).map(rowToFinding);
}

function rowToFinding(r: Record<string, unknown>): ReviewFindingRow {
  return {
    findingId: String(r.finding_id),
    workspaceId: String(r.workspace_id),
    kind: String(r.kind),
    entryId: str(r.entry_id),
    sourceHash: str(r.source_hash),
    reason: str(r.reason),
    exitCondition: str(r.exit_condition),
    status: String(r.status),
    firstSeen: String(r.first_seen),
    lastSeen: String(r.last_seen),
  };
}

// ── Recall telemetry ──────────────────────────────────────────────────────────
/**
 * Atomic recall increment (documented approximate tally — no idempotency key,
 * consumed only as a `>0 vs 0` signal). One increment per successful recall.
 */
export function bumpRecall(ws: string, entryId: string, nowISO: string): void {
  getDb()
    .prepare(
      `INSERT INTO memory_usage_counts (workspace_id, entry_id, count, last_recalled)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(workspace_id, entry_id) DO UPDATE SET
         count = count + 1,
         last_recalled = excluded.last_recalled`,
    )
    .run(ws, entryId, nowISO);
}

export function getRecallCount(ws: string, entryId: string): number {
  const row = getDb()
    .prepare(`SELECT count FROM memory_usage_counts WHERE workspace_id = ? AND entry_id = ?`)
    .get(ws, entryId) as { count: unknown } | undefined;
  return row ? num(row.count) : 0;
}

function recallMap(ws: string): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT entry_id, count FROM memory_usage_counts WHERE workspace_id = ?`)
    .all(ws) as Array<{ entry_id: unknown; count: unknown }>;
  const m = new Map<string, number>();
  for (const r of rows) m.set(String(r.entry_id), num(r.count));
  return m;
}

// ── Lesson registry ───────────────────────────────────────────────────────────
export interface LessonInput {
  lessonId: string;
  name: string;
  canonicalHash: string;
  copies: string[];
  preexisted: string[];
  batchId?: string | null;
  status?: 'pending' | 'active' | 'conflict';
}

export interface LessonRow {
  workspaceId: string;
  lessonId: string;
  name: string;
  canonicalHash: string | null;
  copies: string[];
  preexisted: string[];
  batchId: string | null;
  status: string;
  createdAt: string;
}

export function registerLesson(ws: string, input: LessonInput, nowISO: string): void {
  getDb()
    .prepare(
      `INSERT INTO memory_lessons
         (workspace_id, lesson_id, name, canonical_hash, copies_json, preexisted_json, batch_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, lesson_id) DO UPDATE SET
         name = excluded.name,
         canonical_hash = excluded.canonical_hash,
         copies_json = excluded.copies_json,
         preexisted_json = excluded.preexisted_json,
         batch_id = excluded.batch_id,
         status = excluded.status`,
    )
    .run(
      ws,
      input.lessonId,
      input.name,
      input.canonicalHash,
      JSON.stringify(input.copies ?? []),
      JSON.stringify(input.preexisted ?? []),
      input.batchId ?? null,
      input.status ?? 'pending',
      nowISO,
    );
}

export function setLessonStatus(ws: string, lessonId: string, status: string): void {
  getDb()
    .prepare(`UPDATE memory_lessons SET status = ? WHERE workspace_id = ? AND lesson_id = ?`)
    .run(status, ws, lessonId);
}

export function listLessons(ws: string, status?: string): LessonRow[] {
  const db = getDb();
  const rows = status
    ? db.prepare(`SELECT * FROM memory_lessons WHERE workspace_id = ? AND status = ?`).all(ws, status)
    : db.prepare(`SELECT * FROM memory_lessons WHERE workspace_id = ?`).all(ws);
  return (rows as Record<string, unknown>[]).map(rowToLesson);
}

function rowToLesson(r: Record<string, unknown>): LessonRow {
  return {
    workspaceId: String(r.workspace_id),
    lessonId: String(r.lesson_id),
    name: String(r.name),
    canonicalHash: str(r.canonical_hash),
    copies: parseJsonArray(r.copies_json),
    preexisted: parseJsonArray(r.preexisted_json),
    batchId: str(r.batch_id),
    status: String(r.status),
    createdAt: String(r.created_at),
  };
}

function parseJsonArray(v: unknown): string[] {
  if (v == null) return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Registry-level drift signal: lesson NAMES that map to more than one distinct
 * canonical_hash within a workspace (cross-provider divergence recorded in the
 * registry). On-disk copy hashing that MARKS a lesson `conflict` is WP-F1/WP-F2's
 * job; this reads only the durable registry.
 */
export function lessonDrift(ws: string): Array<{ name: string; hashes: string[] }> {
  const byName = new Map<string, Set<string>>();
  for (const l of listLessons(ws)) {
    if (!l.canonicalHash) continue;
    const set = byName.get(l.name) ?? new Set<string>();
    set.add(l.canonicalHash);
    byName.set(l.name, set);
  }
  const out: Array<{ name: string; hashes: string[] }> = [];
  for (const [name, hashes] of byName) {
    if (hashes.size > 1) out.push({ name, hashes: [...hashes] });
  }
  return out;
}

// ── Lesson batches ─────────────────────────────────────────────────────────────
export function createLessonBatch(ws: string, batchId: string, snapshotId: string | null, nowISO: string): void {
  getDb()
    .prepare(
      `INSERT INTO memory_lesson_batches (batch_id, workspace_id, snapshot_id, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT(batch_id) DO NOTHING`,
    )
    .run(batchId, ws, snapshotId, nowISO);
}

/** Flip the batch row and every lesson under it to `active` in one transaction. */
export function activateLessonBatch(batchId: string): void {
  const db = getDb();
  const tx = db.transaction((id: string) => {
    db.prepare(`UPDATE memory_lesson_batches SET status = 'active' WHERE batch_id = ?`).run(id);
    db.prepare(`UPDATE memory_lessons SET status = 'active' WHERE batch_id = ?`).run(id);
  });
  tx(batchId);
}

/** Mark the batch and its lessons `conflict` (durable rollback record). The
 *  hash-guarded filesystem unwind + optional row removal is WP-F2's orchestration;
 *  the store never hand-deletes so the batch's lesson rows survive as receipts. */
export function rollbackLessonBatch(batchId: string): void {
  const db = getDb();
  const tx = db.transaction((id: string) => {
    db.prepare(`UPDATE memory_lesson_batches SET status = 'conflict' WHERE batch_id = ?`).run(id);
    db.prepare(`UPDATE memory_lessons SET status = 'conflict' WHERE batch_id = ?`).run(id);
  });
  tx(batchId);
}

export interface LessonBatchRow {
  batchId: string;
  workspaceId: string;
  snapshotId: string | null;
  status: string;
  createdAt: string;
}

/** All batches for a workspace, optionally filtered by status. Used by WP-F2's
 *  launch recovery to enumerate `pending` batches to complete/roll back. */
export function listLessonBatches(ws: string, status?: string): LessonBatchRow[] {
  const db = getDb();
  const rows = status
    ? db.prepare(`SELECT * FROM memory_lesson_batches WHERE workspace_id = ? AND status = ?`).all(ws, status)
    : db.prepare(`SELECT * FROM memory_lesson_batches WHERE workspace_id = ?`).all(ws);
  return (rows as Record<string, unknown>[]).map((r) => ({
    batchId: String(r.batch_id),
    workspaceId: String(r.workspace_id),
    snapshotId: str(r.snapshot_id),
    status: String(r.status),
    createdAt: String(r.created_at),
  }));
}

/** Every lesson row under a batch (all statuses). WP-F2 reconstructs a batch's
 *  rollback receipts from these rows + their `copies_json`. */
export function listLessonsByBatch(batchId: string): LessonRow[] {
  const rows = getDb().prepare(`SELECT * FROM memory_lessons WHERE batch_id = ?`).all(batchId);
  return (rows as Record<string, unknown>[]).map(rowToLesson);
}

/** Set ONLY the batch row's status (no lesson-row change). WP-F2 marks a batch
 *  `conflict` after it has separately removed the batch's lesson rows. */
export function setLessonBatchStatus(batchId: string, status: string): void {
  getDb().prepare(`UPDATE memory_lesson_batches SET status = ? WHERE batch_id = ?`).run(status, batchId);
}

/** Remove every `memory_lessons` row a batch created (WP-F2 conflict rollback:
 *  a batch is all-or-nothing, so a rolled-back batch leaves NO lesson rows —
 *  unlike a single `publish_lesson` conflict, whose one row survives as a
 *  standalone review signal). Receipts are reconstructed BEFORE this call. */
export function removeBatchLessons(batchId: string): void {
  getDb().prepare(`DELETE FROM memory_lessons WHERE batch_id = ?`).run(batchId);
}

export function getLessonBatch(batchId: string): { batchId: string; workspaceId: string; snapshotId: string | null; status: string; createdAt: string } | null {
  const r = getDb().prepare(`SELECT * FROM memory_lesson_batches WHERE batch_id = ?`).get(batchId) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    batchId: String(r.batch_id),
    workspaceId: String(r.workspace_id),
    snapshotId: str(r.snapshot_id),
    status: String(r.status),
    createdAt: String(r.created_at),
  };
}

// ── Graduation proposals ─────────────────────────────────────────────────────
export interface GraduationInput {
  proposalId: string;
  target: string;
  targetHashAtProposal: string | null;
  text: string;
  rationale: string;
  sourceAgent: string | null;
}

export interface GraduationRow {
  proposalId: string;
  workspaceId: string;
  target: string;
  targetHashAtProposal: string | null;
  text: string | null;
  rationale: string | null;
  sourceAgent: string | null;
  status: string;
}

export function recordGraduation(ws: string, input: GraduationInput): { proposalId: string; status: string } {
  getDb()
    .prepare(
      `INSERT INTO graduation_proposals
         (proposal_id, workspace_id, target, target_hash_at_proposal, text, rationale, source_agent, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      input.proposalId,
      ws,
      input.target,
      input.targetHashAtProposal,
      input.text,
      input.rationale,
      input.sourceAgent,
    );
  return { proposalId: input.proposalId, status: 'pending' };
}

export function listGraduations(ws: string, status?: string): GraduationRow[] {
  const db = getDb();
  const rows = status
    ? db.prepare(`SELECT * FROM graduation_proposals WHERE workspace_id = ? AND status = ?`).all(ws, status)
    : db.prepare(`SELECT * FROM graduation_proposals WHERE workspace_id = ?`).all(ws);
  return (rows as Record<string, unknown>[]).map((r) => ({
    proposalId: String(r.proposal_id),
    workspaceId: String(r.workspace_id),
    target: String(r.target),
    targetHashAtProposal: str(r.target_hash_at_proposal),
    text: str(r.text),
    rationale: str(r.rationale),
    sourceAgent: str(r.source_agent),
    status: String(r.status),
  }));
}

export function setGraduationStatus(proposalId: string, status: string): void {
  getDb().prepare(`UPDATE graduation_proposals SET status = ? WHERE proposal_id = ?`).run(status, proposalId);
}

/** Read a single graduation proposal by id (WP-H3 apply reads the row it is about
 *  to CAS-check + apply). Returns null when the id is unknown. */
export function getGraduation(proposalId: string): GraduationRow | null {
  const r = getDb()
    .prepare(`SELECT * FROM graduation_proposals WHERE proposal_id = ?`)
    .get(proposalId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    proposalId: String(r.proposal_id),
    workspaceId: String(r.workspace_id),
    target: String(r.target),
    targetHashAtProposal: str(r.target_hash_at_proposal),
    text: str(r.text),
    rationale: str(r.rationale),
    sourceAgent: str(r.source_agent),
    status: String(r.status),
  };
}

/** WP-H3 apply CAS mismatch: the live target changed since the proposal was
 *  authored (a concurrent graduation applied first, or the human edited the doc).
 *  Transition the proposal to `needs-reapproval` AND surface the new current hash
 *  by storing it in `target_hash_at_proposal`, so a subsequent human re-approval
 *  CAS-checks against the CURRENT bytes (the "second re-approves against the
 *  first's resulting hash" serialization rule). No filesystem write occurs. */
export function markGraduationNeedsReapproval(proposalId: string, currentHash: string): void {
  getDb()
    .prepare(
      `UPDATE graduation_proposals SET status = 'needs-reapproval', target_hash_at_proposal = ? WHERE proposal_id = ?`,
    )
    .run(currentHash, proposalId);
}

// ── Migration approvals ──────────────────────────────────────────────────────
export function recordMigrationApproval(
  ws: string,
  snapshotId: string,
  tableHash: string,
  approvedBy: string,
  approvedAt: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO migration_approvals (workspace_id, snapshot_id, table_hash, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, snapshot_id) DO UPDATE SET
         table_hash = excluded.table_hash,
         approved_by = excluded.approved_by,
         approved_at = excluded.approved_at`,
    )
    .run(ws, snapshotId, tableHash, approvedBy, approvedAt);
}

export function getMigrationApproval(
  ws: string,
  snapshotId: string,
): { workspaceId: string; snapshotId: string; tableHash: string | null; approvedBy: string | null; approvedAt: string | null } | null {
  const r = getDb()
    .prepare(`SELECT * FROM migration_approvals WHERE workspace_id = ? AND snapshot_id = ?`)
    .get(ws, snapshotId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    workspaceId: String(r.workspace_id),
    snapshotId: String(r.snapshot_id),
    tableHash: str(r.table_hash),
    approvedBy: str(r.approved_by),
    approvedAt: str(r.approved_at),
  };
}

// ── Index state (last-known-good source + runtime-error state) ────────────────
export interface IndexStateRow {
  workspaceId: string;
  sourceText: string | null;
  sourceHash: string | null;
  parsedJson: string | null;
  validatedAt: string | null;
  lastRuntimeError: string | null;
  lastRuntimeErrorAt: string | null;
}

export function getIndexState(ws: string): IndexStateRow | null {
  const r = getDb().prepare(`SELECT * FROM memory_index_state WHERE workspace_id = ?`).get(ws) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    workspaceId: String(r.workspace_id),
    sourceText: str(r.source_text),
    sourceHash: str(r.source_hash),
    parsedJson: str(r.parsed_json),
    validatedAt: str(r.validated_at),
    lastRuntimeError: str(r.last_runtime_error),
    lastRuntimeErrorAt: str(r.last_runtime_error_at),
  };
}

/** Persist the last-known-good SOURCE. A valid write CLEARS any prior
 *  last_runtime_error (a good parse retires the stale error state). */
export function putIndexState(
  ws: string,
  state: { sourceText: string; sourceHash: string; parsedJson: string; validatedAt: string },
): void {
  getDb()
    .prepare(
      `INSERT INTO memory_index_state
         (workspace_id, source_text, source_hash, parsed_json, validated_at, last_runtime_error, last_runtime_error_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(workspace_id) DO UPDATE SET
         source_text = excluded.source_text,
         source_hash = excluded.source_hash,
         parsed_json = excluded.parsed_json,
         validated_at = excluded.validated_at,
         last_runtime_error = NULL,
         last_runtime_error_at = NULL`,
    )
    .run(ws, state.sourceText, state.sourceHash, state.parsedJson, state.validatedAt);
}

/** Record a durable runtime (parse/read threw) error WITHOUT touching the
 *  last-known-good source. Upserts so a first-ever error still records. */
export function putRuntimeError(ws: string, error: string, nowISO: string): void {
  getDb()
    .prepare(
      `INSERT INTO memory_index_state (workspace_id, last_runtime_error, last_runtime_error_at)
       VALUES (?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         last_runtime_error = excluded.last_runtime_error,
         last_runtime_error_at = excluded.last_runtime_error_at`,
    )
    .run(ws, error, nowISO);
}

// ── Lesson-firing evidence (coverage guard for never-fired) ────────────────────
export interface LessonEvidence {
  /** The Claude `.claude/projects` corpus is fully ingested at the current
   *  parser_version (backfill complete + version match). */
  corpusComplete: boolean;
  /** At least one skill_invocation reliably attributes to THIS workspace via the
   *  agents-join (not a mere slug proxy). */
  attributionReliable: boolean;
  /** skill_name values observed firing for this workspace (reliable attribution). */
  firedLessonNames: Set<string>;
}

function metaGet(db: ReturnType<typeof getDb>, key: string): string | null {
  const r = db.prepare(`SELECT v FROM skill_analytics_meta WHERE k = ?`).get(key) as { v: unknown } | undefined;
  return r ? String(r.v) : null;
}

// Authoritative workspace attribution: skill_invocations.session_id →
// (MIN dashboard_agent_id per session) → agents.workspace_id. Mirrors the vetted
// SKILL_JOINS/WORKSPACE_SCOPE_EXPR in skill-analytics/queries.ts.
const ATTRIBUTED_JOIN = `FROM skill_invocations si
  LEFT JOIN (SELECT session_id, MIN(dashboard_agent_id) AS aid FROM agent_sessions GROUP BY session_id) asx
    ON asx.session_id = si.session_id
  LEFT JOIN agents ag ON ag.id = asx.aid`;

/**
 * Assess lesson-firing evidence from the live skill-analytics foundation. The
 * coverage guard is conservative: a corpus that is not fully ingested at the
 * current parser_version, or a workspace with no reliably-attributed invocation,
 * yields `corpusComplete=false` / `attributionReliable=false` — reconciliation
 * then emits `evidence-unavailable` rather than a false `never-fired`.
 */
export function assessLessonEvidence(ws: string): LessonEvidence {
  const db = getDb();
  const completeAt = metaGet(db, BACKFILL_COMPLETE_KEY);
  const ver = metaGet(db, BACKFILL_VERSION_KEY);
  const corpusComplete = completeAt != null && Number(ver) === PARSER_VERSION;

  const attrRow = db
    .prepare(`SELECT COUNT(*) AS n ${ATTRIBUTED_JOIN} WHERE ag.workspace_id = ?`)
    .get(ws) as { n: unknown } | undefined;
  const attributionReliable = num(attrRow?.n) > 0;

  const rows = db
    .prepare(`SELECT DISTINCT si.skill_name AS skill ${ATTRIBUTED_JOIN} WHERE ag.workspace_id = ?`)
    .all(ws) as Array<{ skill: unknown }>;
  const firedLessonNames = new Set(rows.map((r) => String(r.skill)));

  return { corpusComplete, attributionReliable, firedLessonNames };
}

// ── Reconciliation producer ────────────────────────────────────────────────────
const NEVER_RECALLED_REASON = 'never recalled via `recall_memory`; raw-file reads are unobserved.';
const EVIDENCE_UNAVAILABLE_REASON =
  "no matching invocation observed in Claude's `.claude/projects` corpus (the parser ingests only that corpus; attribution and index completeness are not guaranteed).";
const NEVER_FIRED_REASON = 'no matching skill invocation observed for this lesson.';

const CLOSED_STATUSES = new Set(['done', 'note', 'archived']);

/** ISO date (YYYY-MM-DD prefix) → epoch-day count; NaN if unparseable. */
function epochDay(dateStr: string): number {
  const ms = Date.parse(dateStr.slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 86400000);
}

export interface ReconcileOptions {
  /** Inject lesson-firing evidence (launch path passes this; defaults to a live
   *  `assessLessonEvidence(ws)`). */
  evidence?: LessonEvidence;
  /** finding_ids the caller already upserted this pass (advisory/hard from WP-C)
   *  so this reconciliation does not clear them. */
  keepExternalIds?: string[];
}

export interface ReconcileResult {
  findings: FindingInput[];
  findingIds: string[];
}

/**
 * Produce + persist the evidence findings for one workspace against a VALID
 * parsed index, then transition absent findings to `cleared` (history preserved).
 * The caller (WP-C) runs this ONLY against a valid source.
 *
 * - `never-recalled`: closed entries ({done,note,archived}) with a `detail:`
 *   pointer, age > NEVER_RECALLED_MIN_AGE_DAYS, and recall count 0. Never active
 *   capsules (active state is inline + recall-free; `stale-active` covers those).
 * - `never-fired` / `evidence-unavailable`: guarded by the coverage check. When
 *   the corpus is incomplete OR attribution is an unreliable proxy, emit a single
 *   `evidence-unavailable` advisory and NO absence candidates; otherwise flag each
 *   active lesson with no observed firing.
 * - `cap-pressure`: emitted whenever bytes/lines exceed CAP_PRESSURE_RATIO,
 *   independently of any stale-active candidate.
 */
export function reconcileMemoryEvidence(
  ws: string,
  parsed: ParsedIndex,
  nowISO: string,
  opts: ReconcileOptions = {},
): ReconcileResult {
  const indexHash = sha256Hex(parsed.raw);
  const todayDay = epochDay(nowISO);
  const counts = recallMap(ws);
  const findings: FindingInput[] = [];

  // never-recalled — aged, closed, pointer-bearing entries never recalled.
  for (const e of parsed.entries) {
    if (!CLOSED_STATUSES.has(e.status)) continue;
    if (!e.detail) continue;
    if (!e.date) continue;
    const dd = epochDay(e.date);
    if (Number.isNaN(dd) || Number.isNaN(todayDay)) continue;
    if (todayDay - dd <= NEVER_RECALLED_MIN_AGE_DAYS) continue;
    if ((counts.get(e.id) ?? 0) > 0) continue;
    findings.push({ kind: 'never-recalled', entryId: e.id, sourceHash: indexHash, reason: NEVER_RECALLED_REASON });
  }

  // never-fired / evidence-unavailable — coverage-guarded.
  const evidence = opts.evidence ?? assessLessonEvidence(ws);
  if (!evidence.corpusComplete || !evidence.attributionReliable) {
    findings.push({
      kind: 'evidence-unavailable',
      entryId: null,
      sourceHash: indexHash,
      reason: EVIDENCE_UNAVAILABLE_REASON,
    });
  } else {
    for (const lesson of listLessons(ws, 'active')) {
      if (!evidence.firedLessonNames.has(lesson.name)) {
        findings.push({
          kind: 'never-fired',
          entryId: lesson.lessonId,
          sourceHash: indexHash,
          reason: NEVER_FIRED_REASON,
        });
      }
    }
  }

  // cap-pressure — independent of stale-active candidates.
  if (
    parsed.byteLength / MEMORY_INDEX_BUDGET_BYTES > CAP_PRESSURE_RATIO ||
    parsed.lineCount / MEMORY_INDEX_BUDGET_LINES > CAP_PRESSURE_RATIO
  ) {
    findings.push({
      kind: 'cap-pressure',
      entryId: null,
      sourceHash: indexHash,
      reason: `index over ${Math.round(CAP_PRESSURE_RATIO * 100)}% of a budget`,
    });
  }

  const findingIds = upsertFindings(ws, findings, nowISO);
  clearFindings(ws, [...(opts.keepExternalIds ?? []), ...findingIds], nowISO);
  return { findings, findingIds };
}
