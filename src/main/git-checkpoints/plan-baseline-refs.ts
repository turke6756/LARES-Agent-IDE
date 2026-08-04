// Planning-surface WP-P5C — durable plan-execution baseline refs. MAIN-PROCESS ONLY.
//
// When a human pulls Implement on a structured plan (plan-implement.ts), the plan's
// execution BASELINE must be pinned durably. Storing the HEAD OID in SQLite alone is
// NOT enough: an unreferenced commit is a GC candidate, so a later `git gc` could
// prune the very commit the archived-mode review diff (WP-P7A-proj) is supposed to
// diff against. The durable pin is a Lares ref:
//
//   refs/lares/plans/<enc(planId)>/<enc(runId)>
//
// Each id component is base64url-encoded (WP-G1.3a idiom, shared with the checkpoint /
// finalization namespaces) so an arbitrary plan/run id can never introduce a `/`,
// `..`, `.lock`, `@{`, control, or whitespace that `git check-ref-format` rejects, and
// so a ref ROUND-TRIPS (encode→decode) for orphan reconciliation. `<runId>` is the
// reconciliation key: a ref whose decoded runId has NO `plan_execution_runs` row at
// all is an orphan (left by a DB-txn failure AFTER ref creation) and is swept on
// startup — an archived/inactive run still has a row, so it keeps its ref.
//
// Ref creation is a FORCE update to the pinned OID (`git update-ref <ref> <oid>`),
// idempotent because the (ref, oid) pair is a pure function of (planId, runId,
// headOid): a retry after a crash between ref creation and the SQLite txn re-creates
// the SAME ref at the SAME oid, never clobbering a foreign target. Ref RELEASE happens
// only under plan deletion (the sole normal release path) or orphan reconciliation.

import { encodeIdComponent, decodeIdComponent } from './ref-encoding';
import { deleteRefPair } from './reconciler';
import { runGit as realRunGit } from './git-command';
import type { RunGitLike } from './checkpoint-service';

export const PLAN_BASELINE_PREFIX = 'refs/lares/plans';

const GIT_TIMEOUT_MS = 10_000;
/** A ref probe/write emits at most one OID line; the enumerate cap is generous. */
const REF_OP_MAX_BYTES = 1 << 20;
const REF_LIST_MAX_BYTES = 32 << 20;
const OID_RE = /^[0-9a-f]{40,64}$/;

export interface PlanBaselineRefParts {
  planId: string;
  runId: string;
}

/** Assemble the durable baseline ref for a (planId, runId). Pure + deterministic;
 *  both ids MUST be non-empty. */
export function planBaselineRef(planId: string, runId: string): string {
  if (planId.length === 0) throw new Error('planBaselineRef planId must be non-empty');
  if (runId.length === 0) throw new Error('planBaselineRef runId must be non-empty');
  return `${PLAN_BASELINE_PREFIX}/${encodeIdComponent(planId)}/${encodeIdComponent(runId)}`;
}

/** Decode a baseline ref back to its parts, or null when it is not one (a
 *  hand-mangled ref never throws). */
export function parsePlanBaselineRef(ref: string): PlanBaselineRefParts | null {
  if (!ref.startsWith(`${PLAN_BASELINE_PREFIX}/`)) return null;
  const rest = ref.slice(PLAN_BASELINE_PREFIX.length + 1).split('/');
  if (rest.length !== 2) return null;
  const [planTok, runTok] = rest;
  const planId = decodeIdComponent(planTok);
  const runId = decodeIdComponent(runTok);
  if (planId === null || runId === null) return null;
  return { planId, runId };
}

export interface PlanBaselineGitDeps {
  repoRoot: string;
  gitExe?: string;
  runGit?: RunGitLike;
  deadlineAt?: number;
}

// ── repository / baseline probe ────────────────────────────────────────────────

/** The result of probing a workspace's repository for its execution baseline.
 *   • `head`      — a non-bare repo with commits; `headOid` is the pinned baseline.
 *   • `unborn`    — a non-bare repo with an unborn HEAD (no commits yet); no OID, no
 *                   ref (the run is stored with `baseline_kind='unborn'`).
 *   • `not-a-repo`/`bare-repo` — Implement is refused. */
export type PlanBaselineProbe =
  | { ok: true; kind: 'head'; headOid: string }
  | { ok: true; kind: 'unborn' }
  | { ok: false; reason: 'not-a-repo' | 'bare-repo' };

const PROBE_OPTS = (deps: PlanBaselineGitDeps) => ({
  gitExe: deps.gitExe,
  deadlineAt: deps.deadlineAt,
  allowNonzero: true,
  timeoutMs: GIT_TIMEOUT_MS,
  maxBytes: REF_OP_MAX_BYTES,
});

/**
 * Probe the repository at `repoRoot` for its execution baseline. Rejects a non-repo
 * and a bare repo (both have no worktree execution baseline to pin), distinguishes an
 * unborn HEAD (no commits) from a real HEAD, and returns the pinned HEAD OID for the
 * `head` case. Never throws — a git spawn failure degrades to `not-a-repo` so the
 * caller records a clean refusal rather than crashing.
 */
export async function probePlanBaseline(deps: PlanBaselineGitDeps): Promise<PlanBaselineProbe> {
  const runGit = deps.runGit ?? realRunGit;
  const opts = PROBE_OPTS(deps);
  try {
    // 1. Bare repos have no worktree baseline — reject before anything else.
    const bare = await runGit(deps.repoRoot, ['rev-parse', '--is-bare-repository'], opts);
    if (bare.code === 0 && bare.stdout.trim() === 'true') {
      return { ok: false, reason: 'bare-repo' };
    }
    // 2. Confirm this is a repo at all.
    const inside = await runGit(deps.repoRoot, ['rev-parse', '--is-inside-work-tree'], opts);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return { ok: false, reason: 'not-a-repo' };
    }
    // 3. HEAD: a resolvable HEAD → `head` baseline; a non-resolving HEAD in an
    //    otherwise-valid non-bare repo is an unborn branch (no commits yet).
    const head = await runGit(deps.repoRoot, ['rev-parse', '--verify', 'HEAD'], opts);
    const oid = head.stdout.trim();
    if (head.code === 0 && OID_RE.test(oid)) {
      return { ok: true, kind: 'head', headOid: oid };
    }
    return { ok: true, kind: 'unborn' };
  } catch {
    return { ok: false, reason: 'not-a-repo' };
  }
}

// ── ref creation / resolution / enumeration / reconciliation ───────────────────

export interface RefWriteResult {
  ok: boolean;
  error?: string;
}

/**
 * Force-create the baseline ref at `oid` and verify it resolves there. A FORCE update
 * (`update-ref <ref> <oid>` with no expected-old) is idempotent because the (ref, oid)
 * pair is a pure function of the run identity — re-running lands on the same value,
 * never on a foreign target. Resolves `{ ok:false }` (never throws) on any git failure
 * so the caller refuses the Implement without inserting a run row.
 */
export async function forceCreatePlanBaselineRef(
  deps: PlanBaselineGitDeps & { ref: string; oid: string },
): Promise<RefWriteResult> {
  if (!OID_RE.test(deps.oid)) return { ok: false, error: `invalid baseline oid ${deps.oid}` };
  const runGit = deps.runGit ?? realRunGit;
  const opts = PROBE_OPTS(deps);
  try {
    const write = await runGit(deps.repoRoot, ['update-ref', deps.ref, deps.oid], opts);
    if (write.code !== 0) {
      return { ok: false, error: `update-ref exited ${write.code}: ${write.stderr.trim()}` };
    }
    const verify = await runGit(deps.repoRoot, ['rev-parse', '--verify', deps.ref], opts);
    if (verify.code === 0 && verify.stdout.trim() === deps.oid) return { ok: true };
    return { ok: false, error: `ref ${deps.ref} did not resolve to ${deps.oid}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Resolve a baseline ref to the OID it points at, or null when it does not resolve
 *  (deleted / pruned). Never throws. */
export async function resolvePlanBaselineRef(
  deps: PlanBaselineGitDeps & { ref: string },
): Promise<string | null> {
  const runGit = deps.runGit ?? realRunGit;
  try {
    const res = await runGit(deps.repoRoot, ['rev-parse', '--verify', deps.ref], PROBE_OPTS(deps));
    const oid = res.stdout.trim();
    return res.code === 0 && OID_RE.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/** Every `refs/lares/plans/*` ref in the repo. Throws on an unusable repo. */
export async function enumeratePlanBaselineRefs(deps: PlanBaselineGitDeps): Promise<string[]> {
  const runGit = deps.runGit ?? realRunGit;
  const res = await runGit(deps.repoRoot, ['for-each-ref', '--format=%(refname)', PLAN_BASELINE_PREFIX], {
    gitExe: deps.gitExe,
    deadlineAt: deps.deadlineAt,
    allowNonzero: true,
    timeoutMs: 30_000,
    maxBytes: REF_LIST_MAX_BYTES,
  });
  if (res.code !== 0) {
    throw Object.assign(new Error(`git for-each-ref failed (code ${res.code}): ${res.stderr}`), {
      code: 'plan-baseline-ref-enumerate-failed',
    });
  }
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${PLAN_BASELINE_PREFIX}/`));
}

/** Delete a batch of baseline refs in ONE atomic `update-ref --stdin` txn.
 *  Unconditional delete — no expected-old — so a concurrent re-point never aborts the
 *  sweep. */
export async function deletePlanBaselineRefs(
  deps: PlanBaselineGitDeps & { refs: string[] },
): Promise<{ ok: boolean; code: number; stderr: string }> {
  if (deps.refs.length === 0) return { ok: true, code: 0, stderr: '' };
  return deleteRefPair({
    repoRoot: deps.repoRoot,
    gitExe: deps.gitExe ?? '',
    deletions: deps.refs.map((ref) => ({ ref })),
    runGit: deps.runGit,
  });
}

export interface OrphanReconcileResult {
  /** Refs deleted because their decoded runId had no `plan_execution_runs` row. */
  deleted: string[];
  /** Refs left in place (a matching run row exists, or the ref did not decode). */
  retained: string[];
}

/**
 * Startup orphan reconciliation. Enumerates every `refs/lares/plans/*` ref and deletes
 * exactly those whose decoded `runId` has NO matching `plan_execution_runs` row —
 * REGARDLESS of the run's lifecycle_state (an archived/inactive run still has a row and
 * retains its ref). Such an orphan is left when a DB-txn failure follows a successful
 * ref creation. A ref that does not decode is retained untouched (never our shape → not
 * ours to delete). `knownRunIds` is `listAllPlanExecutionRunIds()` from the DB layer.
 */
export async function reconcilePlanBaselineOrphans(
  deps: PlanBaselineGitDeps & { knownRunIds: Set<string> },
): Promise<OrphanReconcileResult> {
  const refs = await enumeratePlanBaselineRefs(deps);
  const deleted: string[] = [];
  const retained: string[] = [];
  for (const ref of refs) {
    const parts = parsePlanBaselineRef(ref);
    if (parts && !deps.knownRunIds.has(parts.runId)) deleted.push(ref);
    else retained.push(ref);
  }
  if (deleted.length > 0) {
    await deletePlanBaselineRefs({ ...deps, refs: deleted });
  }
  return { deleted, retained };
}
