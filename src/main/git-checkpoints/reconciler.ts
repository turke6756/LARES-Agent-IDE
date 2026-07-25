// reconciler.ts — ref/DB crash-consistency reconciliation + temp-artifact sweeper
// (Git-Native WP-G1.8). MAIN-PROCESS ONLY.
//
// Git ref creation and the SQLite turn_records/recovery_operations writes cannot be
// one transaction, so a crash (or a finalize that overran its wall-clock deadline)
// can leave an edge PERSISTED-BUT-NON-READY: the candidate OID + deterministic ref
// name are recorded (`*_ready=0`) but the ref itself was never created/verified. The
// WP-G1.3b finalize persists candidate OIDs **only inside the durable finalize
// section**, which is exactly what makes reconciliation well-defined:
//   • a NON-READY edge that HAS a persisted candidate OID + ref → adoptable/creatable;
//   • a deadline-abandoned snapshot persists NO candidate → there is never a
//     degraded-but-adoptable edge, so "no candidate" is always left alone.
//
// For each non-ready edge (checkpoint before/after edges AND `recovery_operations.pre`)
// whose candidate was persisted, against the deterministic ref that finalize recorded:
//   • ref ABSENT              → create it from the persisted candidate with an
//                               expected-zero old OID, verify, mark ready;
//   • ref EXISTS == candidate → adopt it, mark ready;
//   • ref EXISTS != candidate → FAIL VISIBLY (log + record failure_reason); NEVER
//                               silently overwrite a ref pointing somewhere else.
//
// Startup does: reconcile edges → close dangling `open` turn rows as `crashed` (the
// close step is pluggable so it can go through TurnCoordinator.reconcileOpenTurns
// once G1.7 constructs a live coordinator; the boot path uses the store directly).
// It also runs the temp-artifact sweeper (a backstop for the async index cleanup in
// checkpoint-service). Every git touch and DB touch is an injected seam so the whole
// thing is testable with real git in temp repos plus deterministic fakes.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TEMP_INDEX_SWEEP_GRACE_MS } from '../../shared/constants';
import type { GitCapability } from '../../shared/types';
import type { RecoveryOperation, TurnRecord, TurnStatus } from '../database';
import {
  listTurnRecords as dbListTurnRecords,
  reconcileTurnRecord as dbReconcileTurnRecord,
  closeTurn as dbCloseTurn,
  listRecoveryOperations as dbListRecoveryOperations,
  updateRecoveryOperation as dbUpdateRecoveryOperation,
} from '../database';
import { probeWorkspaceGit } from '../git/git-runtime';
import { runGit as realRunGit } from './git-command';
import type { RunGitLike } from './checkpoint-service';

// ── logging seam ────────────────────────────────────────────────────────────────

export interface ReconLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const DEFAULT_LOGGER: ReconLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

// ── DB seams (default-bound to the WP-A0 accessors; tests inject fakes) ──────────

/** The turn_records accessors reconciliation needs. `reconcileTurnRecord` is the
 *  terminal-bypass writer (a persisted-non-ready edge routinely outlives its close). */
export interface ReconcilerTurnStore {
  listTurnRecords(workspaceId: string, opts?: { agentId?: string }): TurnRecord[];
  reconcileTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null;
  closeTurn(
    id: string,
    status: Exclude<TurnStatus, 'open'>,
    extra?: Record<string, unknown>,
    endedAt?: number | null,
  ): TurnRecord | null;
}

/** The recovery_operations accessors reconciliation needs. `updateRecoveryOperation`
 *  has no terminal guard, so the pre edge uses it directly. */
export interface ReconcilerRecoveryStore {
  listRecoveryOperations(workspaceId: string, opts?: { sourceTurnId?: string }): RecoveryOperation[];
  updateRecoveryOperation(id: string, updates: Record<string, unknown>): RecoveryOperation | null;
}

const DEFAULT_TURN_STORE: ReconcilerTurnStore = {
  listTurnRecords: dbListTurnRecords,
  reconcileTurnRecord: (id, updates) => dbReconcileTurnRecord(id, updates as never),
  closeTurn: (id, status, extra, endedAt) => dbCloseTurn(id, status, extra as never, endedAt),
};

const DEFAULT_RECOVERY_STORE: ReconcilerRecoveryStore = {
  listRecoveryOperations: dbListRecoveryOperations,
  updateRecoveryOperation: (id, updates) => dbUpdateRecoveryOperation(id, updates as never),
};

// ── ref reconciliation ────────────────────────────────────────────────────────

/** Outcome of reconciling ONE persisted-non-ready edge against its stored ref. */
type RefReconcileResult =
  | { kind: 'created' }
  | { kind: 'adopted' }
  /** ref exists (or was raced into existence) pointing somewhere other than the
   *  persisted candidate — a visible failure; never overwritten. */
  | { kind: 'conflict'; actual: string | null };

const GIT_PROBE_TIMEOUT_MS = 10_000;
/** Ref probes/writes emit at most one OID line; a small cap is plenty and keeps an
 *  unbounded git output un-bufferable (RunGitOptions.maxBytes is mandatory). */
const REF_OP_MAX_BYTES = 1 << 20;

/**
 * Reconcile a single (ref, candidateOid) edge. Pure w.r.t. the DB — the caller marks
 * ready / records the conflict. Uses ONLY create-only writes so a concurrent creation
 * can never be clobbered.
 */
async function reconcileRef(
  runGit: RunGitLike,
  repoRoot: string,
  gitExe: string,
  ref: string,
  oid: string,
): Promise<RefReconcileResult> {
  const verify = await runGit(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], {
    gitExe,
    allowNonzero: true,
    timeoutMs: GIT_PROBE_TIMEOUT_MS,
    maxBytes: REF_OP_MAX_BYTES,
  });
  if (verify.code === 0) {
    const actual = verify.stdout.trim();
    if (actual === oid) return { kind: 'adopted' };
    // EXISTS with an unexpected target → visible failure, no overwrite.
    return { kind: 'conflict', actual };
  }

  // ABSENT → create-only update-ref with an expected-zero old OID (so a racing writer
  // that created the ref between our probe and this write loses the create, never us).
  const zero = '0'.repeat(oid.length);
  await runGit(repoRoot, ['update-ref', ref, oid, zero], {
    gitExe,
    allowNonzero: true,
    timeoutMs: GIT_PROBE_TIMEOUT_MS,
    maxBytes: REF_OP_MAX_BYTES,
  });
  const after = await runGit(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], {
    gitExe,
    allowNonzero: true,
    timeoutMs: GIT_PROBE_TIMEOUT_MS,
    maxBytes: REF_OP_MAX_BYTES,
  });
  if (after.code === 0 && after.stdout.trim() === oid) return { kind: 'created' };
  // Create raced/failed and the ref now resolves elsewhere (or not at all) → visible.
  return { kind: 'conflict', actual: after.code === 0 ? after.stdout.trim() : null };
}

export interface RefConflict {
  ref: string;
  /** The persisted candidate OID we expected the ref to carry. */
  expected: string;
  /** What the ref actually resolves to (null when it still does not resolve). */
  actual: string | null;
  /** Which surface the conflict is on. */
  surface: 'turn-before' | 'turn-after' | 'recovery-pre';
  id: string;
}

export interface ReconcileEdgeSummary {
  /** Non-ready edges whose ref we created from the persisted candidate. */
  created: number;
  /** Non-ready edges whose already-present matching ref we adopted. */
  adopted: number;
  /** Edges left non-ready because the ref points at an unexpected target. */
  conflicts: RefConflict[];
}

export interface ReconcileRefsDeps {
  workspaceId: string;
  repoRoot: string;
  gitExe: string;
  runGit?: RunGitLike;
  turnStore?: ReconcilerTurnStore;
  recoveryStore?: ReconcilerRecoveryStore;
  logger?: ReconLogger;
}

/**
 * Reconcile every persisted-non-ready checkpoint edge + recovery `pre` edge for one
 * workspace. A ready edge, or a non-ready edge with NO persisted candidate (an
 * abandoned/degraded snapshot), is left untouched.
 */
export async function reconcileWorkspaceRefs(deps: ReconcileRefsDeps): Promise<ReconcileEdgeSummary> {
  const runGit = deps.runGit ?? realRunGit;
  const turnStore = deps.turnStore ?? DEFAULT_TURN_STORE;
  const recoveryStore = deps.recoveryStore ?? DEFAULT_RECOVERY_STORE;
  const log = deps.logger ?? DEFAULT_LOGGER;
  const { workspaceId, repoRoot, gitExe } = deps;
  const summary: ReconcileEdgeSummary = { created: 0, adopted: 0, conflicts: [] };

  const applyRef = async (
    surface: RefConflict['surface'],
    id: string,
    ref: string,
    oid: string,
    onReady: () => void,
    onConflict: (actual: string | null) => void,
  ): Promise<void> => {
    const r = await reconcileRef(runGit, repoRoot, gitExe, ref, oid);
    if (r.kind === 'created') {
      onReady();
      summary.created++;
    } else if (r.kind === 'adopted') {
      onReady();
      summary.adopted++;
    } else {
      log.error(
        `[checkpoint-reconcile] REF CONFLICT on ${ref} (${surface}): persisted candidate ` +
          `${oid} but ref resolves to ${r.actual ?? '<absent>'} — leaving NON-READY, not overwriting`,
      );
      onConflict(r.actual);
      summary.conflicts.push({ ref, expected: oid, actual: r.actual, surface, id });
    }
  };

  // Checkpoint edges (before + after) on every turn row for this workspace.
  for (const row of turnStore.listTurnRecords(workspaceId)) {
    if (!row.beforeReady && row.beforeOid && row.beforeRef) {
      await applyRef(
        'turn-before',
        row.id,
        row.beforeRef,
        row.beforeOid,
        () =>
          turnStore.reconcileTurnRecord(row.id, {
            beforeReady: true,
            ...(row.beforeQuality ? {} : { beforeQuality: 'reconciled' }),
          }),
        () => turnStore.reconcileTurnRecord(row.id, { failureReason: 'reconcile-ref-conflict:before' }),
      );
    }
    if (!row.afterReady && row.afterOid && row.afterRef) {
      await applyRef(
        'turn-after',
        row.id,
        row.afterRef,
        row.afterOid,
        () =>
          turnStore.reconcileTurnRecord(row.id, {
            afterReady: true,
            ...(row.afterQuality ? {} : { afterQuality: 'reconciled' }),
          }),
        () => turnStore.reconcileTurnRecord(row.id, { failureReason: 'reconcile-ref-conflict:after' }),
      );
    }
  }

  // Recovery `pre` safety edges.
  for (const op of recoveryStore.listRecoveryOperations(workspaceId)) {
    if (op.preReady || !op.preOid || !op.preRef) continue;
    await applyRef(
      'recovery-pre',
      op.id,
      op.preRef,
      op.preOid,
      () => recoveryStore.updateRecoveryOperation(op.id, { preReady: true }),
      () => recoveryStore.updateRecoveryOperation(op.id, { failureReason: 'reconcile-ref-conflict:pre' }),
    );
  }

  return summary;
}

// ── dangling open-turn close (boot path; pluggable through the coordinator seam) ─

export interface CloseDanglingDeps {
  workspaceId: string;
  turnStore?: ReconcilerTurnStore;
  now?: () => number;
}

/**
 * Close every dangling `open` turn row for the workspace as `crashed` (a process that
 * exited without closing its turn). Mirrors TurnCoordinator.reconcileOpenTurns for the
 * boot path where no live coordinator exists yet. Idempotent: `closeTurn` is a no-op
 * on a terminal row.
 */
export function closeDanglingOpenTurns(deps: CloseDanglingDeps): number {
  const turnStore = deps.turnStore ?? DEFAULT_TURN_STORE;
  const now = deps.now ?? Date.now;
  let closed = 0;
  for (const row of turnStore.listTurnRecords(deps.workspaceId)) {
    if (row.status !== 'open') continue;
    turnStore.closeTurn(row.id, 'crashed', { afterQuality: 'none' }, now());
    closed++;
  }
  return closed;
}

// ── the workspace startup pass: reconcile edges, then close dangling opens ───────

export interface ReconcileWorkspaceDeps extends ReconcileRefsDeps {
  now?: () => number;
  /** The close step. Defaults to {@link closeDanglingOpenTurns}; G1.7 passes a live
   *  TurnCoordinator.reconcileOpenTurns so the same seam runs through the coordinator. */
  closeOpenTurns?: (workspaceId: string) => number;
}

export interface ReconcileWorkspaceResult {
  refs: ReconcileEdgeSummary;
  closedOpen: number;
}

export async function reconcileWorkspace(deps: ReconcileWorkspaceDeps): Promise<ReconcileWorkspaceResult> {
  // Edges FIRST (marking ready is a terminal-bypass write), THEN close dangling opens.
  const refs = await reconcileWorkspaceRefs(deps);
  const closeFn =
    deps.closeOpenTurns ??
    ((workspaceId: string) =>
      closeDanglingOpenTurns({ workspaceId, turnStore: deps.turnStore, now: deps.now }));
  const closedOpen = closeFn(deps.workspaceId);
  return { refs, closedOpen };
}

// ── paired-ref deletion (retention mechanism; the scheduler itself is G3) ─────────

export interface RefDeletion {
  ref: string;
  /** Optional expected old OID — the delete only lands if the ref still points here. */
  oldOid?: string;
}

export interface RefDeletionResult {
  ok: boolean;
  code: number;
  stderr: string;
}

/**
 * Delete a batch of refs (typically a turn's before+after edge) in ONE atomic
 * `git update-ref --stdin` transaction: git locks every ref simultaneously and
 * applies all-or-nothing, so retention never leaves a half-pruned turn. Only the
 * MECHANISM lives here; the retention scheduler that decides what to prune is G3.
 */
export async function deleteRefPair(deps: {
  repoRoot: string;
  gitExe: string;
  deletions: RefDeletion[];
  runGit?: RunGitLike;
}): Promise<RefDeletionResult> {
  if (deps.deletions.length === 0) return { ok: true, code: 0, stderr: '' };
  const runGit = deps.runGit ?? realRunGit;
  // Our refs are base64url + '/' segments (WP-G1.3a) — no spaces/newlines — so the
  // plain newline `--stdin` grammar is safe.
  const stdin = deps.deletions
    .map((d) => `delete ${d.ref}${d.oldOid ? ` ${d.oldOid}` : ''}\n`)
    .join('');
  try {
    const res = await runGit(deps.repoRoot, ['update-ref', '--stdin'], {
      gitExe: deps.gitExe,
      stdin,
      allowNonzero: true,
      timeoutMs: 15_000,
      maxBytes: REF_OP_MAX_BYTES,
    });
    return { ok: res.code === 0, code: res.code, stderr: res.stderr };
  } catch (err) {
    // A stale expected old-OID surfaces as a "cannot lock ref" failure, which
    // git-command classifies as a lock rejection regardless of `allowNonzero`. That
    // is a legitimate all-or-nothing abort here (git left every ref untouched), NOT a
    // queue-contention retry signal — report it, never throw.
    return { ok: false, code: -1, stderr: describeError(err) };
  }
}

// ── temp-artifact sweeper ─────────────────────────────────────────────────────

/** UUID-named Lares temp index (and its `.lock`) as written by checkpoint-service:
 *  `lares-idx-<uuid>` / `lares-idx-<uuid>.lock`. Anchored so we can only ever match
 *  our OWN artifacts — never an unrelated temp file. */
const TEMP_ARTIFACT_RE =
  /^lares-idx-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.lock)?$/i;

/** The fs surface the sweeper needs — injectable so a fake can drive controlled
 *  mtimes + a delete failure without a real filesystem. */
export interface SweepFs {
  readdirSync(dir: string): string[];
  statSync(p: string): { mtimeMs: number };
  unlinkSync(p: string): void;
}

const REAL_SWEEP_FS: SweepFs = {
  readdirSync: (dir) => fs.readdirSync(dir),
  statSync: (p) => fs.statSync(p),
  unlinkSync: (p) => fs.unlinkSync(p),
};

export interface SweepDeps {
  /** OS-temp/Lares-owned dir. Defaults to os.tmpdir() (where checkpoint-service writes). */
  tmpDir?: string;
  graceMs?: number;
  now?: () => number;
  fsx?: SweepFs;
  logger?: ReconLogger;
}

export interface SweepSummary {
  deleted: string[];
  /** Matched but younger than the grace period — never deleted (may be a live op). */
  skippedFresh: string[];
  /** Matched but un-stat-able — skipped: we can't PROVE it is stale. */
  unreadable: string[];
  /** Matched + aged but the unlink threw — logged, not fatal. */
  failed: { name: string; reason: string }[];
}

/**
 * Startup sweep of aged, orphaned UUID-named temp indexes + their `.lock` files. It
 * NEVER deletes an artifact younger than `graceMs` (it may belong to a live op) and
 * NEVER removes a file it cannot prove is stale (stat failure → skip). A delete
 * failure is logged, not fatal.
 */
export function sweepTempArtifacts(deps: SweepDeps = {}): SweepSummary {
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const graceMs = deps.graceMs ?? TEMP_INDEX_SWEEP_GRACE_MS;
  const now = deps.now ?? Date.now;
  const fsx = deps.fsx ?? REAL_SWEEP_FS;
  const log = deps.logger ?? DEFAULT_LOGGER;
  const summary: SweepSummary = { deleted: [], skippedFresh: [], unreadable: [], failed: [] };

  let names: string[];
  try {
    names = fsx.readdirSync(tmpDir);
  } catch {
    // Temp dir unreadable/absent → nothing we can prove stale.
    return summary;
  }

  for (const name of names) {
    if (!TEMP_ARTIFACT_RE.test(name)) continue; // only ever our own artifacts
    const full = path.join(tmpDir, name);
    let mtimeMs: number;
    try {
      mtimeMs = fsx.statSync(full).mtimeMs;
    } catch {
      // Can't stat → can't prove stale → leave it.
      summary.unreadable.push(name);
      continue;
    }
    if (now() - mtimeMs <= graceMs) {
      // "older than grace" is strict: at or under the grace age it is never deleted
      // (it may still belong to a live op).
      summary.skippedFresh.push(name);
      continue;
    }
    try {
      fsx.unlinkSync(full);
      summary.deleted.push(name);
    } catch (err) {
      const reason = describeError(err);
      summary.failed.push({ name, reason });
      log.warn(`[checkpoint-sweep] could not delete aged temp artifact ${name}: ${reason}`);
    }
  }
  return summary;
}

// ── boot entry point (index.ts calls this) ───────────────────────────────────────

export interface StartupMaintenanceDeps {
  /** Registered workspaces (from getWorkspaces()). Each needs an id + a probe path. */
  workspaces?: { id: string; path: string; pathType?: string | null }[];
  runGit?: RunGitLike;
  /** Resolve a workspace directory → capability. Defaults to git-runtime's probe. */
  probeCapability?: (workspaceDir: string) => Promise<GitCapability>;
  /** Map a workspace → the `workspace_id` its turn rows were scoped by. Defaults to
   *  the workspace's DB id (the canonical workspace scope key). */
  workspaceIdOf?: (ws: { id: string; path: string }) => string;
  turnStore?: ReconcilerTurnStore;
  recoveryStore?: ReconcilerRecoveryStore;
  sweep?: SweepDeps;
  now?: () => number;
  logger?: ReconLogger;
  /** WP-G1.7 seam upgrade: the dangling-open close step. Defaults to
   *  {@link closeDanglingOpenTurns} (boot path, store-direct). The bootstrap passes
   *  a live `TurnCoordinator.reconcileOpenTurns` so the same close runs through the
   *  coordinator — reconciler.ts's documented open item. */
  closeOpenTurns?: (workspaceId: string) => number;
}

/**
 * Boot maintenance: the temp-artifact sweep (self-contained; always runs) + a
 * best-effort per-workspace ref/DB reconciliation. Never throws — every workspace is
 * isolated in its own try/catch and a git that cannot be resolved is simply skipped
 * (detect-and-degrade). The full engine wiring (which supplies the exact workspaceId
 * mapping + a live coordinator) lands with G1.7.
 */
export async function runCheckpointStartupMaintenance(deps: StartupMaintenanceDeps = {}): Promise<void> {
  const log = deps.logger ?? DEFAULT_LOGGER;

  // 1. Temp-artifact sweep — a backstop for checkpoint-service's async index cleanup.
  try {
    const s = sweepTempArtifacts({ ...(deps.sweep ?? {}), now: deps.now, logger: log });
    if (s.deleted.length || s.failed.length) {
      log.info(
        `[checkpoint-sweep] deleted ${s.deleted.length} aged artifact(s), ` +
          `kept ${s.skippedFresh.length} fresh, ${s.failed.length} delete failure(s)`,
      );
    }
  } catch (err) {
    log.warn(`[checkpoint-sweep] sweep failed: ${describeError(err)}`);
  }

  // 2. Per-workspace ref/DB reconciliation (best-effort, isolated, never fatal).
  const workspaces = deps.workspaces ?? [];
  const probe = deps.probeCapability ?? ((dir: string) => probeWorkspaceGit(dir));
  const idOf = deps.workspaceIdOf ?? ((ws) => ws.id);
  for (const ws of workspaces) {
    try {
      const cap = await probe(ws.path);
      const gitExe = cap.resolution.internal?.execPath;
      if (cap.reason !== 'ok' || !cap.repoRoot || !gitExe) continue; // detect-and-degrade
      const r = await reconcileWorkspace({
        workspaceId: idOf(ws),
        repoRoot: cap.repoRoot,
        gitExe,
        runGit: deps.runGit,
        turnStore: deps.turnStore,
        recoveryStore: deps.recoveryStore,
        now: deps.now,
        logger: log,
        closeOpenTurns: deps.closeOpenTurns,
      });
      if (r.refs.created || r.refs.adopted || r.refs.conflicts.length || r.closedOpen) {
        log.info(
          `[checkpoint-reconcile] ${ws.path}: created ${r.refs.created}, adopted ${r.refs.adopted}, ` +
            `conflicts ${r.refs.conflicts.length}, closed-open ${r.closedOpen}`,
        );
      }
    } catch (err) {
      log.warn(`[checkpoint-reconcile] ${ws.path} failed: ${describeError(err)}`);
    }
  }
}

// ── internals ────────────────────────────────────────────────────────────────

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}
