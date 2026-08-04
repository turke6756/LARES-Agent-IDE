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
import { promises as fsp } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { LaunchAgentInput } from '../../shared/types';
import {
  insertOrReadPromotionRequest,
  getPromotionRequestByProposal,
  getPlanByWorkspaceArtifactId,
  enrichAdoptedPlanRow,
  type PromotionRequestRow,
} from '../database';
import {
  dispatchPromotion,
  type PromotionDeliverer,
  type PromotionDispatchInput,
  type PromotionDispatchResult,
} from './promotion-dispatch';
import {
  resolvePlanFolder,
  casAppendResponsibilityEvent,
  type PlanManifest,
  type ResponsibilityEvent,
} from './plan-manifest';

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
/** WP-P3-reconcile — re-acquire the in-memory pending latch for a still-open
 *  request at startup reconstruction, so a concurrent live `proposal:promote`
 *  coalesces onto the reconciled operation instead of dispatching a second worker.
 *  Idempotent (backed by the durable promotion_requests row). */
export function acquirePromotionLatch(
  workspaceId: string, proposalArtifactId: string, requestId: string,
): void {
  pendingLatches.set(latchKey(workspaceId, proposalArtifactId), { requestId });
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

/** The default planning-worker launch input + marked prompt builder. Exported so
 *  the wiring lane can drive the WP-P3B-core delivery oracle's promptFactory /
 *  launchInputFactory from a bare `promotion_requests` row (resumeDelivery re-send
 *  + reserved-unbound re-bind) with the IDENTICAL body a first live send carries. */
export function defaultBuildDispatch(ctx: DispatchBuildContext): { launchInput: LaunchAgentInput; prompt: string; marker: string } {
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

// ─────────────────────────────────────────────────────────────────────────────
// WP-P3B-enrich — saga-ordered transactional enrichment of the adopted row.
//
// This is the real body of the WP-P3B-core `enrichAdoptedPlan` seam. It runs
// against an ALREADY-adopted, filesystem-scaffolded plan row, in a PINNED order —
// SQLite and plan.json do NOT share one transaction (§R-P3 points 3/4):
//
//   1. Manifest step FIRST (outside SQLite): via the WP-P3-manifest lock+CAS,
//      OBSERVE the deterministic `promotion-service` `assigned` responsibility
//      event by its deterministic `event_id` (stamped by the worker at scaffold
//      time). For a MANUAL folder, VERIFY a pre-existing `manual-skill` `assigned`
//      event matches the server-selected supervisor — a mismatch is DIAGNOSED and
//      NEVER overwritten (§R-P3 point 10). The event is appended ONLY if the
//      deterministic event is somehow absent, and idempotently (append is a no-op
//      when already present, so it is observed exactly once across retries and a
//      concurrent skill edit is preserved by the guard re-read).
//   2. DB step SECOND (one SQLite transaction): enrichAdoptedPlanRow, which flips
//      the request pending → adopted only inside that successful transaction.
//
// A crash after step 1 but before/inside step 2 leaves the request `pending`; a
// retry (live or reconciler) re-observes the same `event_id` (no duplicate) and
// redoes the idempotent DB transaction — idempotent completion of the same work.
//
// The state-dir/workspace resolution is INJECTED (this file never imports the
// state-dir surface); the manifest + DB primitives default to the real modules and
// are overridable for tests.

const DEFAULT_PLANS_HOME_REL = '.lares/plans';

export interface EnrichAdoptedPlanDeps {
  /** Absolute plans-home root (`<workspaceStateDir()>/plans`) — the manifest CAS
   *  containment root for this workspace. */
  resolvePlansHomeRoot: (workspaceId: string) => string | Promise<string>;
  /** Absolute workspace root — to containment-check the source-proposal rel path. */
  resolveWorkspaceRoot: (workspaceId: string) => string | Promise<string>;
  /** State-dir-relative plans home used to strip the request's target folder path
   *  down to a path relative to the plans-home root (default '.lares/plans'). */
  plansHomeRelPath?: string;
  /** Read a folder's plan.json (default: containment-checked fs read). */
  readManifest?: (plansHomeRoot: string, folderRelToHome: string) => Promise<PlanManifest>;
  /** Append a responsibility event idempotently (default: casAppendResponsibilityEvent). */
  appendResponsibilityEvent?: (
    plansHomeRoot: string,
    folderRelToHome: string,
    event: ResponsibilityEvent,
  ) => Promise<unknown>;
  /** The atomic DB transaction (default: enrichAdoptedPlanRow). */
  runDbStep?: (input: Parameters<typeof enrichAdoptedPlanRow>[0]) => void;
  now?: () => number;
  genId?: (prefix: string) => string;
}

/** Strip the state-dir-relative plans-home prefix off the request's target folder
 *  path, yielding a path relative to the plans-home ROOT (what the manifest CAS
 *  wants). Tolerates back-slashes and a trailing slash on the home. */
function stripPlansHome(plansHomeRelPath: string, targetFolderRelPath: string): string {
  const home = plansHomeRelPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const norm = targetFolderRelPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm === home) return '.';
  const prefix = `${home}/`;
  return norm.startsWith(prefix) ? norm.slice(prefix.length) : norm;
}

/** Reject an absolute or workspace-escaping source-proposal rel path (rel-path only,
 *  containment-checked). */
function assertContainedRelPath(workspaceRoot: string, relPath: string): void {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('[promotion enrich] source_proposal.rel_path is missing/empty');
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`[promotion enrich] source_proposal.rel_path must be workspace-relative, got absolute: ${relPath}`);
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relPath);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`[promotion enrich] source_proposal.rel_path escapes the workspace: ${relPath}`);
  }
}

async function defaultReadManifest(plansHomeRoot: string, folderRelToHome: string): Promise<PlanManifest> {
  const folder = await resolvePlanFolder(plansHomeRoot, folderRelToHome);
  const raw = await fsp.readFile(path.join(folder, 'plan.json'), 'utf8');
  return JSON.parse(raw) as PlanManifest;
}

function defaultAppendResponsibilityEvent(
  plansHomeRoot: string,
  folderRelToHome: string,
  event: ResponsibilityEvent,
): Promise<unknown> {
  return casAppendResponsibilityEvent(plansHomeRoot, folderRelToHome, event, {
    ownerKind: 'service',
    ownerId: `promotion-service:pid-${process.pid}`,
  });
}

/**
 * Build the real WP-P3B-core `enrichAdoptedPlan` seam. Injected by the wiring lane
 * as `enrichAdoptedPlan: makeEnrichAdoptedPlan({ resolvePlansHomeRoot,
 * resolveWorkspaceRoot })`; also invoked by WP-P3-reconcile for pending rows.
 */
export function makeEnrichAdoptedPlan(deps: EnrichAdoptedPlanDeps): EnrichAdoptedPlanFn {
  const now = deps.now ?? (() => Date.now());
  const genId = deps.genId ?? ((prefix: string) => `${prefix}_${uuidv4()}`);
  const plansHomeRelPath = deps.plansHomeRelPath ?? DEFAULT_PLANS_HOME_REL;
  const readManifest = deps.readManifest ?? defaultReadManifest;
  const appendEvent = deps.appendResponsibilityEvent ?? defaultAppendResponsibilityEvent;
  const runDbStep = deps.runDbStep ?? enrichAdoptedPlanRow;

  return async ({ request, planId, responsibilityEventId }) => {
    const plansHomeRoot = await deps.resolvePlansHomeRoot(request.workspaceId);
    const workspaceRoot = await deps.resolveWorkspaceRoot(request.workspaceId);
    const folderRelToHome = stripPlansHome(plansHomeRelPath, request.targetFolderRelPath);

    // ── Step 1: manifest observation (outside SQLite, FIRST). ──
    const manifest = await readManifest(plansHomeRoot, folderRelToHome);
    const events = Array.isArray(manifest.responsibility_events)
      ? manifest.responsibility_events
      : [];
    const manualAssigned = events.find(
      (e) => e && e.event === 'assigned' && e.source === 'manual-skill',
    );
    if (manualAssigned) {
      // Manual folder: VERIFY the human-scaffolded assignment matches the
      // server-selected supervisor. A mismatch is diagnosed and NEVER overwritten.
      if (manualAssigned.agent_id !== request.supervisorId) {
        throw new Error(
          `[promotion enrich] manual-skill 'assigned' supervisor mismatch: manifest agent_id=` +
            `${manualAssigned.agent_id} server-selected=${request.supervisorId} — diagnosed, never overwritten`,
        );
      }
      // Matches → observed; nothing appended.
    } else if (!events.some((e) => e && e.event_id === responsibilityEventId)) {
      // Service folder whose deterministic event is somehow absent → append it
      // idempotently (lock+CAS preserves a concurrent skill writer's events).
      await appendEvent(plansHomeRoot, folderRelToHome, {
        event_id: responsibilityEventId,
        event: 'assigned',
        agent_id: request.supervisorId ?? 'promotion-service',
        at: now(),
        source: 'promotion-service',
      });
    }
    // else: the deterministic event is already present → observed, no append.

    // Source-proposal rel path is disk truth (§P3-GAP): plan.json.source_proposal.rel_path.
    const sourceProposalRelPath = manifest.source_proposal?.rel_path;
    if (!sourceProposalRelPath || typeof sourceProposalRelPath !== 'string') {
      throw new Error(
        `[promotion enrich] plan.json missing source_proposal.rel_path for ${folderRelToHome}`,
      );
    }
    assertContainedRelPath(workspaceRoot, sourceProposalRelPath);

    // ── Step 2: DB enrichment (one SQLite transaction, SECOND). ──
    runDbStep({
      requestId: request.id,
      planId,
      workspaceId: request.workspaceId,
      sourceProposalId: request.proposalId,
      responsibleSupervisorId: request.supervisorId,
      sourceProposalRelPath,
      docId: genId('plandoc'),
      nowMs: now(),
    });

    return { planId };
  };
}
