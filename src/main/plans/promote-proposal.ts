// WP-P3B-core — the live-process front half of proposal promotion.
//
// promoteProposal({ proposalId, supervisorId }) performs, faithful to §R-P3
// points 4, 5, 7–9, 11, 12 (and §P3-GAP: NO document selection anywhere):
//   1. Claim-scan FIRST, then select identity. A manual §R0-valid folder that
//      already claims this proposal keeps ITS existing valid plan_artifact_id /
//      folder path (never replaced); duplicates block enrichment; a folder
//      claimed by a different proposal/supervisor is rejected. Only when no
//      folder claims it do we derive the deterministic service identity
//      plan_<proposal-artifact-hex> at the deterministic state-dir path.
//   2. Durable de-dup (promotion_requests UNIQUE(workspace_id,
//      proposal_artifact_id)) + an in-memory pending latch held until the request
//      is terminal (adopted / witnessed-failed) — NOT merely folder adoption.
//   3. Branch: folder adopted → enrich (WP-P3B-enrich seam) + return the plan;
//      folder present, not adopted → promotion-pending; no folder → crash-safe
//      dispatch (Phase 1 bind-before-deliver) → promotion-pending.
//   5. Failed → pending retry is atomic, increments attempt_count, rebinds a new
//      reserved attempt, clears failure_reason, and binds before delivery — only
//      after the prior attempt is witnessed terminal; a possibly-delivered
//      attempt is never redriven.
//
// The enrichment saga (adopted-row CAS, plan.json touch) is WP-P3B-enrich and is
// injected here as a seam; this half never writes scaffold bytes or plan.json.

import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { LaunchAgentInput } from '../../shared/types';
import {
  insertOrReadPromotionRequest,
  getPromotionRequestByProposal,
  getPlanByWorkspaceArtifactId,
  type PromotionRequestRow,
} from '../database';
import {
  dispatchPromotion,
  type PromotionDeliverer,
  type PromotionDispatchInput,
  type PromotionDispatchResult,
} from './promotion-dispatch';

// ── Identity derivation (§R0, §R-P3 point 1) ────────────────────────────────

/** The hex tail of a proposal artifact id (`prop_<hex>` → `<hex>`). A bare id
 *  with no `prop_` prefix is used verbatim (portable-artifact tolerance). */
export function proposalArtifactHex(proposalArtifactId: string): string {
  return proposalArtifactId.startsWith('prop_')
    ? proposalArtifactId.slice('prop_'.length)
    : proposalArtifactId;
}

/** Deterministic service identity: plan_<proposal-artifact-hex> (§R0). A retry
 *  after restart converges on the same id/folder without any in-memory lock. */
export function derivePlanArtifactId(proposalArtifactId: string): string {
  return 'plan_' + proposalArtifactHex(proposalArtifactId);
}

function planArtifactShort(planArtifactId: string): string {
  const hex = planArtifactId.startsWith('plan_') ? planArtifactId.slice('plan_'.length) : planArtifactId;
  return hex.slice(0, 8);
}

/** plan-sku = <YYYY-MM-DD>-<slug>-<artifact-short>. The proposal's own basename
 *  is <YYYY-MM-DD>-<slug>, so the sku is basename + '-' + first-8-hex of the plan
 *  artifact id. Display/path metadata only — never durable identity. */
export function derivePlanSku(proposalRelPath: string, planArtifactId: string): string {
  const base = path.basename(proposalRelPath).replace(/\.md$/i, '');
  return `${base}-${planArtifactShort(planArtifactId)}`;
}

/** Deterministic folder path under the plans home (state-dir relative). Stored
 *  as a rel path; translateStateRelPath maps it to the live state-dir at use. */
export function deriveTargetFolderRelPath(plansHomeRelPath: string, planSku: string): string {
  return `${plansHomeRelPath.replace(/\/+$/, '')}/${planSku}`;
}

/** The deterministic responsibility bootstrap event_id the worker stamps into the
 *  initial R0 manifest at scaffold time — "rev_" + first 8 hex of
 *  sha256(promotion_request.id). Enrichment later OBSERVES (not re-appends) this
 *  exact id, so disk responsibility is never absent until post-adoption
 *  enrichment. */
export function deriveResponsibilityEventId(promotionRequestId: string): string {
  const hex = crypto.createHash('sha256').update(promotionRequestId).digest('hex');
  return 'rev_' + hex.slice(0, 8);
}

// ── Proposal + claim-scan seams (injected) ──────────────────────────────────

export interface ProposalRef {
  proposalId: string;
  /** `prop_<hex>` portable artifact id. */
  artifactId: string;
  /** workspace-relative path of the flat proposal markdown. */
  relPath: string;
  workspaceId: string;
}

/** Result of scanning §R0-valid folders for one claiming this proposal by
 *  plan.json.source_proposal.artifact_id (§R-P3 points 9, 11). */
export type ClaimScanResult =
  | { kind: 'none' }
  // Exactly one valid manual/existing folder claims THIS proposal — retain its
  // identity, never overwrite it with the deterministic one.
  | { kind: 'claimed'; planArtifactId: string; folderRelPath: string }
  // More than one valid claimant — diagnosed, blocks enrichment, never rebound.
  | { kind: 'duplicate'; folderRelPaths: string[]; diagnostic: string }
  // The deterministic target (or a matched folder) is claimed by a DIFFERENT
  // proposal/supervisor — rejected, never silently rebound.
  | { kind: 'foreign'; folderRelPath: string; diagnostic: string };

export type ClaimScanFn = (input: {
  workspaceId: string;
  proposalArtifactId: string;
  deterministicPlanArtifactId: string;
  deterministicFolderRelPath: string;
}) => ClaimScanResult | Promise<ClaimScanResult>;

/** WP-P3B-enrich seam — enrich the adopted, filesystem-scaffolded row and return
 *  the plans row id. Injected here so this half compiles/tests without the
 *  enrichment saga; the same file gains the real body in WP-P3B-enrich. */
export type EnrichAdoptedPlanFn = (input: {
  request: PromotionRequestRow;
  planId: string;
  responsibilityEventId: string;
}) => Promise<{ planId: string }>;

export interface PromoteProposalDeps {
  resolveProposal: (proposalId: string) => ProposalRef | null | Promise<ProposalRef | null>;
  scanClaims: ClaimScanFn;
  deliverer: PromotionDeliverer;
  enrichAdoptedPlan: EnrichAdoptedPlanFn;
  /** Override the crash-safe dispatch (default: dispatchPromotion). */
  dispatch?: (input: PromotionDispatchInput) => Promise<PromotionDispatchResult>;
  /** Override how the planning-worker launch input + marked prompt are built. */
  buildDispatch?: (ctx: DispatchBuildContext) => { launchInput: LaunchAgentInput; prompt: string; marker: string };
  now?: () => string;
  genId?: (prefix: string) => string;
  /** State-dir-relative plans home (default '.lares/plans'). */
  plansHomeRelPath?: string;
}

export interface DispatchBuildContext {
  request: PromotionRequestRow;
  proposal: ProposalRef;
  responsibilityEventId: string;
  marker: string;
}

// ── In-memory pending latch (§R-P3 point 4) ─────────────────────────────────
// Backed by the promotion_requests row; acquired before dispatch and held until
// the request is terminal (adopted / witnessed-failed) — NOT released on a
// promotion-pending return, and NOT on folder adoption alone.

const pendingLatches = new Map<string, { requestId: string }>();
function latchKey(workspaceId: string, proposalArtifactId: string): string {
  return `${workspaceId} ${proposalArtifactId}`;
}
export function isPromotionLatched(workspaceId: string, proposalArtifactId: string): boolean {
  return pendingLatches.has(latchKey(workspaceId, proposalArtifactId));
}
/** Test seam — clear the module-level latch map between cases. */
export function _resetPromotionLatchesForTests(): void {
  pendingLatches.clear();
}

// ── Result contract (§R-P3 point 7) ─────────────────────────────────────────

export type PromoteResult =
  | { status: 'adopted'; planId: string; planArtifactId: string; requestId: string }
  | { status: 'promotion-pending'; planArtifactId: string; requestId: string; runId?: string }
  | { status: 'duplicate-blocked'; diagnostic: string }
  | { status: 'rejected-foreign'; diagnostic: string }
  | { status: 'failed'; requestId: string; reason: string };

function defaultBuildDispatch(ctx: DispatchBuildContext): { launchInput: LaunchAgentInput; prompt: string; marker: string } {
  const { request, proposal, responsibilityEventId, marker } = ctx;
  // The dispatched skill contract spans the full ruling-24 planning journey; the
  // worker's first mechanical act is atomic scaffold creation at the
  // deterministic path, stamping `responsibilityEventId` into the initial R0
  // manifest. NO document list — the folder the worker scaffolds IS the document
  // set (§P3-GAP). NOT the P5 execution dispatch (Amendment 1c) — this is the
  // planning/hardening worker (Amendment 10): no execution worker, no
  // agents.plan_id write.
  const prompt = [
    `[PROMOTION] Harden proposal ${proposal.artifactId} into a plan folder.`,
    `promotionRequestId: ${request.id}`,
    `marker: ${marker}`,
    `plan_artifact_id: ${request.planArtifactId}`,
    `target_folder_rel_path: ${request.targetFolderRelPath}`,
    `source_proposal.rel_path: ${proposal.relPath}`,
    `responsibility bootstrap event_id: ${responsibilityEventId} (source: promotion-service)`,
    ``,
    `Your first act is atomic scaffold creation of a §R0-valid plan folder at the`,
    `deterministic path above, writing the responsibility event above into the`,
    `initial manifest. Then carry the interruptible, resumable ruling-24 journey`,
    `(scaffold/orient → scope → mark → deliberate → integrate → harden → package).`,
    `Do NOT enumerate documents to select — the folder you scaffold and fill IS`,
    `the document set.`,
  ].join('\n');
  const launchInput: LaunchAgentInput = {
    workspaceId: request.workspaceId,
    title: `Promote ${path.basename(proposal.relPath).replace(/\.md$/i, '')}`,
    provider: 'claude',
    isWorker: true,
    // NO initialUserPrompt — the promotion task is delivered in Phase 2b through
    // the turn-start-confirmed send, not the fire-and-forget initial-prompt rail.
  };
  return { launchInput, prompt, marker };
}

/**
 * The live-process front half of promotion. Idempotent by the durable request
 * row; safe to call repeatedly (repeat while pending/adopted returns the
 * existing operation — no second worker).
 */
export async function promoteProposal(
  input: { proposalId: string; supervisorId: string },
  deps: PromoteProposalDeps,
): Promise<PromoteResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const genId = deps.genId ?? ((prefix: string) => `${prefix}_${uuidv4()}`);
  const plansHomeRelPath = deps.plansHomeRelPath ?? '.lares/plans';
  const dispatch = deps.dispatch ?? dispatchPromotion;
  const buildDispatch = deps.buildDispatch ?? defaultBuildDispatch;

  const proposal = await deps.resolveProposal(input.proposalId);
  if (!proposal) {
    return { status: 'rejected-foreign', diagnostic: `proposal not found: ${input.proposalId}` };
  }

  // Deterministic identity — derived up front so the claim-scan can compare a
  // matched folder against the deterministic target, but ONLY adopted when the
  // scan finds no existing claimant (step 1).
  const deterministicPlanArtifactId = derivePlanArtifactId(proposal.artifactId);
  const deterministicSku = derivePlanSku(proposal.relPath, deterministicPlanArtifactId);
  const deterministicFolderRelPath = deriveTargetFolderRelPath(plansHomeRelPath, deterministicSku);

  // ── Step 1: CLAIM-SCAN FIRST, then select identity. ──
  const scan = await deps.scanClaims({
    workspaceId: proposal.workspaceId,
    proposalArtifactId: proposal.artifactId,
    deterministicPlanArtifactId,
    deterministicFolderRelPath,
  });

  if (scan.kind === 'foreign') {
    return { status: 'rejected-foreign', diagnostic: scan.diagnostic };
  }
  if (scan.kind === 'duplicate') {
    return { status: 'duplicate-blocked', diagnostic: scan.diagnostic };
  }

  // A manual folder's existing identity is RETAINED (never overwritten with the
  // deterministic one); otherwise use the deterministic identity/path.
  const planArtifactId = scan.kind === 'claimed' ? scan.planArtifactId : deterministicPlanArtifactId;
  const targetFolderRelPath = scan.kind === 'claimed'
    ? scan.folderRelPath
    : deterministicFolderRelPath;

  // ── Step 2: durable de-dup + pending latch. ──
  const { row: request } = insertOrReadPromotionRequest({
    id: genId('promreq'),
    workspaceId: proposal.workspaceId,
    proposalId: proposal.proposalId,
    proposalArtifactId: proposal.artifactId,
    planArtifactId,
    targetFolderRelPath,
    supervisorId: input.supervisorId,
  });
  // Acquire the pending latch (before any dispatch) unless already terminal.
  if (request.state === 'pending') {
    pendingLatches.set(latchKey(proposal.workspaceId, proposal.artifactId), { requestId: request.id });
  }

  const responsibilityEventId = deriveResponsibilityEventId(request.id);
  const releaseLatch = (): void => {
    pendingLatches.delete(latchKey(proposal.workspaceId, proposal.artifactId));
  };

  // ── Step 3: branch. ──
  // Adoption keys on the plans row for plan_artifact_id (disk-truth
  // source_proposal / plan_artifact_id — NOT private dispatch metadata, ruling
  // 25). Folder adoption by the watcher does not by itself set the request
  // 'adopted'; only completed enrichment does.
  const adoptedPlan = getPlanByWorkspaceArtifactId(proposal.workspaceId, planArtifactId);

  if (request.state === 'adopted') {
    // Enrichment already completed for this request — return the plan.
    const planId = adoptedPlan?.id;
    releaseLatch();
    if (planId) return { status: 'adopted', planId, planArtifactId, requestId: request.id };
    // Adopted state but no plans row is anomalous; fall through as pending.
    return { status: 'promotion-pending', planArtifactId, requestId: request.id };
  }

  if (adoptedPlan) {
    // Folder exists AND adopted (a plans row exists) → hand to WP-P3B-enrich,
    // then return the plan. Enrichment flips the request to 'adopted' and is
    // idempotent; the latch is held until it succeeds.
    try {
      const enriched = await deps.enrichAdoptedPlan({
        request, planId: adoptedPlan.id, responsibilityEventId,
      });
      releaseLatch();
      return { status: 'adopted', planId: enriched.planId, planArtifactId, requestId: request.id };
    } catch (err) {
      // Enrichment failed mid-saga — the request stays pending, latch held; the
      // reconciler (or the next promote) completes it. Surface as pending.
      return { status: 'promotion-pending', planArtifactId, requestId: request.id };
    }
  }

  // No adopted plans row.
  if (request.state === 'failed') {
    // Failed → pending retry: atomic, attempt_count++, new reserved attempt,
    // failure_reason cleared, bind-before-deliver — only because 'failed' IS the
    // witnessed-terminal state (a possibly-delivered attempt is NEVER redriven —
    // it stays pending and is reconciled, never reaches 'failed').
    return runDispatch(true);
  }

  if (request.orchestrationId) {
    // pending + already bound to an orchestration: the attempt might still have
    // delivered — do NOT redrive. Return the existing operation; the oracle /
    // reconciler resumes it.
    return { status: 'promotion-pending', planArtifactId, requestId: request.id, runId: request.orchestrationId };
  }

  // pending + no orchestration bound yet → fresh crash-safe dispatch.
  return runDispatch(false);

  async function runDispatch(retry: boolean): Promise<PromoteResult> {
    const marker = `promotion:${request.id}`;
    const { launchInput, prompt } = buildDispatch({
      request, proposal: proposal!, responsibilityEventId, marker,
    });
    try {
      const res = await dispatch({
        request,
        workspaceId: proposal!.workspaceId,
        supervisorId: input.supervisorId,
        prompt,
        marker,
        launchInput,
        retry,
        deliverer: deps.deliverer,
        now,
        genRunId: () => genId('promrun'),
      });
      // Delivered/undelivered both leave the request pending (adoption happens
      // later via the watcher + enrichment); the latch stays held.
      return { status: 'promotion-pending', planArtifactId, requestId: request.id, runId: res.runId };
    } catch (err) {
      // Terminal launch/delivery failure — dispatchPromotion already recorded
      // state='failed' + failure_reason + promotion.failed. Release the latch
      // (the request reached a terminal state).
      releaseLatch();
      const reason = err instanceof Error ? err.message : String(err);
      return { status: 'failed', requestId: request.id, reason };
    }
  }
}

/** Re-read the durable request row for a proposal (helper for callers/tests). */
export function readPromotionRequest(workspaceId: string, proposalArtifactId: string): PromotionRequestRow | null {
  return getPromotionRequestByProposal(workspaceId, proposalArtifactId);
}
