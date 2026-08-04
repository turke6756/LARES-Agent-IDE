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
  getPlan,
  getPlanTabOverview,
  listPlanWorkPackages,
  planHasValidResponsibleSupervisor,
  transitionPlanWorkPackageState,
  updatePlan,
  type PlanWorkPackage,
  type PlanWpLifecycleEvent,
  type PlanWpTransitionState,
} from '../database';
import { buildPlanDocuments } from './plan-documents';

export const PLAN_RUN_STATE_HARDENING = 'hardening';
export const PLAN_RUN_STATE_READY = 'ready';

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
