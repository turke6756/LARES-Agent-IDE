import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { ORCHESTRATIONS } from './catalog';
import { runSerial, runParallel } from './groupthink-v2';
import { parseLegacyGroupthinkCommand } from './groupthink-legacy';
import {
  DashboardClient, RunOrchestrationRequest, OrchestrationRun,
  OrchestrationDescriptor, OrchestrationRunContext, OrchestrationRunner,
} from './types';
import { LAUNCHABLE_AGENT_PROVIDERS, isLaunchableAgentProvider } from '../../shared/types';
import {
  getWorkspace, getPlan,
  getActivePlanningIntentForLaunch,
  insertOrchestration, updateOrchestration, getOrchestrationRun, listOrchestrationRuns,
  insertOrchestrationEvent, insertOrchestrationMember, markActiveRunsAborted,
} from '../database';
import { getOrchestrationProviderSettingsCached } from './orchestration-provider-settings';
import { isPlanningIntentId } from '../../shared/planning-artifact-ids';

const READY_STATUSES = new Set(['idle', 'waiting']);

function nowIso(): string {
  return new Date().toISOString();
}

function httpErr(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export function assertGroupthinkProvider(role: 'lead_provider' | 'reviewer_provider', value: string | undefined): void {
  if (value === undefined) return;
  if (value === 'gemini') throw httpErr(422, 'Gemini provider discontinued; use Antigravity (agy). Historical Gemini agents remain readable.');
  if (!isLaunchableAgentProvider(value)) throw httpErr(422, `Unsupported ${role} '${value}'; expected one of ${LAUNCHABLE_AGENT_PROVIDERS.join(', ')}.`);
}

export class OrchestrationService extends EventEmitter {
  private controllers = new Map<string, AbortController>();
  private runners: { serial: OrchestrationRunner; parallel: OrchestrationRunner };

  constructor(
    private client: DashboardClient,
    private deliver: (supervisorId: string, text: string) => Promise<{ ok: boolean }>,
    // Injectable so the lifecycle (detach / persist / deliver / abort /
    // boot-reconcile) is unit-testable without the real relay loop.
    runners?: { serial: OrchestrationRunner; parallel: OrchestrationRunner },
  ) {
    super();
    this.runners = runners ?? { serial: runSerial, parallel: runParallel };
  }

  /** Supervisor ids that currently own an active (starting/running)
   *  deliberation. Drives the renderer's owner-container pulse so the border
   *  keeps animating through the idle gaps BETWEEN deliberation turns — when
   *  both planners are momentarily idle but the run is still alive. */
  activeSupervisorIds(): string[] {
    const ids = new Set<string>();
    for (const run of listOrchestrationRuns()) {
      if (run.status === 'starting' || run.status === 'running') ids.add(run.supervisorId);
    }
    return [...ids];
  }

  /** Re-broadcast the active-supervisor set after any run-status transition.
   *  Listeners (index.ts → renderer) treat the payload as authoritative, so an
   *  occasional redundant emit is harmless. */
  private emitActiveChanged(): void {
    this.emit('activeRunsChanged', this.activeSupervisorIds());
  }

  /** Boot reconcile: any row still 'starting'/'running' belonged to a previous
   *  dashboard process that died — mark aborted (reason dashboard_restarted),
   *  emit a stalled event carrying a resumeRunId hint. Member agents survive and
   *  can be resumed by id. */
  start(): void {
    const orphaned = markActiveRunsAborted('dashboard_restarted');
    for (const run of orphaned) {
      insertOrchestrationEvent({
        runId: run.runId, ts: nowIso(), kind: 'aborted',
        payload: { reason: 'dashboard_restarted' },
      });
      void this.relay(run.runId, run.supervisorId,
        `[DASHBOARD EVENT] orchestration.groupthink.stalled\n` +
        JSON.stringify({
          runId: run.runId, mode: run.mode, reason: 'dashboard_restarted',
          topic: run.topic, planPath: run.planPath,
          resume_hint: { tool: 'run_orchestration', name: 'groupthink', params: { resumeRunId: run.runId } },
        }, null, 2));
    }
    // Boot reconcile may have flipped orphaned runs out of the active set.
    this.emitActiveChanged();
  }

  stop(): void { for (const c of this.controllers.values()) c.abort(); }

  listCatalog(): OrchestrationDescriptor[] { return Object.values(ORCHESTRATIONS); }
  listRuns(): OrchestrationRun[] { return listOrchestrationRuns(); }
  getRun(runId: string): OrchestrationRun | null { return getOrchestrationRun(runId); }

  /** Fire-and-detach. Validates, persists the run row, kicks off execution,
   *  returns the runId synchronously. */
  start_run(req: RunOrchestrationRequest): { runId: string } {
    if (req.name !== 'groupthink') throw httpErr(400, `Unknown orchestration: ${req.name}`);

    // Fold a legacy command string into structured resume params. Re-pin the
    // live identifiers afterward so the stale string can't override them.
    if (req.legacyCommand) {
      Object.assign(req, parseLegacyGroupthinkCommand(req.legacyCommand), {
        workspaceId: req.workspaceId, supervisorId: req.supervisorId, name: req.name,
      });
    }

    let run: OrchestrationRun;
    if (req.resumeRunId) {
      const prior = getOrchestrationRun(req.resumeRunId);
      if (!prior) throw httpErr(404, `No such run: ${req.resumeRunId}`);
      if (prior.leadProvider === 'gemini' || prior.reviewerProvider === 'gemini') {
        throw httpErr(422, 'Gemini provider discontinued; historical Gemini orchestration runs remain readable but cannot be resumed. Use Antigravity (agy).');
      }
      if (req.planningIntentId !== undefined && req.planningIntentId !== prior.planningIntentId) {
        throw httpErr(409, 'A resumed orchestration cannot change its frozen planning intent');
      }
      if (req.leadProvider && req.leadProvider !== prior.leadProvider)
        throw httpErr(409, 'A resumed orchestration cannot change its lead provider.');
      if (req.reviewerProvider && req.reviewerProvider !== prior.reviewerProvider)
        throw httpErr(409, 'A resumed orchestration cannot change its reviewer provider.');
      run = { ...prior, status: 'running', error: undefined, endedAt: undefined, updatedAt: nowIso() };
    } else {
      assertGroupthinkProvider('lead_provider', req.leadProvider);
      assertGroupthinkProvider('reviewer_provider', req.reviewerProvider);
      const ws = getWorkspace(req.workspaceId);
      if (!ws) throw httpErr(404, 'Workspace not found');
      if (!req.planId || !req.planningIntentId) {
        throw httpErr(400, 'New orchestration launches require both planId and planningIntentId');
      }
      if (!isPlanningIntentId(req.planningIntentId)) {
        throw httpErr(400, 'planningIntentId must match int_[0-9a-f]{8}');
      }
      if (!getActivePlanningIntentForLaunch(
        req.workspaceId, req.planId, req.planningIntentId,
      )) {
        throw httpErr(409, 'Planning intent is not active in the requested plan');
      }
      // WP6 / planning-surface demo fix (2026-07-06): a plan-rail run (planId
      // set) edits an EXISTING plan surface, so its planPath MUST be that plan
      // row's real `path` — not the legacy `plans/new-plan.md` default. The
      // acceptance demo shipped the default into the rail Lead's termination
      // instructions and the groupthink.complete message (both derive from
      // run.planPath), forcing the Lead to self-correct; a sloppier model would
      // have written a stray file. Resolve the row here so every downstream
      // consumer (writebackClause, prompt mentions, completion event) is honest.
      const planRow = getPlan(req.planId);
      if (!planRow?.path) throw httpErr(409, 'Requested plan is not available for orchestration launch');
      const planRel = planRow.path;
      const prov = getOrchestrationProviderSettingsCached(ws.path).groupthink;
      run = {
        runId: uuidv4().slice(0, 8),
        name: 'groupthink',
        mode: req.mode === 'parallel' ? 'parallel' : 'serial',
        status: 'starting',
        workspaceId: req.workspaceId,
        supervisorId: req.supervisorId,
        topic: req.topic || 'Research and plan a feature.',
        planPath: path.isAbsolute(planRel) ? planRel : path.join(ws.path, planRel),
        planId: req.planId,
        planningIntentId: req.planningIntentId,
        sectionAnchor: req.sectionAnchor,
        leadProvider: req.leadProvider || prov.defaultLeadProvider,
        reviewerProvider: req.reviewerProvider || prov.defaultReviewerProvider,
        turnTimeoutMs: req.turnTimeoutMs && req.turnTimeoutMs > 0 ? req.turnTimeoutMs : 600000,
        leadId: req.resumeLeadId,
        reviewerId: req.resumeReviewerId,
        lastRelayedTs: {},
        startedAt: nowIso(),
        updatedAt: nowIso(),
      };
      // T2: archive a stale plan at the same path BEFORE persisting the run. A
      // failed archive throws here, refusing the start before any run row exists.
      // Gated on all three resume signals — resumeLeadId/resumeReviewerId can be
      // set via structured/legacy params even without resumeRunId.
      // WP6: a plan-rail run edits an EXISTING registered surface,
      // so NEVER archive it away — archiving is only for the legacy fresh-file
      // deliverable path where a leftover plan would trip the existsSync gate.
      // New launches are always plan+intent-bound; legacy fresh-file runs can
      // only re-enter through the resume branch above.
    }
    insertOrchestration(run);            // upsert
    void this.execute(run, !!req.keepAgents);
    return { runId: run.runId };
  }

  abort(runId: string): { ok: boolean } {
    const run = getOrchestrationRun(runId);
    if (!run) throw httpErr(404, `No such run: ${runId}`);
    this.controllers.get(runId)?.abort();
    run.status = 'aborted'; run.endedAt = nowIso(); run.updatedAt = nowIso();
    updateOrchestration(run);
    this.emitActiveChanged();
    insertOrchestrationEvent({ runId, ts: nowIso(), kind: 'aborted', payload: {} });
    void this.cleanupMembers(run);
    void this.relay(runId, run.supervisorId,
      `[DASHBOARD EVENT] orchestration.groupthink.aborted\n` +
      JSON.stringify({ runId, topic: run.topic, planPath: run.planPath }, null, 2));
    return { ok: true };
  }

  private async execute(run: OrchestrationRun, keepAgents: boolean): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(run.runId, controller);
    run.status = 'running'; run.updatedAt = nowIso(); updateOrchestration(run);
    this.emitActiveChanged();              // now active → start the owner pulse
    const ctx: OrchestrationRunContext = {
      run,
      signal: controller.signal,
      persist: () => {
        run.updatedAt = nowIso();
        updateOrchestration(run);
        if (run.leadId) insertOrchestrationMember(run.runId, 'lead', run.leadId);
        if (run.reviewerId) insertOrchestrationMember(run.runId, 'reviewer', run.reviewerId);
      },
      emit: (kind, payload) => insertOrchestrationEvent({ runId: run.runId, ts: nowIso(), kind, payload }),
    };
    ctx.emit('started', { mode: run.mode, topic: run.topic });
    try {
      if (run.mode === 'serial') await this.runners.serial(this.client, ctx);
      else await this.runners.parallel(this.client, ctx);
      run.status = 'complete'; run.endedAt = nowIso(); run.updatedAt = nowIso();
      updateOrchestration(run);
      // Legacy fresh-file stamping remains limited to non-rail runs.
      if (!run.planId) this.stampPlanMembers(run);
      ctx.emit('complete', { planPath: run.planPath });
      await this.relay(run.runId, run.supervisorId,
        `[DASHBOARD EVENT] groupthink.complete (mode=${run.mode}): Plan at ${run.planPath}. runId=${run.runId}`);
      if (!keepAgents) await this.cleanupMembers(run);
    } catch (err: any) {
      if (controller.signal.aborted) return;   // abort() already handled delivery
      const msg = err?.message || String(err);
      const isStall = msg.startsWith('STALL') || msg.includes('Timeout');
      run.status = isStall ? 'stalled' : 'error'; run.error = msg; run.endedAt = nowIso();
      run.updatedAt = nowIso();
      updateOrchestration(run);
      const event = {
        runId: run.runId, mode: run.mode,
        reason: msg.includes('Max turns') ? 'turn_cap_reached'
              : msg.includes('ready for relay') ? 'receiver_not_ready'
              : msg.includes('no plan file') ? 'no_plan_written' : 'timeout',
        topic: run.topic, planPath: run.planPath, message: msg,
        planners: [
          run.leadId ? { role: run.mode === 'serial' ? 'lead' : 'synthesizer', id: run.leadId } : null,
          run.reviewerId ? { role: run.mode === 'serial' ? 'reviewer' : 'peer', id: run.reviewerId } : null,
        ].filter(Boolean),
        resume_hint: run.mode === 'serial'
          ? { tool: 'run_orchestration', name: 'groupthink', params: { resumeRunId: run.runId } } : null,
      };
      ctx.emit(isStall ? 'stalled' : 'error', event);
      await this.relay(run.runId, run.supervisorId,
        `[DASHBOARD EVENT] orchestration.groupthink.stalled\n${JSON.stringify(event, null, 2)}`);
    } finally {
      this.controllers.delete(run.runId);
      // Terminal status (complete / stalled / error / aborted) is persisted by
      // now in every branch above — drop this run from the active set so the
      // owner pulse stops.
      this.emitActiveChanged();
    }
  }

  /** Deliver an event to the supervisor, recording a durable `delivery_failed`
   *  event row when the injected deliver fn can't reach a busy supervisor. This
   *  replaces the script's undelivered-sentinel FILE (groupthink-v2.js:305–324)
   *  with a queryable row surfaced in the run's event timeline. */
  private async relay(runId: string, supervisorId: string, text: string): Promise<void> {
    const res = await this.deliver(supervisorId, text).catch((err: any) => {
      console.warn(`[orchestration] deliver threw for ${runId}: ${err?.message || err}`);
      return { ok: false };
    });
    if (!res || !res.ok) {
      insertOrchestrationEvent({ runId, ts: nowIso(), kind: 'delivery_failed', payload: { text } });
    }
  }

  /** Append `<!-- groupthink_run: <runId> (mode=…) -->` to planPath if absent.
   *  Port of groupthink-v2.js:756–762, keyed on runId instead of session ids. */
  private stampPlanMembers(run: OrchestrationRun): void {
    try {
      if (!fs.existsSync(run.planPath)) return;
      const content = fs.readFileSync(run.planPath, 'utf8');
      if (content.includes('groupthink_run:')) return;
      fs.writeFileSync(run.planPath, content + `\n\n<!-- groupthink_run: ${run.runId} (mode=${run.mode}) -->\n`);
    } catch (err: any) {
      console.warn(`[orchestration] stampPlanMembers failed for ${run.runId}: ${err?.message || err}`);
    }
  }

  /** Stop member agents (parity with the script's DELETE-route cleanup). Best
   *  effort — a failure leaves the agent alive for manual cleanup, never throws. */
  private async cleanupMembers(run: OrchestrationRun): Promise<void> {
    for (const id of [run.leadId, run.reviewerId]) {
      if (!id) continue;
      try {
        await this.client.stopAgent(id);
      } catch (err: any) {
        console.warn(`[orchestration] cleanup failed for ${id}: ${err?.message || err}`);
      }
    }
  }
}

export { READY_STATUSES };
