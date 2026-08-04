// Planning-surface WP-P5C — the Implement trigger service. MAIN-PROCESS ONLY.
//
// Implement is an EXPLICIT HUMAN TRIGGER PULL (ruling: hardened/ready plans sit
// indefinitely — there is NO auto-dispatch). A `ready` plan (ruling 31: the visible
// ready-badge is what gates and justifies this) is turned into an EXECUTING plan with
// a durably-pinned baseline. The service is renderer-only / human-gesture initiated —
// there is deliberately no api-server route, so an agent cannot pull it, and the
// service additionally refuses any call lacking a real, app-observed `appUserId`.
//
// Eligibility (all re-checked here, not trusted from the ready flip):
//   1. the plan exists and is `format='structured'`;
//   2. the plan `run_state='ready'`;
//   3. at least one `ready` work package;
//   4. an overview for every populated tab;
//   5. a valid responsible supervisor;
//   6. a proven `appUserId` (never a claimed human identity the app cannot prove).
//
// Baseline durability + failure ordering (the load-bearing invariant):
//   • a `head` baseline creates the durable ref `refs/lares/plans/<planId>/<runId>` at
//     the probed HEAD OID BEFORE the run row commits — an OID in SQLite alone would not
//     protect an unreachable commit from Git GC;
//   • ref creation FAILS ⇒ NO run row is inserted (never an executing run without a
//     baseline);
//   • the run-row insert + `run_state ready→executing` flip happen in ONE txn
//     (insertPlanExecutionRunActivating); a txn failure AFTER ref creation leaves an
//     ORPHAN ref, GC'd by startup reconcilePlanBaselineOrphans (never a half state);
//   • an UNBORN HEAD stores `baseline_kind='unborn'` with no OID and no ref (an
//     explicit marker, not a bare nullable OID);
//   • a non-repository or bare repository is refused.
//
// This service NEVER writes `done` (SC-WP-3C-owned) and NEVER dispatches a worker
// (P5-dispatch, gated by P5C-gate on the active run this service creates).

import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';

import type { Plan, PlanTabKey } from '../../shared/types';
import {
  getPlan as dbGetPlan,
  getPlanTabOverview,
  getWorkspace,
  insertPlanExecutionRunActivating,
  listPlanWorkPackages,
  planHasValidResponsibleSupervisor,
  type PlanBaselineKind,
  type PlanExecutionRun,
  type PlanWorkPackage,
} from '../database';
import {
  forceCreatePlanBaselineRef,
  planBaselineRef,
  probePlanBaseline,
  type PlanBaselineProbe,
  type RefWriteResult,
} from '../git-checkpoints/plan-baseline-refs';
import { resolveInternalGit } from '../git/git-runtime';
import { buildPlanDocuments } from './plan-documents';

export const IMPLEMENT_TRIGGER_SOURCE = 'renderer-user-action';

export type ImplementFailure =
  | 'plan-not-found'
  | 'plan-not-structured'
  | 'plan-not-ready'
  | 'no-ready-package'
  | 'tab-overview-missing'
  | 'no-valid-responsible-supervisor'
  | 'no-app-user'
  | 'not-a-repository'
  | 'bare-repository'
  | 'baseline-ref-failed'
  | 'run-persist-failed';

export interface ImplementResult {
  ok: boolean;
  run: PlanExecutionRun | null;
  failures: ImplementFailure[];
  /** Populated tabs still missing a supervisor overview (diagnostic). */
  tabsMissingOverview: PlanTabKey[];
}

/** The per-plan git context Implement pins its baseline in. */
export interface PlanRepoContext {
  repoRoot: string;
  gitExe?: string;
  /** The topology key (SC-WP-1A repositoryKey) when derivable; null otherwise. */
  repositoryKey: string | null;
}

export interface ImplementPlanInput {
  planId: string;
  /** A REAL, app-observed user identity (main-side; NEVER a renderer-supplied claim).
   *  Absent/empty ⇒ the trigger is refused (`no-app-user`). */
  appUserId: string | null;
}

export interface ImplementPlanDeps {
  getPlan?: (planId: string) => Plan | null;
  listPackages?: (planId: string) => PlanWorkPackage[];
  getPopulatedTabs?: (planId: string) => PlanTabKey[];
  hasOverview?: (planId: string, tab: PlanTabKey) => boolean;
  hasValidResponsibleSupervisor?: (planId: string) => boolean;
  /** Resolve the plan's git context; null ⇒ treated as a non-repository. */
  resolveRepoContext?: (plan: Plan) => Promise<PlanRepoContext | null>;
  probeBaseline?: (ctx: PlanRepoContext) => Promise<PlanBaselineProbe>;
  createBaselineRef?: (
    ctx: PlanRepoContext,
    ref: string,
    oid: string,
  ) => Promise<RefWriteResult>;
  insertRun?: typeof insertPlanExecutionRunActivating;
  newRunId?: () => string;
  now?: () => number;
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

/** Default git-context resolver: workspace root as the repo root + the internal git
 *  exe. `repositoryKey` is left null here (a documented seam — the identity-derivation
 *  wiring lane may inject a resolver that computes SC-WP-1A's repositoryKey). */
async function defaultResolveRepoContext(plan: Plan): Promise<PlanRepoContext | null> {
  const ws = getWorkspace(plan.workspaceId);
  if (!ws || !ws.path) return null;
  const internal = await resolveInternalGit();
  return { repoRoot: ws.path, gitExe: internal?.execPath, repositoryKey: null };
}

/**
 * Attempt the human Implement trigger on a plan. Returns a structured result (never
 * throws on an unmet condition or a git refusal) so the surface can render exactly why
 * a trigger was refused. On success the plan is `executing` with a durable
 * `plan_execution_runs` row (and, for a head baseline, a durable ref pinned BEFORE the
 * row).
 */
export async function implementPlan(
  input: ImplementPlanInput,
  deps: ImplementPlanDeps = {},
): Promise<ImplementResult> {
  const getPlan = deps.getPlan ?? dbGetPlan;
  const listPackages = deps.listPackages ?? listPlanWorkPackages;
  const getPopulatedTabs = deps.getPopulatedTabs ?? defaultPopulatedTabs;
  const hasOverview = deps.hasOverview ?? defaultHasOverview;
  const hasValidSupervisor =
    deps.hasValidResponsibleSupervisor ?? planHasValidResponsibleSupervisor;
  const resolveRepoContext = deps.resolveRepoContext ?? defaultResolveRepoContext;
  const probeBaseline = deps.probeBaseline ?? ((ctx) => probePlanBaseline(ctx));
  const createBaselineRef =
    deps.createBaselineRef ??
    ((ctx, ref, oid) => forceCreatePlanBaselineRef({ ...ctx, ref, oid }));
  const insertRun = deps.insertRun ?? insertPlanExecutionRunActivating;
  const newRunId = deps.newRunId ?? uuidv4;
  const now = deps.now ?? Date.now;

  const failures: ImplementFailure[] = [];
  const tabsMissingOverview: PlanTabKey[] = [];
  const fail = (): ImplementResult => ({ ok: false, run: null, failures, tabsMissingOverview });

  // ── eligibility (no git touched until the plan is provably eligible) ──────────
  const plan = getPlan(input.planId);
  if (!plan) {
    failures.push('plan-not-found');
    return fail();
  }
  if (plan.format !== 'structured') failures.push('plan-not-structured');
  if (plan.runState !== 'ready') failures.push('plan-not-ready');
  if (!listPackages(input.planId).some((pkg) => pkg.state === 'ready')) {
    failures.push('no-ready-package');
  }
  for (const tab of getPopulatedTabs(input.planId)) {
    if (!hasOverview(input.planId, tab)) tabsMissingOverview.push(tab);
  }
  if (tabsMissingOverview.length > 0) failures.push('tab-overview-missing');
  if (!hasValidSupervisor(input.planId)) failures.push('no-valid-responsible-supervisor');
  if (!input.appUserId || input.appUserId.trim() === '') failures.push('no-app-user');

  if (failures.length > 0) return fail();

  // ── baseline probe (repo / bare / unborn / head) ─────────────────────────────
  const ctx = await resolveRepoContext(plan);
  if (!ctx) {
    failures.push('not-a-repository');
    return fail();
  }
  const probe = await probeBaseline(ctx);
  if (!probe.ok) {
    failures.push(probe.reason === 'bare-repo' ? 'bare-repository' : 'not-a-repository');
    return fail();
  }

  // ── pin the baseline: create ref BEFORE the run row (head only) ───────────────
  const runId = newRunId();
  let baselineKind: PlanBaselineKind;
  let baselineHeadOid: string | null = null;
  let baselineRef: string | null = null;
  if (probe.kind === 'head') {
    baselineKind = 'head';
    baselineHeadOid = probe.headOid;
    baselineRef = planBaselineRef(plan.id, runId);
    const created = await createBaselineRef(ctx, baselineRef, probe.headOid);
    if (!created.ok) {
      failures.push('baseline-ref-failed');
      return fail();
    }
  } else {
    // Unborn HEAD: explicit marker, no OID, no ref.
    baselineKind = 'unborn';
  }

  // ── activate: insert run row + flip run_state ready→executing (one txn) ───────
  // A throw here leaves the (already-created) head ref an ORPHAN for startup
  // reconciliation — never an executing plan without a run row.
  let run: PlanExecutionRun;
  try {
    run = insertRun({
      id: runId,
      planId: plan.id,
      repositoryKey: ctx.repositoryKey,
      baselineKind,
      baselineHeadOid,
      baselineRef,
      triggerSource: IMPLEMENT_TRIGGER_SOURCE,
      appUserId: input.appUserId,
      triggeredAt: now(),
    });
  } catch {
    failures.push('run-persist-failed');
    return fail();
  }

  return { ok: true, run, failures: [], tabsMissingOverview: [] };
}

// ── IPC wiring: renderer-only, human-gesture Implement channel ─────────────────
//
// Registered from registerPlanIpc. There is deliberately NO api-server route (an agent
// cannot reach ipcMain), and `appUserId` is derived MAIN-SIDE from the OS user the app
// runs as — never taken from the renderer payload — so the persisted trigger fields
// stay truthful.

/** Minimal `ipcMain.handle` shape so the channel registers without a live main. */
export interface PlanImplementIpcLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

/** The real, app-observed user identity. Main-side only — an app-provable origin, not a
 *  renderer claim. */
function currentAppUserId(): string | null {
  try {
    const name = os.userInfo().username;
    return name && name.trim() !== '' ? name : null;
  } catch {
    return null;
  }
}

export function registerPlanImplementIpc(ipcMain: PlanImplementIpcLike): void {
  ipcMain.handle('plan:implement', async (_e, planId: string): Promise<ImplementResult> => {
    if (typeof planId !== 'string' || planId.trim() === '') {
      return { ok: false, run: null, failures: ['plan-not-found'], tabsMissingOverview: [] };
    }
    return implementPlan({ planId, appUserId: currentAppUserId() });
  });
}
