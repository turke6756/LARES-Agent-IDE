import type { Agent, StopResult, Workspace } from '../../shared/types';
import {
  dropLegacyPromotionRequestsIfReady,
  getAgent,
  getOrchestrationRun,
  getPromotionWorkerMember,
  getWorkspace,
  listOrchestrationEvents,
  listOrchestrationRuns,
  listPendingPromotionRequests,
  recordLegacyPromotionPendingDiagnostic,
  repairLegacyPromotionRequestPointer,
  terminalizeLegacyPromotionRequest,
  type LegacyPromotionRetirementResult,
  type PromotionRequestRow,
} from '../database';
import type { ClaimScanFn, ClaimScanResult } from './promote-proposal';
import {
  reconcilePlanFolderProjections,
  type PlanFolderProjectionResult,
} from './plan-folder-reconciler';
import type { DeliveryProbe, PromotionDeliveryInspector } from './promotion-dispatch';

const TERMINAL_AGENT = new Set(['done', 'crashed']);
const TERMINAL_RUN = new Set(['complete', 'stalled', 'aborted', 'error']);

export type LegacyPromotionDrainOutcome =
  | 'adopted'
  | 'failed'
  | 'submit-only-recovery'
  | 'left-pending';

export interface LegacyPromotionDrainEntry {
  requestId: string;
  branch: DeliveryProbe['state'] | 'matching-folder' | 'duplicate-folder';
  outcome: LegacyPromotionDrainOutcome;
  diagnostic?: string;
}

export interface LegacyPromotionDrainReport {
  processed: number;
  entries: LegacyPromotionDrainEntry[];
  retirement: LegacyPromotionRetirementResult;
}

export interface LegacyPromotionDrainDeps {
  inspector: PromotionDeliveryInspector;
  scanClaims: ClaimScanFn;
  reconcileFolder?: (workspace: Workspace, folderRelPath: string) => Promise<PlanFolderProjectionResult>;
  listPending?: () => PromotionRequestRow[];
  getWorkspace?: (workspaceId: string) => Workspace | null;
  getRun?: typeof getOrchestrationRun;
  getAgent?: (agentId: string) => Agent | null;
  hasLiveRuntime: (agentId: string) => boolean;
  stopAgent: (agentId: string) => Promise<StopResult>;
  retire?: (input: {
    activeDrain: boolean;
    unverifiedLiveBoundAgentIds: readonly string[];
  }) => LegacyPromotionRetirementResult;
  now?: () => Date;
  onDiagnostic?: (requestId: string, detail: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reservedRunIdsForRequest(requestId: string): string[] {
  const ids: string[] = [];
  for (const run of listOrchestrationRuns()) {
    if (run.name !== 'promotion') continue;
    const matches = listOrchestrationEvents(run.runId).some((event) => {
      if (event.kind !== 'promotion.reserved' || !event.payload || typeof event.payload !== 'object') return false;
      return (event.payload as { requestId?: unknown }).requestId === requestId;
    });
    if (matches) ids.push(run.runId);
  }
  return ids;
}

export class LegacyPromotionDrain {
  private operation: Promise<LegacyPromotionDrainReport> | null = null;
  private sweeping = false;
  private readonly unverifiedBoundAgents = new Set<string>();

  constructor(private readonly deps: LegacyPromotionDrainDeps) {}

  /** Single-flight sweep + retirement. The DROP is inside the same operation and
   * runs only after every request branch and projection await has settled. */
  drainAndRetire(): Promise<LegacyPromotionDrainReport> {
    if (this.operation) return this.operation;
    const run = this.runDrainAndRetire();
    this.operation = run;
    void run.finally(() => {
      if (this.operation === run) this.operation = null;
    }).catch(() => { /* caller observes the original rejection */ });
    return run;
  }

  private async runDrainAndRetire(): Promise<LegacyPromotionDrainReport> {
    this.sweeping = true;
    this.unverifiedBoundAgents.clear();
    const entries: LegacyPromotionDrainEntry[] = [];
    const pending = (this.deps.listPending ?? listPendingPromotionRequests)();
    try {
      for (const request of pending) {
        try {
          entries.push(await this.drainOne(request));
        } catch (error) {
          const diagnostic = `legacy-drain-error: ${errorMessage(error)}`;
          this.leavePending(request, diagnostic);
          entries.push({ requestId: request.id, branch: 'indeterminate', outcome: 'left-pending', diagnostic });
        }
      }
      await this.collectUnverifiedBoundAgents();
    } finally {
      this.sweeping = false;
    }

    const retire = this.deps.retire ?? dropLegacyPromotionRequestsIfReady;
    const retirement = retire({
      activeDrain: this.sweeping,
      unverifiedLiveBoundAgentIds: [...this.unverifiedBoundAgents],
    });
    return { processed: pending.length, entries, retirement };
  }

  private async drainOne(original: PromotionRequestRow): Promise<LegacyPromotionDrainEntry> {
    const claim = await this.deps.scanClaims({
      workspaceId: original.workspaceId,
      proposalArtifactId: original.proposalArtifactId,
      deterministicPlanArtifactId: original.planArtifactId,
      deterministicFolderRelPath: original.targetFolderRelPath,
    });
    const folderResult = await this.handleClaim(original, claim);
    if (folderResult) return folderResult;

    let request = original;
    if (!request.orchestrationId || !this.getRun(request.orchestrationId)) {
      const candidates = reservedRunIdsForRequest(request.id);
      if (candidates.length === 1) {
        repairLegacyPromotionRequestPointer(request.id, candidates[0], this.nowMs());
        request = { ...request, orchestrationId: candidates[0] };
      } else if (candidates.length === 0) {
        return this.fail(request, 'legacy-never-reserved', null, 'not-reserved');
      } else {
        const diagnostic = `legacy-reservation-inconsistent:${candidates.join(',')}`;
        this.leavePending(request, diagnostic);
        return { requestId: request.id, branch: 'not-reserved', outcome: 'left-pending', diagnostic };
      }
    }

    const runId = request.orchestrationId!;
    const probe = await this.deps.inspector.inspectDelivery(runId);
    switch (probe.state) {
      case 'not-reserved':
        return this.fail(request, 'legacy-never-reserved', null, probe.state);
      case 'reserved-unbound':
        return this.fail(request, 'legacy-not-delivered', 'aborted', probe.state);
      case 'bound-undelivered':
        return this.stopThenFail(request, probe.agentId, 'legacy-not-delivered', probe.state, 'aborted');
      case 'submitted-unconfirmed':
        return this.handleSubmittedUnconfirmed(request, probe.agentId);
      case 'delivered':
        return this.handleDeliveredWithoutFolder(request, probe.agentId);
      case 'indeterminate': {
        if (probe.boundAgentId) this.unverifiedBoundAgents.add(probe.boundAgentId);
        const diagnostic = `legacy-delivery-evidence-unreadable:${probe.diagnostic}`;
        this.leavePending(request, diagnostic);
        return { requestId: request.id, branch: probe.state, outcome: 'left-pending', diagnostic };
      }
    }
  }

  private async handleClaim(
    request: PromotionRequestRow,
    claim: ClaimScanResult,
  ): Promise<LegacyPromotionDrainEntry | null> {
    if (claim.kind === 'duplicate') {
      this.leavePending(request, `legacy-duplicate-folders:${claim.folderRelPaths.join(',')}`);
      return {
        requestId: request.id, branch: 'duplicate-folder', outcome: 'left-pending',
        diagnostic: claim.diagnostic,
      };
    }
    if (claim.kind !== 'claimed') return null;
    const workspace = (this.deps.getWorkspace ?? getWorkspace)(request.workspaceId);
    if (!workspace) {
      const diagnostic = 'legacy-workspace-unavailable';
      this.leavePending(request, diagnostic);
      return { requestId: request.id, branch: 'matching-folder', outcome: 'left-pending', diagnostic };
    }
    const reconcile = this.deps.reconcileFolder
      ?? ((ws: Workspace, folderRelPath: string) => reconcilePlanFolderProjections({
        workspace: ws, planFolderRelPath: folderRelPath, changeKind: 'manual',
      }));
    const projections = await reconcile(workspace, claim.folderRelPath);
    if (projections.sourceProposal.status !== 'synced' || projections.responsibility.status !== 'valid') {
      const diagnostic =
        `legacy-folder-not-converged:source=${projections.sourceProposal.status},` +
        `responsibility=${projections.responsibility.status}`;
      this.leavePending(request, diagnostic);
      return { requestId: request.id, branch: 'matching-folder', outcome: 'left-pending', diagnostic };
    }
    terminalizeLegacyPromotionRequest({
      requestId: request.id,
      requestState: 'adopted',
      reason: null,
      runId: request.orchestrationId,
      runStatus: request.orchestrationId ? 'complete' : undefined,
      nowIso: this.nowIso(),
      nowMs: this.nowMs(),
    });
    return { requestId: request.id, branch: 'matching-folder', outcome: 'adopted' };
  }

  private async handleSubmittedUnconfirmed(
    request: PromotionRequestRow,
    agentId: string,
  ): Promise<LegacyPromotionDrainEntry> {
    const run = this.getRun(request.orchestrationId!);
    if (!run) {
      const diagnostic = 'legacy-submitted-run-unreadable';
      this.leavePending(request, diagnostic);
      return { requestId: request.id, branch: 'submitted-unconfirmed', outcome: 'left-pending', diagnostic };
    }
    const state = this.readAgentRuntime(agentId);
    if (!state.readable) {
      this.unverifiedBoundAgents.add(agentId);
      const diagnostic = 'legacy-submitted-agent-state-unreadable';
      this.leavePending(request, diagnostic);
      return { requestId: request.id, branch: 'submitted-unconfirmed', outcome: 'left-pending', diagnostic };
    }
    const runLive = !TERMINAL_RUN.has(run.status);
    const agentTerminal = !state.agent || TERMINAL_AGENT.has(state.agent.status);
    if (runLive && !agentTerminal && state.liveRuntime) {
      await this.deps.inspector.resumeSubmitOnly(request.orchestrationId!);
      const after = await this.deps.inspector.inspectDelivery(request.orchestrationId!);
      if (after.state === 'delivered') {
        return {
          requestId: request.id, branch: 'submitted-unconfirmed', outcome: 'submit-only-recovery',
          diagnostic: 'legacy-submit-recovered-awaiting-folder',
        };
      }
      const diagnostic = after.state === 'indeterminate'
        ? `legacy-submit-recovery-unreadable:${after.diagnostic}`
        : 'legacy-submit-recovery-unconfirmed';
      this.leavePending(request, diagnostic);
      return { requestId: request.id, branch: 'submitted-unconfirmed', outcome: 'left-pending', diagnostic };
    }
    if (!runLive && !agentTerminal) {
      return this.stopThenFail(
        request, agentId, 'legacy-submitted-unconfirmed-terminal',
        'submitted-unconfirmed', 'error',
      );
    }
    if (agentTerminal && !state.liveRuntime) {
      return this.fail(
        request, 'legacy-submitted-unconfirmed-terminal', 'error', 'submitted-unconfirmed',
      );
    }
    const diagnostic = 'legacy-submitted-agent-runtime-ambiguous';
    this.unverifiedBoundAgents.add(agentId);
    this.leavePending(request, diagnostic);
    return { requestId: request.id, branch: 'submitted-unconfirmed', outcome: 'left-pending', diagnostic };
  }

  private async handleDeliveredWithoutFolder(
    request: PromotionRequestRow,
    agentId: string,
  ): Promise<LegacyPromotionDrainEntry> {
    const run = this.getRun(request.orchestrationId!);
    if (!run || !TERMINAL_RUN.has(run.status)) {
      const diagnostic = 'legacy-delivered-awaiting-folder';
      this.leavePending(request, diagnostic);
      return { requestId: request.id, branch: 'delivered', outcome: 'left-pending', diagnostic };
    }
    const state = this.readAgentRuntime(agentId);
    if (!state.readable) {
      this.unverifiedBoundAgents.add(agentId);
      const diagnostic = 'legacy-delivered-agent-state-unreadable';
      this.leavePending(request, diagnostic);
      return { requestId: request.id, branch: 'delivered', outcome: 'left-pending', diagnostic };
    }
    if (state.liveRuntime || (state.agent && !TERMINAL_AGENT.has(state.agent.status))) {
      return this.stopThenFail(request, agentId, 'legacy-delivered-no-folder', 'delivered', 'error');
    }
    return this.fail(request, 'legacy-delivered-no-folder', 'error', 'delivered');
  }

  private async stopThenFail(
    request: PromotionRequestRow,
    agentId: string,
    reason: string,
    branch: DeliveryProbe['state'],
    runStatus: 'aborted' | 'error',
  ): Promise<LegacyPromotionDrainEntry> {
    let stop: StopResult;
    try {
      stop = await this.deps.stopAgent(agentId);
    } catch (error) {
      const diagnostic = `legacy-bound-agent-stop-unconfirmed:${errorMessage(error)}`;
      this.unverifiedBoundAgents.add(agentId);
      this.leavePending(request, diagnostic);
      return { requestId: request.id, branch, outcome: 'left-pending', diagnostic };
    }
    const verified = this.readAgentRuntime(agentId);
    const terminal = verified.readable
      && (!verified.agent || TERMINAL_AGENT.has(verified.agent.status))
      && !verified.liveRuntime;
    if (stop.outcome === 'failed' || !terminal) {
      const diagnostic = 'legacy-bound-agent-stop-unconfirmed';
      this.unverifiedBoundAgents.add(agentId);
      this.leavePending(request, diagnostic);
      return { requestId: request.id, branch, outcome: 'left-pending', diagnostic };
    }
    return this.fail(request, reason, runStatus, branch);
  }

  private fail(
    request: PromotionRequestRow,
    reason: string,
    runStatus: 'aborted' | 'error' | null,
    branch: DeliveryProbe['state'],
  ): LegacyPromotionDrainEntry {
    terminalizeLegacyPromotionRequest({
      requestId: request.id,
      requestState: 'failed',
      reason,
      runId: request.orchestrationId,
      runStatus: runStatus ?? undefined,
      nowIso: this.nowIso(),
      nowMs: this.nowMs(),
    });
    return { requestId: request.id, branch, outcome: 'failed', diagnostic: reason };
  }

  private leavePending(request: PromotionRequestRow, diagnostic: string): void {
    recordLegacyPromotionPendingDiagnostic(request.id, diagnostic, this.nowMs());
    this.deps.onDiagnostic?.(request.id, diagnostic);
  }

  private getRun(runId: string) {
    return (this.deps.getRun ?? getOrchestrationRun)(runId);
  }

  private readAgentRuntime(agentId: string): {
    readable: boolean; agent: Agent | null; liveRuntime: boolean;
  } {
    try {
      return {
        readable: true,
        agent: (this.deps.getAgent ?? getAgent)(agentId),
        liveRuntime: this.deps.hasLiveRuntime(agentId),
      };
    } catch {
      return { readable: false, agent: null, liveRuntime: true };
    }
  }

  private async collectUnverifiedBoundAgents(): Promise<void> {
    for (const run of listOrchestrationRuns()) {
      if (run.name !== 'promotion') continue;
      const agentId = getPromotionWorkerMember(run.runId);
      if (!agentId) continue;
      const state = this.readAgentRuntime(agentId);
      if (!state.readable || state.liveRuntime) this.unverifiedBoundAgents.add(agentId);
    }
  }

  private nowDate(): Date { return (this.deps.now ?? (() => new Date()))(); }
  private nowIso(): string { return this.nowDate().toISOString(); }
  private nowMs(): number { return this.nowDate().getTime(); }
}
