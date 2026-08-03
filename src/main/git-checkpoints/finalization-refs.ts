// Save-card SC-WP-3C — durable finalization boundary refs. MAIN-PROCESS ONLY.
//
// A finalization freezes a package boundary at a computed OID and pins it with a
// DURABLE Lares ref so retention treats the boundary as protected while the
// finalization row is `lifecycle_status='active'`:
//
//   refs/lares/finalizations/<enc(packageId)>/<revision>
//
// The `<packageId>` component is base64url-encoded (WP-G1.3a idiom) so an
// arbitrary package id can never introduce a `/`, `..`, `.lock`, `@{`, control,
// or whitespace that `git check-ref-format` rejects. `<revision>` is a positive
// decimal integer — already ref-safe — so it is emitted verbatim and a ref
// round-trips (encode→decode) for reconciliation.
//
// Ref creation is a FORCE update to the computed OID (`git update-ref <ref>
// <oid>`), NOT the crash-consistent create-only write reconciler.ts uses for
// checkpoint edges. That is deliberate: the ref path and target OID are pure
// functions of (packageId, revision, boundaryOid), so force-to-computed-oid is
// idempotent — a retry after a crash between ref creation and the SQLite txn
// re-creates the SAME ref at the SAME oid, never clobbering a foreign target.
// Ref RELEASE (retention keyed on `lifecycle_status`) is WP-3F's job, not here.

import { encodeIdComponent, decodeIdComponent } from './ref-encoding';
import { deleteRefPair } from './reconciler';
import { runGit as realRunGit } from './git-command';
import type { RunGitLike } from './checkpoint-service';

export const FINALIZATIONS_PREFIX = 'refs/lares/finalizations';

const GIT_TIMEOUT_MS = 10_000;
/** A ref probe/write emits at most one OID line; the enumerate cap is generous. */
const REF_OP_MAX_BYTES = 1 << 20;
const REF_LIST_MAX_BYTES = 32 << 20;
const OID_RE = /^[0-9a-f]{40,64}$/;

export interface FinalizationRefParts {
  packageId: string;
  revision: number;
}

/** Assemble the durable boundary ref for a (packageId, revision). Pure +
 *  deterministic. `revision` MUST be a positive integer. */
export function finalizationRef(packageId: string, revision: number): string {
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new Error(`finalizationRef revision must be a positive integer, got ${revision}`);
  }
  if (packageId.length === 0) {
    throw new Error('finalizationRef packageId must be non-empty');
  }
  return `${FINALIZATIONS_PREFIX}/${encodeIdComponent(packageId)}/${revision}`;
}

/** Decode a finalization ref back to its parts, or null when it is not one (a
 *  hand-mangled ref never throws). */
export function parseFinalizationRef(ref: string): FinalizationRefParts | null {
  if (!ref.startsWith(`${FINALIZATIONS_PREFIX}/`)) return null;
  const rest = ref.slice(FINALIZATIONS_PREFIX.length + 1).split('/');
  if (rest.length !== 2) return null;
  const [pkgTok, revTok] = rest;
  if (!/^[1-9]\d*$/.test(revTok)) return null; // positive decimal, no leading zero
  const packageId = decodeIdComponent(pkgTok);
  if (packageId === null) return null;
  return { packageId, revision: Number(revTok) };
}

export interface FinalizationRefGitDeps {
  repoRoot: string;
  gitExe?: string;
  runGit?: RunGitLike;
  deadlineAt?: number;
}

export interface RefWriteResult {
  ok: boolean;
  error?: string;
}

/**
 * Force-create the boundary ref at `oid` and verify it resolves there. A FORCE
 * update (`update-ref <ref> <oid>` with no expected-old) is idempotent because
 * the (ref, oid) pair is a pure function of the finalization identity — re-running
 * lands on the same value, never on a foreign target. Resolves `{ ok:false }`
 * (never throws) on any git failure so the caller can record `unavailable`.
 */
export async function forceCreateFinalizationRef(
  deps: FinalizationRefGitDeps & { ref: string; oid: string },
): Promise<RefWriteResult> {
  if (!OID_RE.test(deps.oid)) return { ok: false, error: `invalid boundary oid ${deps.oid}` };
  const runGit = deps.runGit ?? realRunGit;
  const opts = {
    gitExe: deps.gitExe,
    deadlineAt: deps.deadlineAt,
    allowNonzero: true,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: REF_OP_MAX_BYTES,
  };
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

/** Resolve a finalization ref to the OID it points at, or null when it does not
 *  resolve (deleted / pruned). Never throws. */
export async function resolveFinalizationRef(
  deps: FinalizationRefGitDeps & { ref: string },
): Promise<string | null> {
  const runGit = deps.runGit ?? realRunGit;
  try {
    const res = await runGit(deps.repoRoot, ['rev-parse', '--verify', deps.ref], {
      gitExe: deps.gitExe,
      deadlineAt: deps.deadlineAt,
      allowNonzero: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: REF_OP_MAX_BYTES,
    });
    const oid = res.stdout.trim();
    return res.code === 0 && OID_RE.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/** Every `refs/lares/finalizations/*` ref in the repo (repo-global; packageIds are
 *  globally unique so this never bleeds across repos). Throws on an unusable repo. */
export async function enumerateFinalizationRefs(deps: FinalizationRefGitDeps): Promise<string[]> {
  const runGit = deps.runGit ?? realRunGit;
  const res = await runGit(deps.repoRoot, ['for-each-ref', '--format=%(refname)', FINALIZATIONS_PREFIX], {
    gitExe: deps.gitExe,
    deadlineAt: deps.deadlineAt,
    allowNonzero: true,
    timeoutMs: 30_000,
    maxBytes: REF_LIST_MAX_BYTES,
  });
  if (res.code !== 0) {
    throw Object.assign(new Error(`git for-each-ref failed (code ${res.code}): ${res.stderr}`), {
      code: 'finalization-ref-enumerate-failed',
    });
  }
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${FINALIZATIONS_PREFIX}/`));
}

/** Delete a batch of finalization refs in ONE atomic `update-ref --stdin` txn
 *  (reuses the WP-G1.8 mechanism). Unconditional delete — no expected-old — so a
 *  concurrent re-point does not abort the sweep. */
export async function deleteFinalizationRefs(
  deps: FinalizationRefGitDeps & { refs: string[] },
): Promise<{ ok: boolean; code: number; stderr: string }> {
  if (deps.refs.length === 0) return { ok: true, code: 0, stderr: '' };
  return deleteRefPair({
    repoRoot: deps.repoRoot,
    gitExe: deps.gitExe ?? '',
    deletions: deps.refs.map((ref) => ({ ref })),
    runGit: deps.runGit,
  });
}
