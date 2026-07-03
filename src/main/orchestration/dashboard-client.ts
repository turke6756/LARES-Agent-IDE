import { DashboardClient } from './types';
import type { AgentSupervisor } from '../supervisor';
import { getAgent } from '../database';

/** Concrete DashboardClient over AgentSupervisor + DB. The narrow surface here
 *  is the single adapter point between the ported groupthink relay loop and the
 *  live dashboard primitives — the same calls the HTTP routes wrap. */
export function createDashboardClient(supervisor: AgentSupervisor): DashboardClient {
  return {
    launchAgent: (input) => supervisor.launchAgent(input),
    getAgent: (id) => getAgent(id),
    // getChatService().getMessages(id, {limit, role}) is the same call the
    // messages route uses (api-server.ts:519); its ChatMessage shape includes
    // {content, ts, turnComplete}, which is exactly what the relay loop reads.
    // BUG-28/BUG-37: fire the same lazy codex-sid recovery hook the HTTP
    // (api-server.ts:518) and IPC (ipc-handlers.ts:115,119) chat-read paths have,
    // UNCONDITIONALLY before the read. The orchestrator's 2s poll loop is a
    // first-class chat-read path and must not be the ONLY one that bypasses
    // recovery — otherwise a codex discovery race-loss blanks GroupThink's chat
    // forever (BUG-37 false-stall). maybeRecoverCodexSid self-gates on provider,
    // an already-bound sid, and the 45s discovery grace, so this is a no-op for
    // non-codex agents and inside the live-discovery window; the call cost at 2s
    // poll cadence matches the UI chat pane's existing behavior.
    getMessages: (id, opts) => {
      supervisor.maybeRecoverCodexSid(id);
      return supervisor.getChatService().getMessages(id, opts);
    },
    sendInput: async (id, text) => { await supervisor.sendInput(id, text); },
    // Confirmed handoff send + submit-only re-press — both already exist as
    // public AgentSupervisor methods (sendInputConfirmed index.ts:4408,
    // resubmitEnter index.ts:4241). V1/V2 dropped-submit recovery uses these.
    sendInputConfirmed: (id, text) => supervisor.sendInputConfirmed(id, text),
    resubmitEnter: (id) => supervisor.resubmitEnter(id),
    isInputInFlight: (id) => supervisor.isInputInFlight(id),
    // The standalone script cleaned up via DELETE /api/agents/:id → stopAgent
    // (mark done + kill process, keep DB record). Mirror that here.
    stopAgent: (id) => supervisor.stopAgent(id),
  };
}
