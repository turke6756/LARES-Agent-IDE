// SC-WP-1E — capture health (bundle contract v1 §7).
//
// Capture health is a read-only projection. Live Git is authoritative for edge
// liveness; persisted `*_ready` and `*_pruned_at` values are explanatory hints.
// Stage 1 has no finalizations, so every dirty member is truthfully reported as
// lacking an exact-byte finalization edge.

import type {
  BundleCaptureHealth,
  DirtyEntry,
  TurnCaptureState,
} from '../../shared/commit-candidates';
import type { TurnRecord, TurnStatus } from '../database';
import {
  liveEdgeKey,
  verifyLiveEdgesBatch,
  type LiveEdgeRunGit,
} from '../git-checkpoints/live-edge';

export type CaptureHealthTurn = Pick<
  TurnRecord,
  | 'id'
  | 'status'
  | 'beforeOid'
  | 'afterOid'
  | 'beforeRef'
  | 'afterRef'
  | 'beforeReady'
  | 'afterReady'
  | 'beforeQuality'
  | 'afterQuality'
  | 'beforePrunedAt'
  | 'afterPrunedAt'
  | 'failureReason'
>;

export interface ComputeBundleCaptureHealthOptions {
  repoRoot: string;
  turns: readonly CaptureHealthTurn[];
  dirtyEntries: readonly Pick<DirtyEntry, 'path'>[];
  runGit: LiveEdgeRunGit;
  gitExe?: string;
}

type EdgeState = TurnCaptureState['beforeEdge'];
type FailureClass = TurnCaptureState['failureClass'];

const BEFORE_QUALITIES = new Set<TurnCaptureState['beforeQuality']>([
  'guaranteed',
  'late',
  'degraded',
  null,
]);
const AFTER_QUALITIES = new Set<TurnCaptureState['afterQuality']>([
  'hook',
  'session-log',
  'terminal',
  'idle-fallback',
  'none',
  null,
]);

/** Capture machinery failures that mean checkpoint capture itself was unavailable. */
const CAPTURE_OUTAGE_REASONS = new Set([
  'budget-exceeded',
  'snapshot-failed',
  'missing-queue-key',
  'finalize-verify-mismatch',
]);

/** Capability/enumeration outcomes intentionally classified as skipped, not outages. */
const SKIPPED_REASONS = new Set([
  'checkpoint-skipped',
  'protected-root',
  'missing',
  'too-old',
  'unsafe-directory',
  'broken',
  'timeout',
  'unsupported-layout',
  'unsupported-path',
  'non-repo',
  'nested',
  'spans-boundary',
  'unsupported-wsl',
  'incomplete-capability',
  'oversized',
]);

function normalizeBeforeQuality(value: string | null): TurnCaptureState['beforeQuality'] {
  return BEFORE_QUALITIES.has(value as TurnCaptureState['beforeQuality'])
    ? value as TurnCaptureState['beforeQuality']
    : null;
}

function normalizeAfterQuality(value: string | null): TurnCaptureState['afterQuality'] {
  return AFTER_QUALITIES.has(value as TurnCaptureState['afterQuality'])
    ? value as TurnCaptureState['afterQuality']
    : null;
}

/** Reason classification is explicit so overlap/delivery/skip never inflate outage. */
export function classifyCaptureFailure(
  status: TurnStatus,
  failureReason: string | null,
): FailureClass {
  if (failureReason === 'overlapping-active-turn') return 'overlap';
  if (status === 'delivery_failed') return 'delivery-failed';
  if (status === 'skipped' || (failureReason !== null && SKIPPED_REASONS.has(failureReason))) {
    return 'skipped';
  }
  if (
    failureReason !== null
    && (
      CAPTURE_OUTAGE_REASONS.has(failureReason)
      || failureReason.startsWith('before-capture-threw:')
      || failureReason.startsWith('reconcile-ref-conflict:')
    )
  ) {
    return 'capture-outage';
  }
  return failureReason === null ? 'none' : 'other';
}

function computeEdgeState(
  liveKeys: ReadonlySet<string>,
  edge: {
    ready: boolean;
    ref: string | null;
    oid: string | null;
    prunedAt: number | null;
  },
): EdgeState {
  if (edge.ref && edge.oid && liveKeys.has(liveEdgeKey(edge.ref, edge.oid))) {
    return 'verified-live';
  }
  if (edge.prunedAt !== null) return 'pruned';
  if (edge.ready) return 'ready-hint-only';
  return 'absent';
}

/**
 * Compute §7 capture health for the turns and dirty members already selected by
 * repository/turn scope discovery. Every edge's liveness is resolved in ONE
 * batched `cat-file --batch-check` (distinct refs collapse to one probe) rather
 * than a `rev-parse` per edge — live Git remains authoritative, semantics are
 * unchanged.
 */
export async function computeBundleCaptureHealth(
  options: ComputeBundleCaptureHealthOptions,
): Promise<BundleCaptureHealth> {
  const liveKeys = await verifyLiveEdgesBatch({
    repoRoot: options.repoRoot,
    edges: options.turns.flatMap((turn) => [
      { ref: turn.beforeRef, oid: turn.beforeOid },
      { ref: turn.afterRef, oid: turn.afterOid },
    ]),
    runGit: options.runGit,
    gitExe: options.gitExe,
  });

  const turns = options.turns.map((turn): TurnCaptureState => ({
    turnId: turn.id,
    beforeEdge: computeEdgeState(liveKeys, {
      ready: turn.beforeReady,
      ref: turn.beforeRef,
      oid: turn.beforeOid,
      prunedAt: turn.beforePrunedAt,
    }),
    afterEdge: computeEdgeState(liveKeys, {
      ready: turn.afterReady,
      ref: turn.afterRef,
      oid: turn.afterOid,
      prunedAt: turn.afterPrunedAt,
    }),
    beforeQuality: normalizeBeforeQuality(turn.beforeQuality),
    afterQuality: normalizeAfterQuality(turn.afterQuality),
    failureClass: classifyCaptureFailure(turn.status, turn.failureReason),
  }));

  return {
    turns,
    captureOutage: turns.some((turn) => turn.failureClass === 'capture-outage'),
    // Stage 1 has no finalization manifests. Base64 is the authoritative exact
    // Git-path-byte key; displayPath must never be substituted here.
    pathsWithoutFinalizationEdge: options.dirtyEntries.map(
      (entry) => entry.path.pathBytesBase64,
    ),
  };
}
