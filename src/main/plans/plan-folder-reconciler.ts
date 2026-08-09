import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../../shared/types';
import { isPlanArtifactId } from '../../shared/planning-artifact-ids';
import {
  adoptStructuredPlan,
  recordPlanSourceProposalProjectionStatus,
  type StructuredPlanChange,
} from '../database';
import { workspaceStateDir, workspaceStateDirName } from '../workspace-state-dir';
import { scanPlanIntentLedger, type ScanPlanIntentLedgerResult } from './plan-intent-ledger';
import {
  reconcilePlanFolderPlanningState,
  type PlanFolderProjectionReconcileResult,
} from './plan-work-package-ingest';
import {
  reconcilePlanSourceProposal,
  type SourceProposalProjectionResult,
} from './plan-source-proposal-reconciler';

export type PlanFolderReconcileChangeKind = 'boot' | 'adopted' | 'changed' | 'manual';
export type AdoptFailureReason = 'absent' | 'malformed' | 'no-artifact-id' | 'non-contract-artifact-id' | 'conflict';

export interface AdoptResult {
  adopted: boolean;
  planId?: string;
  change?: StructuredPlanChange;
  artifactId?: string;
  reason?: AdoptFailureReason;
}

export interface PlanFolderProjectionResult {
  planId: string;
  folderRelPath: string;
  intentLedger: ScanPlanIntentLedgerResult;
  sourceProposal: SourceProposalProjectionResult;
  responsibility: PlanFolderProjectionReconcileResult['responsibility'];
  workPackages: PlanFolderProjectionReconcileResult['workPackages'];
  overview: PlanFolderProjectionReconcileResult['overview'];
}

export interface ReconcilePlanFolderProjectionsInput {
  workspace: Workspace;
  planFolderRelPath: string;
  changeKind?: PlanFolderReconcileChangeKind;
  downstreamCallbacks?: Array<(
    result: PlanFolderProjectionResult,
    changeKind: PlanFolderReconcileChangeKind,
  ) => Promise<void> | void>;
  now?: () => number;
  /** Test-only observers preserve production ordering while making it explicit. */
  services?: {
    scanIntentLedger?: typeof scanPlanIntentLedger;
    reconcileSourceProposal?: typeof reconcilePlanSourceProposal;
    reconcilePlanningState?: typeof reconcilePlanFolderPlanningState;
  };
}

class PlanFolderAdoptionError extends Error {
  constructor(readonly reason: AdoptFailureReason) {
    super(`plan folder adoption failed: ${reason}`);
  }
}

function resolveFolder(workspace: Workspace, relPath: string): { folderAbs: string; folderRelPath: string } | null {
  if (relPath.includes('\\')) return null;
  const parts = relPath.replace(/\/+$/, '').split('/');
  const stateName = workspaceStateDirName(workspace.path, workspace.pathType);
  if (parts.length !== 3 || parts[0] !== stateName || parts[1] !== 'plans'
      || parts[2] === '' || parts[2] === '.' || parts[2] === '..') return null;
  const folderRelPath = `${stateName}/plans/${parts[2]}`;
  return { folderAbs: path.join(workspaceStateDir(workspace.path, workspace.pathType), 'plans', parts[2]), folderRelPath };
}

/** Row-adoption primitive only. Callers that require disk→DB convergence must
 * await reconcilePlanFolderProjections(), not infer it from this result. */
export async function adoptPlanFolderRow(
  workspace: Workspace,
  planFolderRelPath: string,
): Promise<AdoptResult> {
  const resolved = resolveFolder(workspace, planFolderRelPath);
  if (!resolved) return { adopted: false, reason: 'absent' };
  let manifest: Record<string, unknown>;
  try {
    const folderStat = fs.lstatSync(resolved.folderAbs);
    const manifestAbs = path.join(resolved.folderAbs, 'plan.json');
    const manifestStat = fs.lstatSync(manifestAbs);
    if (!folderStat.isDirectory() || folderStat.isSymbolicLink()
        || !manifestStat.isFile() || manifestStat.isSymbolicLink()
        || manifestStat.size > 1_000_000) return { adopted: false, reason: 'malformed' };
    const parsed = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { adopted: false, reason: 'malformed' };
    manifest = parsed as Record<string, unknown>;
  } catch (err) {
    return { adopted: false, reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'malformed' };
  }
  if (typeof manifest.plan_artifact_id !== 'string' || manifest.plan_artifact_id === '') {
    return { adopted: false, reason: 'no-artifact-id' };
  }
  if (!isPlanArtifactId(manifest.plan_artifact_id)) {
    return { adopted: false, reason: 'non-contract-artifact-id' };
  }
  let mtimeMs = 0;
  let sizeBytes = 0;
  try {
    const stat = fs.lstatSync(path.join(resolved.folderAbs, 'plan.md'));
    if (stat.isFile() && !stat.isSymbolicLink()) {
      mtimeMs = stat.mtimeMs;
      sizeBytes = stat.size;
    }
  } catch { /* plan.md absence is tolerated by the structured folder contract */ }
  try {
    const adopted = adoptStructuredPlan({
      workspaceId: workspace.id,
      artifactId: manifest.plan_artifact_id,
      folderRelPath: resolved.folderRelPath,
      planPath: `${resolved.folderRelPath}/plan.md`,
      mtimeMs,
      sizeBytes,
    });
    return { adopted: true, planId: adopted.planId, change: adopted.change,
      artifactId: manifest.plan_artifact_id };
  } catch {
    return { adopted: false, reason: 'conflict' };
  }
}

type DownstreamCallback = NonNullable<ReconcilePlanFolderProjectionsInput['downstreamCallbacks']>[number];
interface InFlightReconciliation {
  promise: Promise<PlanFolderProjectionResult>;
  callbacks: Array<{ callback: DownstreamCallback; changeKind: PlanFolderReconcileChangeKind }>;
}
const inFlight = new Map<string, InFlightReconciliation>();

/** The sole ordered folder-derived projection coordinator:
 * adopt row → intent ledger → source proposal → responsibility → work packages
 * → overview → downstream callbacks. Each projection keeps its own transaction. */
export function reconcilePlanFolderProjections(
  input: ReconcilePlanFolderProjectionsInput,
): Promise<PlanFolderProjectionResult> {
  const resolved = resolveFolder(input.workspace, input.planFolderRelPath);
  const key = `${input.workspace.id}\0${resolved?.folderRelPath ?? input.planFolderRelPath}`;
  const joined = inFlight.get(key);
  if (joined) {
    joined.callbacks.push(...(input.downstreamCallbacks ?? []).map((callback) => ({
      callback, changeKind: input.changeKind ?? 'manual',
    })));
    return joined.promise;
  }

  const entry: InFlightReconciliation = {
    promise: undefined as unknown as Promise<PlanFolderProjectionResult>,
    callbacks: (input.downstreamCallbacks ?? []).map((callback) => ({
      callback, changeKind: input.changeKind ?? 'manual',
    })),
  };

  const run = (async (): Promise<PlanFolderProjectionResult> => {
    if (!resolved) throw new PlanFolderAdoptionError('absent');
    const adoption = await adoptPlanFolderRow(input.workspace, resolved.folderRelPath);
    if (!adoption.adopted || !adoption.planId) {
      throw new PlanFolderAdoptionError(adoption.reason ?? 'conflict');
    }
    const planId = adoption.planId;
    const services = input.services ?? {};
    const intentLedger = (services.scanIntentLedger ?? scanPlanIntentLedger)({
      workspaceId: input.workspace.id,
      workspaceRoot: input.workspace.path,
      planId,
      folderAbs: resolved.folderAbs,
      folderRelPath: resolved.folderRelPath,
      now: input.now,
    });
    let sourceProposal: SourceProposalProjectionResult;
    try {
      sourceProposal = (services.reconcileSourceProposal ?? reconcilePlanSourceProposal)({
        workspace: input.workspace,
        planId,
        folderAbs: resolved.folderAbs,
        expectedPlanArtifactId: adoption.artifactId!,
        now: input.now,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const state = recordPlanSourceProposalProjectionStatus({
        planId, workspaceId: input.workspace.id, status: 'invalid',
        sourceArtifactId: null, sourceRelPath: null,
        diagnosticCode: 'source-reconciler-failed',
        diagnosticsJson: JSON.stringify([{ code: 'source-reconciler-failed', detail }]),
        observedManifestMtime: null,
        reconciledAt: (input.now ?? (() => Date.now()))(),
      });
      sourceProposal = { ...state, diagnostics: [{ code: 'source-reconciler-failed', detail }] };
    }
    const planning = (services.reconcilePlanningState ?? reconcilePlanFolderPlanningState)({
      workspaceId: input.workspace.id,
      planId,
      folderAbs: resolved.folderAbs,
      folderRelPath: resolved.folderRelPath,
      now: input.now,
    });
    const result: PlanFolderProjectionResult = {
      planId,
      folderRelPath: resolved.folderRelPath,
      intentLedger,
      sourceProposal,
      responsibility: planning.responsibility,
      workPackages: planning.workPackages,
      overview: planning.overview,
    };
    for (let index = 0; index < entry.callbacks.length; index += 1) {
      const queued = entry.callbacks[index];
      await queued.callback(result, queued.changeKind);
    }
    return result;
  })();
  entry.promise = run;
  inFlight.set(key, entry);
  void run.finally(() => {
    if (inFlight.get(key) === entry) inFlight.delete(key);
  }).catch(() => { /* the caller owns the original rejection */ });
  return run;
}
