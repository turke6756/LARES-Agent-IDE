// WP-P3-reconcile — pending-promotion startup reconstruction (§R-P3 point 6).
//
// At every boot, the promotion service may have crashed at any point in the
// two-phase bind-before-deliver lifecycle (WP-P3B-core). The durable evidence —
// `promotion_requests` rows + the promotion.* orchestration event ledger — is
// authoritative; this module rebuilds the in-memory pending latches from it and
// drives each still-`pending` request to convergence with a BOUNDED, self-owned
// step. It awaits NO unpromised P2 readiness hook: before enriching, it calls the
// public idempotent `adoptPlanFolder(...)` itself (a no-op if the watcher already
// adopted the folder).
//
// For each `state='pending'` request, `await inspectDelivery(orchestration_id)`
// classifies exactly how far the prior attempt got, and we branch (§R-P3 point 6):
//   • not-reserved         → claim + dispatch a FRESH planning-lane worker
//   • reserved-unbound      → resumeDelivery: re-bind (Phase 2a) + deliver, SAME
//                             orchestration, no duplicate
//   • bound-undelivered     → resumeDelivery: full marked-prompt send ONCE, same agent
//   • submitted-unconfirmed → resumeSubmitOnly: confirm the turn only, NEVER retype
//   • delivered             → adoptPlanFolder + WP-P3B-enrich, NO second worker
//   • indeterminate         → leave pending, emit a diagnostic, do NOT dispatch
//
// It is idempotent and safe every boot: once a request is enriched it flips to
// `adopted` (WP-P3B-enrich's DB transaction) and drops out of the pending scan; a
// dispatched request binds an orchestration so the next boot reads a resumable
// state instead of re-dispatching. Any dispatch here is PLANNING-lane (Amendment
// 10) — never EXECUTION onto work packages (the human Implement trigger in P5,
// Amendment 1c); it never mutates `agents.plan_id` and never launches an execution
// worker.

import {
  listPendingPromotionRequests,
  getPlanByWorkspaceArtifactId,
  type PromotionRequestRow,
} from '../database';
import type { DeliveryProbe, PromotionDeliveryInspector } from './promotion-dispatch';
import {
  deriveResponsibilityEventId,
  acquirePromotionLatch,
  type EnrichAdoptedPlanFn,
} from './promote-proposal';
import type { AdoptResult } from './plan-folder-watcher';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the reconciler did with one pending request this boot. */
export type ReconcileOutcome =
  | 'dispatched' // not-reserved → fresh planning-lane dispatch
  | 'resumed-deliver' // reserved-unbound / bound-undelivered → resumeDelivery
  | 'resumed-submit' // submitted-unconfirmed → resumeSubmitOnly (no body retype)
  | 'enriched' // delivered → adopt + WP-P3B-enrich
  | 'left-pending'; // indeterminate / not-yet-adopted / unwired dispatch → no redrive

export interface ReconcileDiagnostic {
  requestId: string;
  workspaceId: string;
  probeState?: DeliveryProbe['state'];
  detail: string;
}

export interface ReconcileEntry {
  requestId: string;
  outcome: ReconcileOutcome;
  probeState: DeliveryProbe['state'];
}

export interface ReconcileReport {
  processed: number;
  entries: ReconcileEntry[];
  diagnostics: ReconcileDiagnostic[];
}

export interface ReconcilePromotionsDeps {
  /** The delivery oracle + resume seams (WP-P3B-core). The branch decision keys on
   *  `inspectDelivery`'s durable-evidence classification. OPTIONAL: when the
   *  promotion delivery runtime is not yet assembled in this process (its correct
   *  turn-start witness lives behind the promotion runtime, P3C′), the reconciler
   *  still safely re-acquires latches and ensures idempotent adopts, and leaves
   *  every bound/reserved request pending with a diagnostic — NEVER a blind
   *  redrive. Once the runtime supplies the inspector, the delivery branches run. */
  inspector?: PromotionDeliveryInspector;
  /** Idempotent single-folder adopt (WP-P2B-folder public entrypoint). Called
   *  before enrichment to ensure the adopted `plans` row exists. */
  adoptPlanFolder: (req: PromotionRequestRow) => Promise<AdoptResult>;
  /** The WP-P3B-enrich saga (makeEnrichAdoptedPlan(...)) — runs only against an
   *  adopted row, in the `delivered` branch. */
  enrichAdoptedPlan: EnrichAdoptedPlanFn;
  /** Fresh claim + planning-lane dispatch for a `not-reserved` request (WP-P3B-core).
   *  OPTIONAL: when the promotion dispatch runtime is not wired in this process, a
   *  not-reserved request is left pending with a diagnostic — NEVER a mis-dispatch. */
  dispatchFresh?: (req: PromotionRequestRow) => Promise<void>;
  /** Pending scan (default: `listPendingPromotionRequests`). */
  listPending?: () => PromotionRequestRow[];
  /** Resolve the adopted `plans` row id for a request's plan_artifact_id
   *  (default: `getPlanByWorkspaceArtifactId`). */
  getAdoptedPlanId?: (req: PromotionRequestRow) => string | null;
  /** Re-acquire the in-memory pending latch (default: `acquirePromotionLatch`) so a
   *  concurrent live `proposal:promote` coalesces onto the reconciled operation. */
  acquireLatch?: (req: PromotionRequestRow) => void;
  /** Diagnostic sink (in addition to the returned report). */
  onDiagnostic?: (d: ReconcileDiagnostic) => void;
}

/**
 * Rebuild pending promotion latches and reconcile every `state='pending'` request
 * per §R-P3 point 6. Idempotent and safe on every boot; a per-request failure is
 * diagnosed and never aborts the sweep.
 */
export async function reconcilePendingPromotions(
  deps: ReconcilePromotionsDeps,
): Promise<ReconcileReport> {
  const listPending = deps.listPending ?? listPendingPromotionRequests;
  const getAdoptedPlanId =
    deps.getAdoptedPlanId ??
    ((req: PromotionRequestRow) =>
      getPlanByWorkspaceArtifactId(req.workspaceId, req.planArtifactId)?.id ?? null);
  const acquireLatch =
    deps.acquireLatch ??
    ((req: PromotionRequestRow) =>
      acquirePromotionLatch(req.workspaceId, req.proposalArtifactId, req.id));

  const report: ReconcileReport = { processed: 0, entries: [], diagnostics: [] };
  const emitDiag = (d: ReconcileDiagnostic): void => {
    report.diagnostics.push(d);
    deps.onDiagnostic?.(d);
  };

  for (const req of listPending()) {
    report.processed += 1;
    // Re-acquire the in-memory pending latch FIRST — even if reconciling this
    // request then fails, a concurrent live promote must coalesce onto the durable
    // operation rather than dispatch a second worker. Best-effort.
    try {
      acquireLatch(req);
    } catch (err) {
      emitDiag({ requestId: req.id, workspaceId: req.workspaceId, detail: `latch re-acquire failed: ${errMsg(err)}` });
    }

    try {
      report.entries.push(await reconcileOne(req, deps, getAdoptedPlanId, emitDiag));
    } catch (err) {
      // A per-request failure never aborts the boot sweep — leave it pending and
      // move on; the next boot (or an explicit retry) revisits it.
      emitDiag({ requestId: req.id, workspaceId: req.workspaceId, detail: `reconcile error: ${errMsg(err)}` });
      report.entries.push({ requestId: req.id, outcome: 'left-pending', probeState: 'indeterminate' });
    }
  }

  return report;
}

async function reconcileOne(
  req: PromotionRequestRow,
  deps: ReconcilePromotionsDeps,
  getAdoptedPlanId: (req: PromotionRequestRow) => string | null,
  emitDiag: (d: ReconcileDiagnostic) => void,
): Promise<ReconcileEntry> {
  // Ensure the adopted row exists up front — a bounded, self-owned convergence
  // step (NOT an awaited P2 readiness hook). Idempotent no-op if already adopted;
  // failure to find the folder yet is not fatal — the branch logic still runs
  // against the durable delivery evidence.
  const adopt = await safeAdopt(req, deps, emitDiag);

  // `not-reserved` when no orchestration was ever bound (crash before Phase-1
  // commit, or Phase 1 never ran). Without a delivery oracle we cannot classify a
  // bound request's delivery state — leave it pending (latch already re-acquired,
  // adopt already ensured); the next boot with the runtime wired reconciles it.
  const orchestrationId = req.orchestrationId;
  if (!deps.inspector) {
    emitDiag({
      requestId: req.id, workspaceId: req.workspaceId,
      detail: 'promotion delivery oracle not wired in this process; latch re-acquired + adopt ensured, delivery reconciliation deferred to the next boot',
    });
    return { requestId: req.id, outcome: 'left-pending', probeState: orchestrationId ? 'indeterminate' : 'not-reserved' };
  }
  const inspector = deps.inspector;
  const probe: DeliveryProbe = orchestrationId
    ? await inspector.inspectDelivery(orchestrationId)
    : { state: 'not-reserved' };

  switch (probe.state) {
    case 'not-reserved': {
      if (!deps.dispatchFresh) {
        emitDiag({
          requestId: req.id, workspaceId: req.workspaceId, probeState: probe.state,
          detail: 'not-reserved but the promotion dispatch runtime is not wired in this process; left pending (no mis-dispatch)',
        });
        return { requestId: req.id, outcome: 'left-pending', probeState: probe.state };
      }
      await deps.dispatchFresh(req);
      return { requestId: req.id, outcome: 'dispatched', probeState: probe.state };
    }

    case 'reserved-unbound':
    case 'bound-undelivered': {
      // resumeDelivery reuses the EXISTING reserved orchestration — reserved-unbound
      // re-binds the agent (Phase 2a) then delivers; bound-undelivered sends the full
      // marked prompt once. Either way: no duplicate orchestration, no new worker.
      await inspector.resumeDelivery(orchestrationId as string);
      return { requestId: req.id, outcome: 'resumed-deliver', probeState: probe.state };
    }

    case 'submitted-unconfirmed': {
      // The body was already submitted; only the turn-start confirmation is missing.
      // Re-press submit + re-witness — NEVER retype the body.
      await inspector.resumeSubmitOnly(orchestrationId as string);
      return { requestId: req.id, outcome: 'resumed-submit', probeState: probe.state };
    }

    case 'delivered': {
      // The worker already received the prompt (marker + matching turn-start). Adopt
      // (idempotent) + enrich the exact adopted row — NO second worker. A crash after
      // folder adoption but before enrichment lands here too (row still pending).
      const planId = adopt?.planId ?? getAdoptedPlanId(req);
      if (!planId) {
        emitDiag({
          requestId: req.id, workspaceId: req.workspaceId, probeState: probe.state,
          detail: 'delivered but no adopted plans row yet (folder not scaffolded/adopted); left pending for the next boot',
        });
        return { requestId: req.id, outcome: 'left-pending', probeState: probe.state };
      }
      await deps.enrichAdoptedPlan({
        request: req,
        planId,
        responsibilityEventId: deriveResponsibilityEventId(req.id),
      });
      return { requestId: req.id, outcome: 'enriched', probeState: probe.state };
    }

    case 'indeterminate': {
      // Genuinely unreadable PTY/turn state — NEVER redrive on uncertainty. Leave
      // the request pending with a diagnostic; re-probe on the next boot / retry.
      emitDiag({
        requestId: req.id, workspaceId: req.workspaceId, probeState: probe.state,
        detail: `indeterminate delivery state; left pending (no dispatch): ${probe.diagnostic}`,
      });
      return { requestId: req.id, outcome: 'left-pending', probeState: probe.state };
    }
  }
}

/** Idempotent adopt that never throws — a missing/malformed folder is diagnosed
 *  and reported, not propagated (the caller decides per branch). */
async function safeAdopt(
  req: PromotionRequestRow,
  deps: ReconcilePromotionsDeps,
  emitDiag: (d: ReconcileDiagnostic) => void,
): Promise<AdoptResult | null> {
  try {
    const res = await deps.adoptPlanFolder(req);
    if (!res.adopted && res.reason && res.reason !== 'absent') {
      emitDiag({
        requestId: req.id, workspaceId: req.workspaceId,
        detail: `adoptPlanFolder did not adopt ${req.targetFolderRelPath}: ${res.reason}`,
      });
    }
    return res;
  } catch (err) {
    emitDiag({ requestId: req.id, workspaceId: req.workspaceId, detail: `adoptPlanFolder threw: ${errMsg(err)}` });
    return null;
  }
}
