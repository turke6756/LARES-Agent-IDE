// retention.ts — dense-window retention + distill-before-prune + triggered
// loose-object maintenance + storage reporting (Git-Native WP-G3.3).
// MAIN-PROCESS ONLY. Scheduled from src/main/index.ts (via engine-bootstrap).
//
// The recovery product is checkpoint refs; refs pin objects, so an unbounded ref
// set grows the object store without bound. This WP thins that set — but under a
// HARD constraint (plan Open #6): **no hard cap and no ceiling/throttle of any
// kind ships here.** Only:
//   1. dense retention for a PROVISIONAL 10 days, then thinning to accepted-task
//      boundary snapshots (the AFTER edge of each accepted turn);
//   2. distill-before-prune (shape §2.10, MANDATORY): before ANY ref deletion,
//      back-fill `diff_stats` (witnessed + window) and the witnessed-path
//      `compact_diff` (≤100 KB, provenance='witnessed') onto the turn row;
//   3. a TRIGGERED, BOUNDED loose-object maintenance job (agenda §6) — run ONLY
//      when the key is idle AND the loose-object count exceeds the threshold,
//      under the MAINTENANCE (idle-only) queue slot, with a bounded deadline;
//      lock/failure is NONFATAL;
//   4. per-workspace storage reporting (metadata only — never diff bytes).
//
// LOAD-BEARING ORDERING (shape §7 G3 gate): a ref is NEVER deleted for a turn that
// has not first been distilled. `processTurn` awaits `distill` (which persists
// `diff_stats` + `compact_diff`) to completion BEFORE it calls `deleteRefPair`.
// If distillation cannot run (an edge's ref no longer live-verifies), the turn is
// left untouched — the before→after diff is already unrecoverable, so there is
// nothing to preserve and we refuse to delete the surviving ref anyway.
//
// NEVER `git gc --aggressive`; NEVER `git maintenance start` (it mutates config +
// registers a scheduler); NEVER pass `--prune`/an expiry override (so the default
// `gc.pruneExpire` is respected and reachable objects are never force-pruned).
// Unreachable objects are left to normal git maintenance.
//
// Every git touch + the store are injectable seams so the whole thing is testable
// with real git in temp repos plus deterministic fakes.

import {
  RETENTION_DENSE_WINDOW_MS,
  COMPACT_DIFF_MAX_BYTES,
  MAINTENANCE_LOOSE_OBJECT_THRESHOLD,
  MAINTENANCE_RUNTIME_DEADLINE_MS,
} from '../../shared/constants';
import type { TurnRecord } from '../database';
import {
  listTurnRecords as dbListTurnRecords,
  getTurnRecord as dbGetTurnRecord,
  updateTurnRecord as dbUpdateTurnRecord,
} from '../database';
import { runGit as realRunGit } from './git-command';
import type { RunGitLike } from './checkpoint-service';
import { CheckpointQueue, type SkippedDeadline } from './checkpoint-queue';
import { deleteRefPair, type RefDeletion, type ReconLogger } from './reconciler';

const DEFAULT_LOGGER: ReconLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

// ── store seam (default-bound to the WP-A0 accessors; tests inject a fake) ────────

/** The turn_records accessors retention needs. `updateTurnRecord` is the distill
 *  write target; `getTurnRecord` re-reads a row after distillation. */
export interface RetentionTurnStore {
  listTurnRecords(workspaceId: string, opts?: { agentId?: string }): TurnRecord[];
  getTurnRecord(id: string): TurnRecord | null;
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null;
}

const DEFAULT_TURN_STORE: RetentionTurnStore = {
  listTurnRecords: dbListTurnRecords,
  getTurnRecord: dbGetTurnRecord,
  updateTurnRecord: (id, updates) => dbUpdateTurnRecord(id, updates as never),
};

// ── shared deps ───────────────────────────────────────────────────────────────

export interface RetentionDeps {
  workspaceId: string;
  repoRoot: string;
  gitExe: string;
  /** The SHARED CheckpointQueue — the same instance the live engine uses, so the
   *  MAINTENANCE idle-only semantics apply against the real object-db key. */
  queue: CheckpointQueue;
  /** `capability.commonDirQueueKey` — the object-database serialization key. */
  commonDirQueueKey: string;
  runGit?: RunGitLike;
  turnStore?: RetentionTurnStore;
  now?: () => number;
  /** Dense-retention window (ms). Default `RETENTION_DENSE_WINDOW_MS` (10 days). */
  retentionMs?: number;
  /** Witnessed-path compact_diff byte cap. Default `COMPACT_DIFF_MAX_BYTES`. */
  compactDiffMaxBytes?: number;
  /** Loose-object trigger threshold. Default `MAINTENANCE_LOOSE_OBJECT_THRESHOLD`. */
  looseObjectThreshold?: number;
  /** Bounded `git maintenance run` runtime + MAINTENANCE-slot deadline (ms). */
  maintenanceRuntimeDeadlineMs?: number;
  platform?: NodeJS.Platform;
  logger?: ReconLogger;
}

// ── diff numstat ────────────────────────────────────────────────────────────────

export interface DiffNumstat {
  files: number;
  insertions: number;
  deletions: number;
  /** Files git reported as binary (`-` in the added/deleted columns). */
  binaryFiles: number;
}

const EMPTY_NUMSTAT: DiffNumstat = { files: 0, insertions: 0, deletions: 0, binaryFiles: 0 };

/** Parse `git diff --numstat` output — `<added>\t<deleted>\t<path>` per line, with
 *  `-` in the numeric columns for binary files. Path bytes are irrelevant to the
 *  aggregate, so this never depends on parsing (possibly odd) filenames. */
export function parseNumstat(stdout: string): DiffNumstat {
  const out: DiffNumstat = { files: 0, insertions: 0, deletions: 0, binaryFiles: 0 };
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const tab1 = line.indexOf('\t');
    if (tab1 < 0) continue;
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab2 < 0) continue;
    const added = line.slice(0, tab1);
    const deleted = line.slice(tab1 + 1, tab2);
    out.files++;
    if (added === '-' || deleted === '-') {
      out.binaryFiles++;
      continue;
    }
    out.insertions += Number(added) || 0;
    out.deletions += Number(deleted) || 0;
  }
  return out;
}

// ── count-objects ────────────────────────────────────────────────────────────────

export interface CountObjects {
  /** Loose (un-packed) object count — the maintenance trigger signal. */
  count: number;
  /** Loose object disk size (KiB, as git reports). */
  sizeKb: number;
  inPack: number;
  packs: number;
  sizePackKb: number;
  /** Any other `key: value` lines, verbatim, for diagnostics. */
  raw: Record<string, number>;
}

/** Parse `git count-objects -v` — one `key: value` per line. */
export function parseCountObjects(stdout: string): CountObjects {
  const raw: Record<string, number> = {};
  for (const line of stdout.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const val = Number(line.slice(colon + 1).trim());
    if (key.length > 0 && Number.isFinite(val)) raw[key] = val;
  }
  return {
    count: raw['count'] ?? 0,
    sizeKb: raw['size'] ?? 0,
    inPack: raw['in-pack'] ?? 0,
    packs: raw['packs'] ?? 0,
    sizePackKb: raw['size-pack'] ?? 0,
    raw,
  };
}

// ── prune decision (pure) ─────────────────────────────────────────────────────────

export interface PruneEdges {
  before: boolean;
  after: boolean;
}

const NO_PRUNE: PruneEdges = { before: false, after: false };

/**
 * Decide which edges of a turn are ELIGIBLE for pruning, from age + status alone
 * (pure — the live-ref check happens later). Dense inside the window; after the
 * window, thin to the accepted-task boundary snapshot (keep only the AFTER edge of
 * accepted turns, prune both edges of every other terminal turn). An `open` turn or
 * a turn with no timestamp is never eligible.
 */
export function decidePruneEdges(row: TurnRecord, now: number, retentionMs: number): PruneEdges {
  if (row.status === 'open') return NO_PRUNE;
  const ts = row.endedAt ?? row.startedAt;
  if (ts == null) return NO_PRUNE;
  if (now - ts <= retentionMs) return NO_PRUNE; // dense window — keep every edge
  // Older than the dense window → thin.
  if (row.status === 'accepted') {
    // Keep the AFTER edge as the accepted-task boundary snapshot; prune BEFORE.
    return { before: true, after: false };
  }
  // Non-accepted terminal turns carry no boundary snapshot → prune both edges.
  return { before: true, after: true };
}

// ── per-turn outcome ──────────────────────────────────────────────────────────────

export type TurnRetentionAction =
  | 'kept' // inside the dense window / not eligible
  | 'already-pruned' // eligible but the targeted edge(s) already gone
  | 'distill-unavailable' // an edge no longer live-verifies → distill impossible → NOT pruned
  | 'pruned' // distilled then refs deleted
  | 'delete-failed'; // distilled but the atomic delete failed (nonfatal; retried next cycle)

export interface TurnRetentionOutcome {
  turnId: string;
  action: TurnRetentionAction;
  prunedBefore?: boolean;
  prunedAfter?: boolean;
  detail?: string;
}

// ── the retention pass (distill-before-prune) ─────────────────────────────────────

export interface RetentionPassResult {
  outcomes: TurnRetentionOutcome[];
  distilled: number;
  prunedTurns: number;
  deleteFailures: number;
}

/**
 * Distill-before-prune over every turn row for one workspace. Ordering is the
 * load-bearing guarantee: a ref is deleted ONLY after `diff_stats` + `compact_diff`
 * are persisted (shape §7 G3). Best-effort + isolated per turn — one turn's failure
 * never aborts the pass.
 */
export async function runRetentionPass(deps: RetentionDeps): Promise<RetentionPassResult> {
  const cfg = resolveConfig(deps);
  const result: RetentionPassResult = { outcomes: [], distilled: 0, prunedTurns: 0, deleteFailures: 0 };

  for (const row of cfg.turnStore.listTurnRecords(deps.workspaceId)) {
    let outcome: TurnRetentionOutcome;
    try {
      outcome = await processTurn(cfg, row);
    } catch (err) {
      outcome = { turnId: row.id, action: 'delete-failed', detail: describeError(err) };
    }
    result.outcomes.push(outcome);
    if (outcome.action === 'pruned') {
      result.prunedTurns++;
      result.distilled++;
    } else if (outcome.action === 'delete-failed') {
      result.deleteFailures++;
    }
  }
  return result;
}

interface ResolvedConfig {
  workspaceId: string;
  repoRoot: string;
  gitExe: string;
  queue: CheckpointQueue;
  key: string;
  runGit: RunGitLike;
  turnStore: RetentionTurnStore;
  now: () => number;
  retentionMs: number;
  compactDiffMaxBytes: number;
  looseObjectThreshold: number;
  maintenanceRuntimeDeadlineMs: number;
  platform: NodeJS.Platform;
  log: ReconLogger;
}

function resolveConfig(deps: RetentionDeps): ResolvedConfig {
  return {
    workspaceId: deps.workspaceId,
    repoRoot: deps.repoRoot,
    gitExe: deps.gitExe,
    queue: deps.queue,
    key: deps.commonDirQueueKey,
    runGit: deps.runGit ?? realRunGit,
    turnStore: deps.turnStore ?? DEFAULT_TURN_STORE,
    now: deps.now ?? Date.now,
    retentionMs: deps.retentionMs ?? RETENTION_DENSE_WINDOW_MS,
    compactDiffMaxBytes: deps.compactDiffMaxBytes ?? COMPACT_DIFF_MAX_BYTES,
    looseObjectThreshold: deps.looseObjectThreshold ?? MAINTENANCE_LOOSE_OBJECT_THRESHOLD,
    maintenanceRuntimeDeadlineMs: deps.maintenanceRuntimeDeadlineMs ?? MAINTENANCE_RUNTIME_DEADLINE_MS,
    platform: deps.platform ?? process.platform,
    log: deps.logger ?? DEFAULT_LOGGER,
  };
}

async function processTurn(cfg: ResolvedConfig, row: TurnRecord): Promise<TurnRetentionOutcome> {
  const now = cfg.now();
  const decision = decidePruneEdges(row, now, cfg.retentionMs);
  if (!decision.before && !decision.after) return { turnId: row.id, action: 'kept' };

  // Which TARGETED edges are still live? A targeted-but-dead edge was pruned in a
  // prior cycle (or the user deleted the ref) — nothing to do for it.
  const beforeLive = decision.before && (await edgeUsable(cfg, row.beforeReady, row.beforeRef, row.beforeOid));
  const afterLive = decision.after && (await edgeUsable(cfg, row.afterReady, row.afterRef, row.afterOid));
  if (!beforeLive && !afterLive) return { turnId: row.id, action: 'already-pruned' };

  // DISTILL FIRST (mandatory). Skip only when this row is already distilled (a
  // prior cycle whose delete then failed) — the distillation is idempotent and its
  // bytes are unchanged. `distill` needs BOTH edges live to compute the before→after
  // diff; if it can't, we refuse to delete the surviving ref.
  const alreadyDistilled = row.compactDiff != null && row.diffStats != null;
  if (!alreadyDistilled) {
    const ok = await distill(cfg, row);
    if (!ok) return { turnId: row.id, action: 'distill-unavailable' };
  }

  // THEN delete the live targeted edge(s), paired + atomic (WP-G1.8 machinery).
  const deletions: RefDeletion[] = [];
  if (beforeLive && row.beforeRef) deletions.push({ ref: row.beforeRef, oldOid: row.beforeOid ?? undefined });
  if (afterLive && row.afterRef) deletions.push({ ref: row.afterRef, oldOid: row.afterOid ?? undefined });

  const del = await deleteRefPair({
    repoRoot: cfg.repoRoot,
    gitExe: cfg.gitExe,
    deletions,
    runGit: cfg.runGit,
  });
  if (!del.ok) {
    // A stale expected-OID / lock abort left every ref untouched — nonfatal, retried
    // next cycle (the row is already distilled, so no data is at risk).
    cfg.log.warn(`[retention] delete failed for turn ${row.id}: ${del.stderr}`);
    return { turnId: row.id, action: 'delete-failed', detail: del.stderr };
  }

  // Set the prune-timestamp hints AFTER a verified atomic delete (git rev-parse
  // remains the authority; these are only hints).
  const stamp: Record<string, unknown> = {};
  if (beforeLive) stamp.beforePrunedAt = now;
  if (afterLive) stamp.afterPrunedAt = now;
  cfg.turnStore.updateTurnRecord(row.id, stamp);

  return { turnId: row.id, action: 'pruned', prunedBefore: beforeLive, prunedAfter: afterLive };
}

/**
 * Back-fill `diff_stats` (witnessed + window) and the witnessed-path `compact_diff`
 * (bounded, provenance='witnessed') onto the turn row. Requires BOTH edges to
 * live-verify — returns false otherwise (the before→after diff is unrecoverable, so
 * there is nothing to distill). Never touches the window text (raw-window diff holds
 * unattributed bytes and is never persisted).
 */
async function distill(cfg: ResolvedConfig, row: TurnRecord): Promise<boolean> {
  const beforeUsable = await edgeUsable(cfg, row.beforeReady, row.beforeRef, row.beforeOid);
  const afterUsable = await edgeUsable(cfg, row.afterReady, row.afterRef, row.afterOid);
  if (!beforeUsable || !afterUsable) return false;

  const beforeOid = row.beforeOid as string;
  const afterOid = row.afterOid as string;
  const witnessedPaths = dedupe(
    (row.touched ?? []).filter((e) => e.op === 'write' || e.op === 'create').map((e) => e.path),
  );

  const witnessed =
    witnessedPaths.length > 0
      ? parseNumstat((await diffNumstat(cfg, beforeOid, afterOid, witnessedPaths)).stdout)
      : { ...EMPTY_NUMSTAT };
  const window = parseNumstat((await diffNumstat(cfg, beforeOid, afterOid, null)).stdout);

  const rawCompact =
    witnessedPaths.length > 0 ? (await diffText(cfg, beforeOid, afterOid, witnessedPaths)).stdout : '';
  const { text: compactDiff, truncated } = capUtf8(rawCompact, cfg.compactDiffMaxBytes);

  cfg.turnStore.updateTurnRecord(row.id, {
    diffStats: { witnessed, window, compactDiffTruncated: truncated },
    compactDiff,
    compactDiffProvenance: 'witnessed',
  });
  return true;
}

// ── loose-object maintenance (triggered, bounded, idle-only) ──────────────────────

export interface MaintenanceOutcome {
  ran: boolean;
  reason: 'below-threshold' | 'not-idle' | 'ok' | 'git-nonzero' | 'git-error';
  looseCount: number;
  threshold: number;
  code?: number;
  detail?: string;
}

/**
 * TRIGGERED loose-object packing (agenda §6). Counts loose objects; if the count is
 * over the threshold, enqueues `git maintenance run --task=loose-objects` at the
 * MAINTENANCE (idle-only) priority with a bounded deadline. The queue only ever runs
 * a MAINTENANCE item when the key is otherwise idle, and the bounded deadline expires
 * the item (→ `not-idle`, nonfatal) if the key never quiesces. A lock/timeout/nonzero
 * exit is likewise NONFATAL — logged and retried next cycle. NEVER aggressive GC,
 * NEVER `maintenance start`, NEVER an expiry override (so `gc.pruneExpire` is honored).
 */
export async function runLooseObjectMaintenance(deps: RetentionDeps): Promise<MaintenanceOutcome> {
  const cfg = resolveConfig(deps);
  const threshold = cfg.looseObjectThreshold;

  let counts: CountObjects;
  try {
    counts = parseCountObjects((await countObjectsRun(cfg)).stdout);
  } catch (err) {
    return { ran: false, reason: 'git-error', looseCount: 0, threshold, detail: describeError(err) };
  }
  if (counts.count <= threshold) {
    return { ran: false, reason: 'below-threshold', looseCount: counts.count, threshold };
  }

  const deadlineAt = cfg.now() + cfg.maintenanceRuntimeDeadlineMs;
  const settled = await cfg.queue.withPriority(
    cfg.key,
    { priority: 'MAINTENANCE', deadlineAt },
    async () => {
      try {
        // Bounded runtime; allowNonzero so a benign nonzero resolves rather than
        // throws. `--task=loose-objects` only — no incremental-repack (needs
        // justification per the plan), no --prune override.
        const r = await cfg.runGit(cfg.repoRoot, ['maintenance', 'run', '--task=loose-objects'], {
          gitExe: cfg.gitExe,
          timeoutMs: cfg.maintenanceRuntimeDeadlineMs,
          maxBytes: 1 << 20,
          allowNonzero: true,
        });
        return { ok: r.code === 0, code: r.code, stderr: r.stderr } as const;
      } catch (err) {
        // timeout/deadline/lock/spawn all reject — nonfatal here.
        return { ok: false, code: -1, stderr: describeError(err) } as const;
      }
    },
  );

  if (isSkippedDeadline(settled)) {
    // The MAINTENANCE item expired before the key went idle — retry next cycle.
    return { ran: false, reason: 'not-idle', looseCount: counts.count, threshold };
  }
  if (!settled.ok) {
    cfg.log.warn(
      `[retention] loose-object maintenance non-fatal failure (code ${settled.code}): ${settled.stderr}`,
    );
    return {
      ran: false,
      reason: 'git-nonzero',
      looseCount: counts.count,
      threshold,
      code: settled.code,
      detail: settled.stderr,
    };
  }
  return { ran: true, reason: 'ok', looseCount: counts.count, threshold };
}

// ── storage reporting (metadata only — never diff bytes) ──────────────────────────

export interface StorageReport {
  workspaceId: string;
  /** Loose objects — the maintenance trigger signal. */
  looseObjectCount: number;
  looseSizeKb: number;
  inPackObjects: number;
  packs: number;
  sizePackKb: number;
  /** Total tracked turn rows for the workspace. */
  turnRecords: number;
  /** Turns with at least one pruned edge (a `*_pruned_at` hint set). */
  prunedTurns: number;
  /** Turns whose before edge still claims ready (a live ref pinning objects). */
  liveBeforeEdges: number;
  liveAfterEdges: number;
}

/**
 * Per-workspace checkpoint object-store growth report. METADATA ONLY: object counts,
 * sizes, and turn-row tallies. It NEVER carries `compact_diff`, `touched`, or
 * `before_filtered_paths` (cross-cutting invariant §7 — those hold raw workspace
 * bytes / path lists and stay local, excluded from telemetry/exports by default;
 * `database.exportTurnRecords` enforces the same exclusion for the row export path).
 */
export async function reportStorage(deps: RetentionDeps): Promise<StorageReport> {
  const cfg = resolveConfig(deps);
  const counts = parseCountObjects((await countObjectsRun(cfg)).stdout);
  const rows = cfg.turnStore.listTurnRecords(deps.workspaceId);
  let prunedTurns = 0;
  let liveBeforeEdges = 0;
  let liveAfterEdges = 0;
  for (const r of rows) {
    if (r.beforePrunedAt != null || r.afterPrunedAt != null) prunedTurns++;
    if (r.beforeReady && r.beforePrunedAt == null) liveBeforeEdges++;
    if (r.afterReady && r.afterPrunedAt == null) liveAfterEdges++;
  }
  return {
    workspaceId: deps.workspaceId,
    looseObjectCount: counts.count,
    looseSizeKb: counts.sizeKb,
    inPackObjects: counts.inPack,
    packs: counts.packs,
    sizePackKb: counts.sizePackKb,
    turnRecords: rows.length,
    prunedTurns,
    liveBeforeEdges,
    liveAfterEdges,
  };
}

// ── the full per-workspace cycle ──────────────────────────────────────────────────

export interface WorkspaceRetentionResult {
  workspaceId: string;
  retention: RetentionPassResult;
  maintenance: MaintenanceOutcome;
  storage: StorageReport;
}

/**
 * One workspace's full retention cycle: distill-before-prune → triggered
 * loose-object maintenance → storage report. Order matters — pruning first drops
 * refs (freeing objects to become loose/unreachable) so the maintenance trigger and
 * the storage report see the post-prune state.
 */
export async function runWorkspaceRetention(deps: RetentionDeps): Promise<WorkspaceRetentionResult> {
  const retention = await runRetentionPass(deps);
  const maintenance = await runLooseObjectMaintenance(deps);
  const storage = await reportStorage(deps);
  return { workspaceId: deps.workspaceId, retention, maintenance, storage };
}

// ── git helpers ───────────────────────────────────────────────────────────────

function longpaths(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
}

function countObjectsRun(cfg: ResolvedConfig): ReturnType<RunGitLike> {
  return cfg.runGit(cfg.repoRoot, ['count-objects', '-v'], {
    gitExe: cfg.gitExe,
    maxBytes: 1 << 20,
    timeoutMs: 15_000,
    allowNonzero: true,
  });
}

/** `git --no-pager diff --numstat --no-ext-diff --no-textconv <b> <a> [-- paths]`. */
function diffNumstat(
  cfg: ResolvedConfig,
  beforeOid: string,
  afterOid: string,
  paths: string[] | null,
): ReturnType<RunGitLike> {
  const args = [
    '--no-pager',
    ...longpaths(cfg.platform),
    'diff',
    '--numstat',
    '--no-ext-diff',
    '--no-textconv',
    beforeOid,
    afterOid,
  ];
  if (paths && paths.length > 0) args.push('--', ...paths);
  return cfg.runGit(cfg.repoRoot, args, { gitExe: cfg.gitExe, maxBytes: 32 << 20, timeoutMs: 30_000 });
}

/** `git --no-pager diff --no-ext-diff --no-textconv <b> <a> [-- paths]` (patch text). */
function diffText(
  cfg: ResolvedConfig,
  beforeOid: string,
  afterOid: string,
  paths: string[] | null,
): ReturnType<RunGitLike> {
  const args = [
    '--no-pager',
    ...longpaths(cfg.platform),
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    beforeOid,
    afterOid,
  ];
  if (paths && paths.length > 0) args.push('--', ...paths);
  return cfg.runGit(cfg.repoRoot, args, { gitExe: cfg.gitExe, maxBytes: 64 << 20, timeoutMs: 30_000 });
}

/** An edge is usable ONLY when ready=1 AND the stored ref lives + resolves to the
 *  stored OID right now (the DB `*_ready`/`*_pruned_at` flags are hints, never
 *  authority — mirrors CheckpointService.isEdgeUsable). */
async function edgeUsable(
  cfg: ResolvedConfig,
  ready: boolean,
  ref: string | null,
  oid: string | null,
): Promise<boolean> {
  if (!ready || !ref || !oid) return false;
  try {
    const res = await cfg.runGit(cfg.repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], {
      gitExe: cfg.gitExe,
      allowNonzero: true,
      timeoutMs: 10_000,
      maxBytes: 1 << 20,
    });
    return res.code === 0 && res.stdout.trim() === oid;
  } catch {
    return false;
  }
}

// ── small utilities ───────────────────────────────────────────────────────────

/** Truncate a string to at most `maxBytes` UTF-8 bytes on a char boundary, appending
 *  a plain-ASCII marker when truncated. Uses only printable ASCII + newlines — never
 *  embeds a raw control byte. */
export function capUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const marker = '\n[... compact_diff truncated at cap ...]\n';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  // Walk back from a byte-budget slice to the nearest char boundary.
  let end = Math.min(text.length, budget);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > budget) end--;
  return { text: text.slice(0, end) + marker, truncated: true };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function isSkippedDeadline(v: unknown): v is SkippedDeadline {
  return typeof v === 'object' && v !== null && (v as SkippedDeadline).skipped === 'deadline';
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}
