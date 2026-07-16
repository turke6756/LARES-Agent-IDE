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
  closeContinuationHandoffAttempt,
  hasRunningOrchestrationForSupervisor,
  addEvent,
} from '../database';
import { getApiToken } from '../security/api-auth';

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

    openAttempt: async (agentId, input) => {
      const res = await apiCall(apiPort, 'POST', `/api/agents/${agentId}/continuation-attempt`, input);
      if (!res.ok || !res.json?.attemptId) return null;
      // startedAt is an observation read (the route returns attemptId +
      // successorGen only); the row is the authority for the kill-auth clock.
      const row = getContinuationAttempt(res.json.attemptId);
      if (!row) return null;
      return { attemptId: row.id, startedAt: row.startedAt };
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

    relaunch: async (agentId, attemptId) => {
      const res = await apiCall(apiPort, 'POST', `/api/agents/${agentId}/continuation-relaunch`, { attemptId });
      if (!res.ok) console.warn(`[continuation-watcher] relaunch rejected (${res.status}) for ${agentId}:`, res.json?.error ?? '');
      return res.ok;
    },

    relaunchNone: async (agentId, attemptId) => {
      const res = await apiCall(apiPort, 'POST', `/api/agents/${agentId}/continuation-relaunch`, { attemptId, emptyMemoEscape: true });
      if (!res.ok) console.warn(`[continuation-watcher] none-mode relaunch rejected (${res.status}) for ${agentId}:`, res.json?.error ?? '');
      return res.ok;
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
    // (#19). The provider constraint stays: continuation is claude-only.
    const ids = getActiveAgents()
      .filter(isContinuationWatchEligible)
      .map((a) => a.id);
    watcher.tick(ids);
  });
  supervisor.on('agentDeleted', (payload: { agentId: string } | undefined) => {
    if (payload?.agentId) watcher.forgetAgent(payload.agentId);
  });
  return watcher;
}
