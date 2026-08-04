// WP-P5B — plan lifecycle-event service + Mark-Ready.
//
// The SOLE owner of the non-terminal package state transitions
// (ready/executing/blocked/archived) on SC-WP-3A `plan_work_packages`, each ledgered
// into `plan_wp_lifecycle_events`, and of the plan-level `run_state` hardening→ready
// flip (Mark Ready). It NEVER writes `done` — SC-WP-3C is the authoritative `done`
// channel — and it does not dispatch. WP-P5A's package editor delegates the package
// `archive` transition here rather than writing state directly.
//
// Mark Ready gates on THREE conditions (Edward ruling 31 — the `ready` state is what a
// visible ready-badge surfaces and what the human Implement trigger is justified by):
//   1. the plan is currently `hardening`;
//   2. at least one non-archived package exists;
//   3. every *populated* plan tab has a supervisor overview (the empty Packages
//      placeholder is `populated:false`, so it never forces a spurious overview —
//      WP-P4A/P4C-editor); and
//   4. the plan has a valid responsible supervisor.
// It returns a structured result (never throws on an unmet condition) so the surface
// can render exactly why a plan is not yet ready.

import type { Plan, PlanTabKey } from '../../shared/types';
import {
  archivePlanClosingRun,
  confirmPlanDispatchAttempt,
  getActivePlanExecutionRun,
  getAgent,
  getPlan,
  getPlanWorkPackage,
  getPlanTabOverview,
  insertPlanDispatchAttempt,
  listPlanWorkPackages,
  markPlanDispatchAttemptFailed,
  planItemInPlan,
  planHasValidResponsibleSupervisor,
  reconcilePlanDispatchAttempts,
  transitionPlanWorkPackageState,
  updatePlan,
  type ArchivePlanClosingRunResult,
  type PlanExecutionRun,
  type PlanDispatchAttempt,
  type PlanDispatchReconcileResult,
  type PlanWorkPackage,
  type PlanWpLifecycleEvent,
  type PlanWpTransitionState,
} from '../database';
import {
  resolvePackageDispatchContext,
  type DispatchContext,
  type DispatchDeps,
  type PlanBindingResolution,
} from '../git-checkpoints/dispatch-context';
import { buildPlanDocuments } from './plan-documents';
import {
  implementPlan,
  type ImplementFailure,
  type ImplementPlanDeps,
  type ImplementResult,
} from './plan-implement';

export const PLAN_RUN_STATE_HARDENING = 'hardening';
export const PLAN_RUN_STATE_READY = 'ready';

// ── package dispatch + durable confirmation (WP-P5-dispatch) ──────────────────

export type PackageDeliveryResult =
  | { disposition: 'failed'; reason?: string | null }
  | { disposition: 'delivered-unconfirmed' }
  | { disposition: 'confirmed'; confirmedTurnId: string; confirmedAt: number };

export interface PackageDispatchInput {
  attemptId: string;
  lifecycleEventId: string;
  packageId: string;
  planId: string;
  planItemId: string;
  targetAgentId: string;
  ownerAgentId: string | null;
  promptText: string;
  createdAt: number;
}

export interface PackageDispatchDeps {
  getPackage?: typeof getPlanWorkPackage;
  getActiveRun?: typeof getActivePlanExecutionRun;
  dispatchDeps?: DispatchDeps;
  insertAttempt?: typeof insertPlanDispatchAttempt;
  markFailed?: typeof markPlanDispatchAttemptFailed;
  confirmAttempt?: typeof confirmPlanDispatchAttempt;
  deliver: (input: {
    targetAgentId: string;
    promptText: string;
    dispatch: DispatchContext;
  }) => Promise<PackageDeliveryResult>;
}

type PackageBindingFailure = Extract<PlanBindingResolution, { ok: false }>['reason'];

export type PackageDispatchFailure =
  | 'package-not-found'
  | 'package-plan-item-mismatch'
  | 'package-not-ready'
  | 'target-agent-not-found'
  | 'target-agent-workspace-mismatch'
  | 'structured-plan-not-implemented'
  | PackageBindingFailure
  | 'send-failed'
  | 'confirmation-persist-failed';

export interface PackageDispatchResult {
  ok: boolean;
  attempt: PlanDispatchAttempt | null;
  disposition: PackageDeliveryResult['disposition'] | null;
  failure: PackageDispatchFailure | null;
  diagnostic?: string;
}

function defaultPackageDispatchDeps(): DispatchDeps {
  return {
    getAgent: (id) => getAgent(id),
    resolveCapability: async () => null,
    planInWorkspace: (workspaceId, planId) => getPlan(planId)?.workspaceId === workspaceId,
    planItemInPlan: (workspaceId, planId, planItemId) =>
      planItemInPlan(workspaceId, planId, planItemId),
    planImplementGate: (planId) => {
      const plan = getPlan(planId);
      if (!plan) return null;
      return {
        isStructured: plan.format === 'structured',
        hasActiveExecutionRun: getActivePlanExecutionRun(planId) !== null,
      };
    },
  };
}

/**
 * Dispatch one ready work package. Validation and the active-run gate happen before
 * the durable pending insert; that insert completes before `deliver` is invoked.
 * Only a confirmed turn start can atomically move the package to `executing`.
 */
export async function dispatchPlanPackage(
  input: PackageDispatchInput,
  deps: PackageDispatchDeps,
): Promise<PackageDispatchResult> {
  const getPackage = deps.getPackage ?? getPlanWorkPackage;
  const getActiveRun = deps.getActiveRun ?? getActivePlanExecutionRun;
  const dispatchDeps = deps.dispatchDeps ?? defaultPackageDispatchDeps();
  const pkg = getPackage(input.packageId);
  if (!pkg) {
    return { ok: false, attempt: null, disposition: null, failure: 'package-not-found' };
  }
  if (
    pkg.planId !== input.planId
    || pkg.id !== input.planItemId
  ) {
    return { ok: false, attempt: null, disposition: null, failure: 'package-plan-item-mismatch' };
  }
  if (pkg.state !== 'ready') {
    return { ok: false, attempt: null, disposition: null, failure: 'package-not-ready' };
  }
  const agent = dispatchDeps.getAgent(input.targetAgentId);
  if (!agent) {
    return { ok: false, attempt: null, disposition: null, failure: 'target-agent-not-found' };
  }
  if (agent.workspaceId !== pkg.workspaceId) {
    return {
      ok: false, attempt: null, disposition: null,
      failure: 'target-agent-workspace-mismatch',
    };
  }
  const activeRun = getActiveRun(input.planId);
  if (!activeRun) {
    return {
      ok: false, attempt: null, disposition: null,
      failure: 'structured-plan-not-implemented',
    };
  }
  const resolved = resolvePackageDispatchContext(dispatchDeps, agent, {
    ownerAgentId: input.ownerAgentId,
    planId: input.planId,
    planItemId: input.planItemId,
    taskLabel: pkg.title,
  });
  if (!resolved.ok) {
    return { ok: false, attempt: null, disposition: null, failure: resolved.reason };
  }
  const insertAttempt = deps.insertAttempt ?? insertPlanDispatchAttempt;
  const markFailed = deps.markFailed ?? markPlanDispatchAttemptFailed;
  const confirmAttempt = deps.confirmAttempt ?? confirmPlanDispatchAttempt;
  let attempt = insertAttempt({
    id: input.attemptId,
    packageId: input.packageId,
    planId: input.planId,
    executionRunId: activeRun.id,
    targetAgentId: input.targetAgentId,
    requestedPlanItemId: input.planItemId,
    createdAt: input.createdAt,
  });
  let delivery: PackageDeliveryResult;
  try {
    delivery = await deps.deliver({
      targetAgentId: input.targetAgentId,
      promptText: input.promptText,
      dispatch: resolved.dispatch,
    });
  } catch (err) {
    attempt = markFailed(input.attemptId);
    return {
      ok: false, attempt, disposition: 'failed', failure: 'send-failed',
      diagnostic: err instanceof Error ? err.message : String(err),
    };
  }
  if (delivery.disposition === 'failed') {
    attempt = markFailed(input.attemptId);
    return {
      ok: false, attempt, disposition: 'failed', failure: 'send-failed',
      diagnostic: delivery.reason ?? undefined,
    };
  }
  if (delivery.disposition === 'delivered-unconfirmed') {
    return { ok: true, attempt, disposition: delivery.disposition, failure: null };
  }
  try {
    attempt = confirmAttempt({
      attemptId: input.attemptId,
      confirmedTurnId: delivery.confirmedTurnId,
      eventId: input.lifecycleEventId,
      actor: input.ownerAgentId ?? 'package-dispatch',
      confirmedAt: delivery.confirmedAt,
    });
    return { ok: true, attempt, disposition: 'confirmed', failure: null };
  } catch (err) {
    return {
      ok: false, attempt, disposition: 'confirmed', failure: 'confirmation-persist-failed',
      diagnostic: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The idempotent startup/periodic hook exposed to the app lifecycle. Database
 * initialization invokes the same primitive once at boot. */
export function reconcilePackageDispatches(now?: number): PlanDispatchReconcileResult {
  return reconcilePlanDispatchAttempts(now);
}

// ── package state transitions ─────────────────────────────────────────────────

export interface TransitionPackageInput {
  eventId: string;
  packageId: string;
  toState: PlanWpTransitionState;
  actor: string;
  reason?: string | null;
  ts: number;
}

export interface LifecycleTransitionDeps {
  transition?: typeof transitionPlanWorkPackageState;
}

/** Transition a package to a non-terminal state, ledgering the move. The service
 *  entry point for every ready/executing/blocked/archived transition. */
export function transitionPackage(
  input: TransitionPackageInput,
  deps: LifecycleTransitionDeps = {},
): PlanWpLifecycleEvent {
  const transition = deps.transition ?? transitionPlanWorkPackageState;
  return transition(input);
}

/** The package `archive` transition. WP-P5A's editor delegates here — it never
 *  writes `state='archived'` directly. */
export function archivePackage(
  input: Omit<TransitionPackageInput, 'toState'>,
  deps: LifecycleTransitionDeps = {},
): PlanWpLifecycleEvent {
  return transitionPackage({ ...input, toState: 'archived' }, deps);
}

// ── Mark Ready ────────────────────────────────────────────────────────────────

export type MarkReadyFailure =
  | 'plan-not-found'
  | 'plan-not-hardening'
  | 'no-active-package'
  | 'tab-overview-missing'
  | 'no-valid-responsible-supervisor';

export interface MarkReadyResult {
  ok: boolean;
  runState: string | null;
  failures: MarkReadyFailure[];
  /** Populated tabs that are still missing a supervisor overview (diagnostic). */
  tabsMissingOverview: PlanTabKey[];
}

export interface MarkReadyDeps {
  getPlan?: (planId: string) => Plan | null;
  listPackages?: (planId: string) => PlanWorkPackage[];
  /** The tabs that carry real content (documents/overview, or populated Packages). */
  getPopulatedTabs?: (planId: string) => PlanTabKey[];
  /** True when a non-empty supervisor overview exists for (planId, tab). */
  hasOverview?: (planId: string, tab: PlanTabKey) => boolean;
  hasValidResponsibleSupervisor?: (planId: string) => boolean;
  setRunState?: (planId: string, runState: string) => void;
}

function defaultPopulatedTabs(planId: string): PlanTabKey[] {
  const model = buildPlanDocuments(planId);
  if (!model) return [];
  return model.tabs.filter((tab) => tab.populated).map((tab) => tab.key);
}

function defaultHasOverview(planId: string, tab: PlanTabKey): boolean {
  const overview = getPlanTabOverview(planId, tab);
  return !!overview && typeof overview.body === 'string' && overview.body.trim() !== '';
}

/**
 * Attempt the plan-level `hardening → ready` transition. Flips `run_state` ONLY when
 * all conditions hold; otherwise returns `ok:false` with the unmet conditions and
 * leaves `run_state` untouched. A visible ready-badge (ruling 31) reads the resulting
 * `run_state`; the surface renders `failures` to explain a not-yet-ready plan.
 */
export function markPlanReady(
  input: { planId: string; actor: string },
  deps: MarkReadyDeps = {},
): MarkReadyResult {
  const getPlanFn = deps.getPlan ?? getPlan;
  const listPackages = deps.listPackages ?? listPlanWorkPackages;
  const getPopulatedTabs = deps.getPopulatedTabs ?? defaultPopulatedTabs;
  const hasOverview = deps.hasOverview ?? defaultHasOverview;
  const hasValidSupervisor =
    deps.hasValidResponsibleSupervisor ?? planHasValidResponsibleSupervisor;
  const setRunState =
    deps.setRunState ?? ((planId, runState) => { updatePlan(planId, { runState }); });

  const failures: MarkReadyFailure[] = [];
  const tabsMissingOverview: PlanTabKey[] = [];

  const plan = getPlanFn(input.planId);
  if (!plan) {
    return { ok: false, runState: null, failures: ['plan-not-found'], tabsMissingOverview };
  }
  if (plan.runState !== PLAN_RUN_STATE_HARDENING) {
    failures.push('plan-not-hardening');
  }
  const packages = listPackages(input.planId);
  if (!packages.some((pkg) => pkg.state !== 'archived')) {
    failures.push('no-active-package');
  }
  for (const tab of getPopulatedTabs(input.planId)) {
    if (!hasOverview(input.planId, tab)) tabsMissingOverview.push(tab);
  }
  if (tabsMissingOverview.length > 0) {
    failures.push('tab-overview-missing');
  }
  if (!hasValidSupervisor(input.planId)) {
    failures.push('no-valid-responsible-supervisor');
  }

  if (failures.length > 0) {
    return { ok: false, runState: plan.runState, failures, tabsMissingOverview };
  }
  setRunState(input.planId, PLAN_RUN_STATE_READY);
  return { ok: true, runState: PLAN_RUN_STATE_READY, failures: [], tabsMissingOverview };
}

// ── plan archive / resurrection / re-implement (WP-P5-archive) ─────────────────
//
// Plan-level transitions layered on the P5C run primitives. A FINISHED or abandoned
// plan is archived as a historical artifact (its active run closed; the run row + its
// baseline ref RETAINED for audit — release only on plan deletion, per P5C); an
// archived plan can be resurrected to `ready` to sit indefinitely; re-Implement mints a
// BRAND-NEW execution run (fresh baseline ref via the P5C idiom) and NEVER resurrects a
// closed run's row. `done` is never written here (SC-WP-3C-authoritative), and no
// package-content rollback happens — previously done/archived package revisions are
// retained, never flipped back to `ready`.

export const PLAN_RUN_STATE_EXECUTING = 'executing';
export const PLAN_RUN_STATE_ARCHIVED = 'archived';

export type ArchivePlanFailure = 'plan-not-found' | 'plan-not-archivable';

export interface ArchivePlanResult {
  ok: boolean;
  runState: string | null;
  /** The execution run this archive closed, or null when the plan had no active run. */
  closedRunId: string | null;
  failures: ArchivePlanFailure[];
}

export interface ArchivePlanDeps {
  getPlan?: (planId: string) => Plan | null;
  archive?: (planId: string) => ArchivePlanClosingRunResult;
}

/**
 * Archive a plan as a historical artifact: close its active execution run and flip the
 * plan `executing`/`ready` → `archived`, atomically (DB primitive). Only `executing`
 * and `ready` plans are archivable; any other state is refused with `plan-not-archivable`
 * (structured result, never throws on an unmet condition). Package states are untouched
 * (no content rollback); the closed run keeps its baseline ref for audit.
 */
export function archivePlan(
  input: { planId: string; actor: string },
  deps: ArchivePlanDeps = {},
): ArchivePlanResult {
  const getPlanFn = deps.getPlan ?? getPlan;
  const archive = deps.archive ?? archivePlanClosingRun;

  const plan = getPlanFn(input.planId);
  if (!plan) {
    return { ok: false, runState: null, closedRunId: null, failures: ['plan-not-found'] };
  }
  if (plan.runState !== PLAN_RUN_STATE_EXECUTING && plan.runState !== PLAN_RUN_STATE_READY) {
    return {
      ok: false,
      runState: plan.runState,
      closedRunId: null,
      failures: ['plan-not-archivable'],
    };
  }
  const result = archive(input.planId);
  return {
    ok: true,
    runState: result.plan.runState,
    closedRunId: result.closedRun?.id ?? null,
    failures: [],
  };
}

export type ResurrectPlanFailure = 'plan-not-found' | 'plan-not-archived';

export interface ResurrectPlanResult {
  ok: boolean;
  runState: string | null;
  failures: ResurrectPlanFailure[];
}

export interface ResurrectPlanDeps {
  getPlan?: (planId: string) => Plan | null;
  setRunState?: (planId: string, runState: string) => void;
}

/**
 * Resurrect an archived plan back to `ready` so it can sit indefinitely or be
 * re-Implemented. ONLY flips the plan `run_state archived → ready`: it never resurrects
 * a closed execution-run row and never flips done/archived package revisions back to
 * `ready`. Only an `archived` plan is resurrectable.
 */
export function resurrectPlan(
  input: { planId: string; actor: string },
  deps: ResurrectPlanDeps = {},
): ResurrectPlanResult {
  const getPlanFn = deps.getPlan ?? getPlan;
  const setRunState =
    deps.setRunState ?? ((planId, runState) => { updatePlan(planId, { runState }); });

  const plan = getPlanFn(input.planId);
  if (!plan) return { ok: false, runState: null, failures: ['plan-not-found'] };
  if (plan.runState !== PLAN_RUN_STATE_ARCHIVED) {
    return { ok: false, runState: plan.runState, failures: ['plan-not-archived'] };
  }
  setRunState(input.planId, PLAN_RUN_STATE_READY);
  return { ok: true, runState: PLAN_RUN_STATE_READY, failures: [] };
}

export interface ReimplementPlanResult {
  ok: boolean;
  /** Whether the archived→ready resurrection flip happened. */
  resurrected: boolean;
  /** The FRESH execution run minted by Implement (new id + fresh baseline), or null. */
  run: PlanExecutionRun | null;
  failures: (ResurrectPlanFailure | ImplementFailure)[];
  tabsMissingOverview: PlanTabKey[];
}

export interface ReimplementPlanDeps extends ResurrectPlanDeps {
  implementPlan?: (
    input: { planId: string; appUserId: string | null },
    deps?: ImplementPlanDeps,
  ) => Promise<ImplementResult>;
  implementDeps?: ImplementPlanDeps;
}

/**
 * Re-Implement an archived plan: resurrect it (`archived → ready`) then pull Implement,
 * which mints a BRAND-NEW `plan_execution_runs` row with a FRESH baseline ref via the
 * P5C idiom. The previously-archived run's row and baseline ref are never touched —
 * re-Implement NEVER resurrects a closed run. If Implement fails AFTER resurrection the
 * plan is left `ready` (a valid indefinitely-sitting state, `resurrected:true`), never
 * a half-executing plan.
 */
export async function reimplementPlan(
  input: { planId: string; appUserId: string | null },
  deps: ReimplementPlanDeps = {},
): Promise<ReimplementPlanResult> {
  const resurrect = resurrectPlan(
    { planId: input.planId, actor: input.appUserId ?? 'reimplement' },
    deps,
  );
  if (!resurrect.ok) {
    return {
      ok: false,
      resurrected: false,
      run: null,
      failures: resurrect.failures,
      tabsMissingOverview: [],
    };
  }
  const implement = deps.implementPlan ?? implementPlan;
  const result = await implement(
    { planId: input.planId, appUserId: input.appUserId },
    deps.implementDeps,
  );
  return {
    ok: result.ok,
    resurrected: true,
    run: result.run,
    failures: result.failures,
    tabsMissingOverview: result.tabsMissingOverview,
  };
}
