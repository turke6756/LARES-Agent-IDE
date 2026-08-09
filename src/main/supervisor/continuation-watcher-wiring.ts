import * as http from 'http';
import { Notification } from 'electron';
import type { AgentSupervisor } from './index';
import {
  ContinuationWatcher,
  isContinuationWatchEligible,
  type ContinuationWatcherEffects,
  type HandshakeResult,
} from './continuation-watcher';
import {
  getAgent,
  getActiveAgents,
  getAgentsByOwner,
  getContinuationAttempt,
  getContinuationEscapeBudget,
  countContinuationDeferrals,
  getOpenContinuationAttempt,
  getLatestBrickForAttempt,
  closeContinuationHandoffAttempt,
  hasRunningOrchestrationForSupervisor,
  addEvent,
} from '../database';
import { getApiToken } from '../security/api-auth';
import { CONTINUATION_MAX_DEFERRALS } from '../../shared/constants';

/** Context-brick Inc 5B — production wiring for the continuation watcher.
 *
 *  Effects call the AUTHENTICATED continuation routes over the loopback API
 *  (Bearer admission, full server-side re-check of every gate) — the watcher
 *  never bypasses the route gates for attempt-open or relaunch. Observation
 *  reads (owned rows, attempt startedAt) go straight to the DB, and the note
 *  request rides `sendInputConfirmed` — the send_message handshake machinery,
 *  never a bare PTY write. */

interface ApiResponse {
  ok: boolean;
  status: number;
  json: any;
}

function apiCall(port: number, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Authorization: `Bearer ${getApiToken()}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json: any = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON body */ }
          resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** The EXACT set the continuation tick visits: active (getActiveAgents excludes
 *  'done'/'crashed') ∩ supervisor-privileged ∩ claude. Exported so the force
 *  entry point rejects against the same expression the tick uses — there must
 *  never be two "must mirror" predicates. Evaluated at CALL time, so a
 *  just-launched supervisor is forceable before the first monitorTick. */
export function getContinuationWatchIds(): string[] {
  return getActiveAgents().filter(isContinuationWatchEligible).map((a) => a.id);
}

export function createContinuationWatcherEffects(
  supervisor: AgentSupervisor,
  apiPort: number,
): ContinuationWatcherEffects {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getContextPercentage: (agentId) =>
      supervisor.getContextStats(agentId)?.contextPercentage ?? null,
    isIdle: (agentId) => getAgent(agentId)?.status === 'idle',
    isAwaitingHuman: (agentId) => supervisor.isAwaitingHuman(agentId),
    // Per-agent continuation toggle read live from the DB row; absent/unknown →
    // enabled (default-on, preserves prior behavior for every legacy row).
    isContinuationEnabled: (agentId) => getAgent(agentId)?.continuationEnabled !== false,
    // Raw DB rows; terminal included so crashed ids can ride the attempt
    // reason (crashed is non-blocking). 'done' rows carry no signal.
    getOwnedAgents: (agentId) =>
      getAgentsByOwner(agentId, { includeTerminal: true })
        .filter((a) => a.status !== 'done')
        .map((a) => ({ id: a.id, status: a.status })),
    isInputInFlight: (agentId) => supervisor.isInputInFlight(agentId),
    hasRunningOrchestration: (agentId) => hasRunningOrchestrationForSupervisor(agentId),
    isWatchEligible: (agentId) => getContinuationWatchIds().includes(agentId),

    openAttempt: async (agentId, input) => {
      const res = await apiCall(apiPort, 'POST', `/api/agents/${agentId}/continuation-attempt`, input);
      if (res.ok && res.json?.attemptId) {
        // startedAt is an observation read (the route returns attemptId +
        // successorGen only); the row is the authority for the kill-auth clock.
        const row = getContinuationAttempt(res.json.attemptId);
        return row
          ? { status: 'ok', attemptId: row.id, startedAt: row.startedAt }
          : { status: 'rejected', code: 'attempt-row-missing', httpStatus: res.status, error: 'attempt row not found after open' };
      }
      // An open row already exists. Same rule as the boot reconcile: adopt ONLY
      // when the row already earned kill authorization (a tool-source brick
      // written after it opened). Otherwise report a NAMED failure — never guess
      // ownership from generation equality inside a live process.
      const open = getOpenContinuationAttempt(agentId);
      if (open) {
        const brick = getLatestBrickForAttempt(agentId, open.id, { source: 'tool' });
        if (brick && brick.writtenAt > open.startedAt) {
          console.warn(`[continuation-watcher] adopting authorized open attempt ${open.id} for ${agentId}`);
          addEvent(agentId, 'continuation_attempt_adopted', JSON.stringify({ attemptId: open.id, generation: open.generation }));
          return { status: 'ok', attemptId: open.id, startedAt: open.startedAt };
        }
        return {
          status: 'rejected', code: 'open-attempt-exists', httpStatus: res.status,
          error: `an unfinished handoff attempt (${open.id}) is already open for this agent`,
        };
      }
      return {
        status: 'rejected', code: res.json?.code ?? 'open-rejected', httpStatus: res.status,
        error: res.json?.error ?? `attempt-open rejected (HTTP ${res.status})`,
      };
    },

    requestNote: async (agentId, message): Promise<HandshakeResult> => {
      try {
        const result = await supervisor.sendInputConfirmed(agentId, message);
        return result.confirmed ? 'ok' : 'unconfirmed';
      } catch {
        // SubmitNotConfirmedError / delivery-failed / eager no-runner — the
        // turn provably never started (pre-attempt failure).
        return 'failed';
      }
    },

    getCommittedToolBrick: async (agentId, attemptId) => {
      const res = await apiCall(
        apiPort, 'GET',
        `/api/supervisor/continuation-brick?agentId=${encodeURIComponent(agentId)}&attemptId=${encodeURIComponent(attemptId)}&source=tool`,
      );
      const brick = res.ok ? res.json?.brick : null;
      return brick ? { id: brick.id, writtenAt: brick.writtenAt } : null;
    },

    getCommittedDeferral: async (agentId, attemptId) => {
      const res = await apiCall(
        apiPort, 'GET',
        `/api/supervisor/continuation-deferral?agentId=${encodeURIComponent(agentId)}&attemptId=${encodeURIComponent(attemptId)}`,
      );
      const deferral = res.ok ? res.json?.deferral : null;
      return deferral ? {
        id: deferral.id,
        reason: deferral.reason,
        retryAfterMinutes: deferral.retryAfterMinutes,
        deferredAt: deferral.deferredAt,
      } : null;
    },

    getRemainingDeferrals: (agentId, attemptId) => {
      const attempt = getContinuationAttempt(attemptId);
      if (!attempt || attempt.dashboardAgentId !== agentId) return 0;
      return Math.max(0, CONTINUATION_MAX_DEFERRALS
        - countContinuationDeferrals(agentId, attempt.generation));
    },

    // Slice 2 §2.6 — the rejection reason used to die in a console.warn here.
    // It is the ONE string that says WHICH gate refused (self-busy, in-flight,
    // awaiting-human, orchestration), so it rides the result onto the card.
    relaunch: async (agentId, attemptId) => {
      const res = await apiCall(apiPort, 'POST', `/api/agents/${agentId}/continuation-relaunch`, { attemptId });
      if (res.ok) return { ok: true };
      console.warn(`[continuation-watcher] relaunch rejected (${res.status}) for ${agentId}:`, res.json?.error ?? '');
      return {
        ok: false, code: res.json?.code ?? 'relaunch-rejected', httpStatus: res.status,
        error: res.json?.error ?? `relaunch rejected (HTTP ${res.status})`,
      };
    },

    relaunchNone: async (agentId, attemptId) => {
      const res = await apiCall(apiPort, 'POST', `/api/agents/${agentId}/continuation-relaunch`, { attemptId, emptyMemoEscape: true });
      if (res.ok) return { ok: true };
      console.warn(`[continuation-watcher] none-mode relaunch rejected (${res.status}) for ${agentId}:`, res.json?.error ?? '');
      return {
        ok: false, code: res.json?.code ?? 'relaunch-none-rejected', httpStatus: res.status,
        error: res.json?.error ?? `note-less relaunch rejected (HTTP ${res.status})`,
      };
    },

    getEscapeBudget: (agentId) => {
      // The current successor generation an open attempt owns = agent gen + 1
      // (createContinuationHandoffAttempt allocates it the same way). The budget
      // is scoped to that generation's attempts created since the last relaunch.
      const successorGen = (getAgent(agentId)?.continuationGeneration ?? 0) + 1;
      const b = getContinuationEscapeBudget(agentId, successorGen);
      // NOW_MS_SQL writes UTC 'YYYY-MM-DD HH:MM:SS.fff'. Convert to epoch ms as
      // UTC (ISO 'T' + 'Z') so the alive-time clock is timezone-correct.
      return {
        abortedCount: b.abortedCount,
        firstAttemptStartedAtMs: b.firstAttemptStartedAt !== null
          ? Date.parse(b.firstAttemptStartedAt.replace(' ', 'T') + 'Z')
          : null,
      };
    },

    abortAttempt: (agentId, attemptId, detail) => {
      closeContinuationHandoffAttempt(attemptId, 'aborted');
      addEvent(agentId, 'continuation_aborted', JSON.stringify({ attemptId, detail }));
    },

    handoffFailedRecovery: async (agentId, attemptId) => {
      // sendInputConfirmed's contract confirm-and-retry already re-pressed
      // Enter before rejecting; the durable recovery here is the timeline
      // record — the watcher retries the still-open attempt after backoff.
      addEvent(agentId, 'handoff_failed', JSON.stringify({
        scope: 'continuation-note-request', attemptId,
      }));
    },

    pageHuman: (agentId, message) => {
      console.error(`[continuation-watcher] PAGE HUMAN (agent ${agentId}): ${message}`);
      try {
        if (Notification.isSupported()) {
          new Notification({ title: 'Supervisor continuation needs attention', body: message }).show();
        }
      } catch { /* headless / test environment */ }
    },

    // Slice 2 §4.3 — the supervisor holds the AUTHORITATIVE phase map (so a
    // renderer reload re-hydrates) and owns the broadcast. The watcher just
    // hands it the signal.
    publishPhase: (signal) => supervisor.publishContinuationPhase(signal),

    log: (message) => console.log(message),
  };
}

/** Watch every Claude supervisor via the StatusMonitor poll tick
 *  (re-surfaced as the supervisor's 'monitorTick' event — the existing
 *  periodic seam; the watcher owns no interval of its own). */
export function startContinuationWatcher(
  supervisor: AgentSupervisor,
  apiPort: number,
): ContinuationWatcher {
  const watcher = new ContinuationWatcher(createContinuationWatcherEffects(supervisor, apiPort));
  // Attach so the supervisor's force/toggle entry points can reach the watcher's
  // per-agent state (forceContinuationHandoff → watcher.forceHandoff).
  supervisor.attachContinuationWatcher(watcher);
  supervisor.on('monitorTick', () => {
    // Any supervisor-privileged claude agent rides the auto continuation watcher —
    // the structural workspace supervisor AND a privilegeLane:'supervisor' persona
    // (#19). The provider constraint stays: continuation is claude-only. Same
    // expression the force entry point rejects against (isWatchEligible).
    watcher.tick(getContinuationWatchIds());
  });
  supervisor.on('agentDeleted', (payload: { agentId: string } | undefined) => {
    if (!payload?.agentId) return;
    watcher.forgetAgent(payload.agentId);
    // Drop the phase with the watcher state it belongs to, so a deleted agent's
    // label cannot outlive it and be served to the next window that hydrates.
    supervisor.publishContinuationPhase({ agentId: payload.agentId, phase: null });
  });
  return watcher;
}
