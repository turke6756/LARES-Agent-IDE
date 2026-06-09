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
    // messages route uses (api-server.ts:182); its ChatMessage shape includes
    // {content, ts, turnComplete}, which is exactly what the relay loop reads.
    getMessages: (id, opts) => supervisor.getChatService().getMessages(id, opts),
    sendInput: async (id, text) => { await supervisor.sendInput(id, text); },
    isInputInFlight: (id) => supervisor.isInputInFlight(id),
    // The standalone script cleaned up via DELETE /api/agents/:id → stopAgent
    // (mark done + kill process, keep DB record). Mirror that here.
    stopAgent: (id) => supervisor.stopAgent(id),
  };
}
