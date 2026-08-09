// Save-card SC-WP-3C — the finalization service: freeze a package boundary, pin a
// durable ref, and record the finalization row under a failure-ordered, retry-
// idempotent contract. MAIN-PROCESS ONLY.
//
// A finalization is minted by an EXPLICIT plan-package `done` transition (WP-3D)
// or a DISTINCT fleet-adhoc mark-done step (WP-3E) — never auto-derived from
// `accepted`. This service is the shared core both call.
//
// Failure-ordered sequence (the ordering IS the crash-safety contract):
//   1. Freeze `member_manifest_json` — for every member the temp-index algorithm
//      (WP-2J) computes the raw `hash-object --no-filters` oid AND the clean-
//      filtered commit oid without touching the real index; the members are
//      path-sorted and JCS-canonicalized so the frozen manifest is byte-stable.
//   2. Force-create the durable boundary ref at the computed boundary oid
//      (idempotent; finalization-refs.ts).
//   3. In ONE SQLite txn: insert the row `boundary_status='ready'`, invoke the
//      caller's evidence-gated completion hook, and supersede any prior active row.
//
// Compensation:
//   • ref creation FAILS  ⇒ never insert a `ready` row. Record a non-active
//     `boundary_status='unavailable'` attempt (no supersede, no completion hook) and
//     return it as incomplete. The still-valid prior finalization stays active.
//   • crash AFTER ref creation but BEFORE the txn ⇒ an orphan ref with no active
//     row; the startup reconciler GCs it. The retry recomputes the SAME revision
//     (no row committed → `max` unchanged) → same ref → idempotent force-create →
//     the txn completes exactly once.
//
// Re-finalization (mechanically defined, retry-idempotent):
//   read latest active → JCS-compare (boundary oid + frozen manifest) →
//   identical & ready  ⇒ return it unchanged (no revision bump, no supersede);
//   identical & downgraded ⇒ re-attach: re-create the ref, restore `ready`;
//   differing          ⇒ allocate max(revision)+1, create the new ref/row, and
//                        supersede the prior active row atomically.

import { canonicalize } from './jcs';
import {
  readCurrentCommitRepresentation,
  type CommitRepresentation,
  type CommitRepresentationEntry,
} from './commit-representation';
import { CheckpointQueue } from '../git-checkpoints/checkpoint-queue';
import {
  finalizationRef,
  forceCreateFinalizationRef,
  type RefWriteResult,
} from '../git-checkpoints/finalization-refs';
import type { RunGitLike } from '../git-checkpoints/checkpoint-service';
import { runGitBytes as realRunGitBytes } from '../git-checkpoints/git-command';
import {
  getDb,
  getActivePackageFinalization as dbGetActive,
  maxPackageRevision as dbMaxRevision,
  insertPackageFinalization as dbInsert,
  supersedePackageFinalization as dbSupersede,
  setPackageFinalizationBoundaryStatus as dbSetBoundaryStatus,
  type FinalizationBoundaryStatus,
  type FinalizationKind,
  type PackageFinalization,
} from '../database';

/** One frozen manifest member — the per-path evidence pinned at finalize time.
 *  `rawBlobOid` is WP-1B's `hash-object --no-filters` value; `commitBlobOid` +
 *  `commitMode` are the clean-filtered temp-index result (both null for an
 *  expected-absent deletion). Keys are stable so the JCS canonicalization is. */
export interface FrozenManifestMember {
  pathBytesBase64: string;
  expectedState: 'present' | 'absent';
  rawBlobOid: string | null;
  commitBlobOid: string | null;
  commitMode: string | null;
}

/** The DB surface the service composes. Default-bound to the WP-3A/3B accessors;
 *  tests inject an in-memory fake. `transact` runs its callback in ONE SQLite
 *  transaction (all-or-nothing). */
export interface FinalizationStore {
  getActivePackageFinalization(packageId: string): PackageFinalization | null;
  maxPackageRevision(packageId: string): number;
  insertPackageFinalization(f: PackageFinalization): void;
  supersedePackageFinalization(id: string, supersededBy: string): void;
  setPackageFinalizationBoundaryStatus(id: string, status: FinalizationBoundaryStatus): void;
  transact<T>(fn: () => T): T;
}

export const DATABASE_FINALIZATION_STORE: FinalizationStore = {
  getActivePackageFinalization: dbGetActive,
  maxPackageRevision: dbMaxRevision,
  insertPackageFinalization: dbInsert,
  supersedePackageFinalization: dbSupersede,
  setPackageFinalizationBoundaryStatus: dbSetBoundaryStatus,
  transact: <T>(fn: () => T): T => getDb().transaction(fn)() as T,
};

/** Writes (force-creates) the boundary ref at an oid; resolves `{ ok:false }` on
 *  any failure (never throws). Default-bound to finalization-refs. */
export type FinalizationRefWriter = (ref: string, oid: string) => Promise<RefWriteResult>;

/** Freezes ONE member into its raw + clean-filtered representation. Default-bound
 *  to the WP-2J read-only temp-index computation. */
export type MemberFreezer = (entry: CommitRepresentationEntry) => Promise<CommitRepresentation>;

export interface FinalizePackageRequest {
  packageId: string;
  /** Work-package content revision for plan-package boundaries. */
  packageRevision?: number;
  repositoryKey: string;
  finalizationKind: FinalizationKind;
  /** plan-package only; both null for fleet-adhoc (the DB CHECK enforces this). */
  planId: string | null;
  planItemId: string | null;
  finalizedBy: string;
  checkpointTurnId: string | null;
  /** The computed boundary OID the durable ref is pinned at + the identity key. */
  boundaryOid: string;
  contractVersion: number;
  createdFromWorkspaceId: string | null;
  /** The members to freeze into `member_manifest_json`. */
  members: CommitRepresentationEntry[];

  // ── freeze inputs (temp-index base + git seam) ──
  repoRoot: string;
  pinnedHeadOid: string | null;
  gitExe?: string;
  deadlineAt?: number;
  runGit?: RunGitLike;
  runGitBytes?: typeof realRunGitBytes;
  queue?: CheckpointQueue;
  commonDirQueueKey?: string;
}

export type FinalizeOutcome =
  /** Fresh finalization (no prior active row). */
  | 'created'
  /** Byte-identical re-finalize — the existing active `ready` row is returned. */
  | 'existing-unchanged'
  /** Differing re-finalize — new revision created, prior active row superseded. */
  | 'superseded'
  /** Identical re-finalize over a downgraded row — ref re-created, `ready` restored. */
  | 'reattached-ready'
  /** Ref creation failed — a non-active `unavailable` attempt; incomplete. */
  | 'boundary-unavailable';

export interface FinalizePackageResult {
  finalization: PackageFinalization;
  outcome: FinalizeOutcome;
  memberManifestJson: string;
}

export interface FinalizePackageDeps {
  store?: FinalizationStore;
  writeRef?: FinalizationRefWriter;
  freeze?: MemberFreezer;
  now?: () => number;
  newId?: () => string;
  /** Invoked only after a ready boundary is durable, inside the finalization txn. */
  onReady?: (finalization: PackageFinalization) => void;
}

let idSeq = 0;
function defaultId(): string {
  idSeq += 1;
  return `fin-${Date.now().toString(36)}-${idSeq}`;
}

/** Freeze the request's members into a path-sorted, JCS-canonical manifest. */
async function freezeManifest(
  request: FinalizePackageRequest,
  freeze: MemberFreezer,
): Promise<string> {
  const seen = new Set<string>();
  const members: FrozenManifestMember[] = [];
  for (const entry of request.members) {
    const key = entry.path.pathBytesBase64;
    if (seen.has(key)) {
      throw new Error('A finalization manifest cannot list the same path twice.');
    }
    seen.add(key);
    const rep = await freeze(entry);
    members.push({
      pathBytesBase64: key,
      expectedState: rep.expectedState,
      rawBlobOid: rep.rawBlobOid,
      commitBlobOid: rep.commitBlobOid,
      commitMode: rep.commitMode,
    });
  }
  members.sort((a, b) => (a.pathBytesBase64 < b.pathBytesBase64 ? -1 : a.pathBytesBase64 > b.pathBytesBase64 ? 1 : 0));
  return canonicalize(members as unknown as Record<string, unknown>[]);
}

/** Canonical identity key of a boundary (oid + frozen manifest) for JCS compare. */
function boundaryIdentity(boundaryOid: string | null, memberManifestJson: string): string {
  return canonicalize({ boundaryOid, memberManifestJson });
}

function assertRequest(request: FinalizePackageRequest): void {
  if (!request.packageId) throw new Error('finalize requires a packageId');
  if (!/^[0-9a-f]{40,64}$/.test(request.boundaryOid)) {
    throw new Error(`finalize requires a valid boundary oid, got ${request.boundaryOid}`);
  }
  if (request.finalizationKind === 'plan-package') {
    if (!request.planId || !request.planItemId) {
      throw new Error('a plan-package finalization requires planId and planItemId');
    }
    if (request.packageRevision !== undefined
        && (!Number.isInteger(request.packageRevision) || request.packageRevision < 1)) {
      throw new Error('a plan-package finalization requires a positive packageRevision');
    }
  } else if (request.planId !== null || request.planItemId !== null) {
    throw new Error('a fleet-adhoc finalization must carry NULL plan attribution');
  }
}

/**
 * Finalize a package boundary. See the module header for the full contract. Idempotent
 * under retry: a byte-identical re-run returns the existing finalization; a crash
 * between ref creation and the txn resolves to the same ref and completes once.
 */
export async function finalizePackage(
  request: FinalizePackageRequest,
  deps: FinalizePackageDeps = {},
): Promise<FinalizePackageResult> {
  assertRequest(request);
  const store = deps.store ?? DATABASE_FINALIZATION_STORE;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? defaultId;
  const writeRef =
    deps.writeRef ??
    ((ref: string, oid: string) =>
      forceCreateFinalizationRef({
        repoRoot: request.repoRoot,
        gitExe: request.gitExe,
        deadlineAt: request.deadlineAt,
        runGit: request.runGit,
        ref,
        oid,
      }));
  const freeze =
    deps.freeze ??
    ((entry: CommitRepresentationEntry) =>
      readCurrentCommitRepresentation({
        repoRoot: request.repoRoot,
        pinnedHeadOid: request.pinnedHeadOid,
        entry,
        gitExe: request.gitExe,
        deadlineAt: request.deadlineAt,
        runGit: request.runGit,
        runGitBytes: request.runGitBytes,
        queue: request.queue,
        commonDirQueueKey: request.commonDirQueueKey,
      }));

  // 1. Freeze the manifest — the identity input every branch compares against.
  const memberManifestJson = await freezeManifest(request, freeze);
  const requestIdentity = boundaryIdentity(request.boundaryOid, memberManifestJson);

  const buildRow = (
    id: string,
    revision: number,
    boundaryStatus: FinalizationBoundaryStatus,
    lifecycleStatus: PackageFinalization['lifecycleStatus'],
    failureReason: string | null,
  ): PackageFinalization => ({
    id,
    packageId: request.packageId,
    repositoryKey: request.repositoryKey,
    finalizationKind: request.finalizationKind,
    planId: request.finalizationKind === 'plan-package' ? request.planId : null,
    planItemId: request.finalizationKind === 'plan-package' ? request.planItemId : null,
    packageRevision: revision,
    finalizedAt: now(),
    finalizedBy: request.finalizedBy,
    checkpointTurnId: request.checkpointTurnId,
    checkpointOid: request.boundaryOid,
    boundaryRef: finalizationRef(request.packageId, revision),
    boundaryStatus,
    lifecycleStatus,
    supersededByFinalizationId: null,
    releasedAt: null,
    memberManifestJson,
    contractVersion: request.contractVersion,
    failureReason,
    createdFromWorkspaceId: request.createdFromWorkspaceId,
  });

  const latest = store.getActivePackageFinalization(request.packageId);
  const identical =
    latest !== null &&
    boundaryIdentity(latest.checkpointOid, latest.memberManifestJson) === requestIdentity;

  // 2a. Byte-identical re-finalize over a still-ready boundary → no-op.
  if (identical && latest.boundaryStatus === 'ready') {
    if (deps.onReady) store.transact(() => deps.onReady!(latest));
    return { finalization: latest, outcome: 'existing-unchanged', memberManifestJson };
  }

  // 2b. Byte-identical re-finalize over a DOWNGRADED active row (ref went missing
  //     and the reconciler flipped it to unavailable/pruned) → re-attach: re-create
  //     the ref at its existing revision and restore `ready` in one txn.
  if (identical && latest.boundaryStatus !== 'ready') {
    const ref = latest.boundaryRef ?? finalizationRef(request.packageId, latest.packageRevision);
    const write = await writeRef(ref, request.boundaryOid);
    if (write.ok) {
      store.transact(() => {
        store.setPackageFinalizationBoundaryStatus(latest.id, 'ready');
        deps.onReady?.({ ...latest, boundaryStatus: 'ready' });
      });
      return {
        finalization: { ...latest, boundaryStatus: 'ready' },
        outcome: 'reattached-ready',
        memberManifestJson,
      };
    }
    return { finalization: latest, outcome: 'boundary-unavailable', memberManifestJson };
  }

  // 3. Fresh or differing finalization: allocate the next revision. On a retry after
  //    a crash-before-txn the prior attempt committed no row, so `max` is unchanged
  //    and this recomputes the SAME revision → same ref → idempotent force-create.
  const revision = request.finalizationKind === 'plan-package' && request.packageRevision !== undefined
    ? request.packageRevision
    : store.maxPackageRevision(request.packageId) + 1;
  const ref = finalizationRef(request.packageId, revision);
  const write = await writeRef(ref, request.boundaryOid);

  if (!write.ok) {
    // Ref creation failed ⇒ NEVER a ready row, NEVER supersede, NEVER invoke completion.
    // A non-active `unavailable` attempt records the failure; the prior finalization
    // (if any) stays active. Plan-package `done` therefore never appears finalized on
    // an unavailable boundary.
    const failed = buildRow(newId(), revision, 'unavailable', 'abandoned', write.error ?? 'boundary-ref-creation-failed');
    store.transact(() => {
      store.insertPackageFinalization(failed);
    });
    return { finalization: failed, outcome: 'boundary-unavailable', memberManifestJson };
  }

  const row = buildRow(newId(), revision, 'ready', 'active', null);
  store.transact(() => {
    if (latest) store.supersedePackageFinalization(latest.id, row.id);
    store.insertPackageFinalization(row);
    deps.onReady?.(row);
  });
  return { finalization: row, outcome: latest ? 'superseded' : 'created', memberManifestJson };
}
