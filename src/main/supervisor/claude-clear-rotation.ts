import type { AgentProvider } from '../../shared/types';

export interface ClearRotationAgent {
  id: string;
  provider: AgentProvider;
  workingDirectory: string;
  resumeSessionId: string | null;
  createdAt: string;
}

/** What triggered a rotation attempt. Every variant carries an
 *  ALREADY-agent-bound candidate session id — the decision path NEVER
 *  discovers a successor by cwd/slug scan (the BUG-26-class invariant this app
 *  must preserve, because many active Claude agents intentionally share one
 *  cwd). cwd is only a filesystem scope used by `validateSuccessor`.
 *   - `hook`: the UserPromptSubmit hook delivered the agent id + new session id.
 *   - `stale`: an EOF/stale retry of a previously hook-bound candidate; pinned
 *      to the session that went quiet so a row that already moved on is ignored.
 *   - `rediscovery`: app-restart reconcile pulled the candidate from the
 *      durable hook spool (still an agent-bound hook record, not a cwd scan). */
export type ClearRotationTrigger =
  | { kind: 'hook'; candidateSessionId: string }
  | { kind: 'stale'; staleSessionId: string; candidateSessionId?: string | null }
  | { kind: 'rediscovery'; candidateSessionId: string };

export interface ClearRotationInput {
  agent: ClearRotationAgent;
  trigger: ClearRotationTrigger;
  /** Validate that `candidateSessionId` is a genuine signed `/clear` successor
   *  of `currentSessionId` within `workingDirectory`. Injected (the Claude
   *  reader implements it) so this stays a pure function. */
  validateSuccessor: (
    workingDirectory: string,
    currentSessionId: string,
    candidateSessionId: string,
    startedAt: string
  ) => boolean;
}

/** Decide whether to rotate a Claude agent's `resumeSessionId` to a hook-bound
 *  `/clear` successor. Returns the new sessionId to adopt, or null for no-op.
 *
 *  This is the BUG-26-class safety guard. It deliberately has NO active-agent /
 *  cwd-uniqueness input: the candidate is already bound to THIS agent (it
 *  arrived on this agent's hook record / stale retry / spool rediscovery), so a
 *  cwd sibling's successor can never be cross-bound here. It fails closed — a
 *  missing, same-session, or unvalidated candidate leaves the bar frozen rather
 *  than rotating the wrong agent.
 *
 *  Guards:
 *   - claude provider with a current `resumeSessionId`,
 *   - for a `stale` retry, the stale session must still equal the agent's
 *     current session (else the row already rotated → ignore),
 *   - a candidate exists and differs from the current session,
 *   - `validateSuccessor` confirms the candidate is a signed `/clear` root. */
export function decideClearRotation(input: ClearRotationInput): string | null {
  const { agent, trigger } = input;
  if (agent.provider !== 'claude' || !agent.resumeSessionId) return null;

  if (trigger.kind === 'stale' && trigger.staleSessionId !== agent.resumeSessionId) return null;

  const candidate = trigger.candidateSessionId;
  if (!candidate || candidate === agent.resumeSessionId) return null;

  return input.validateSuccessor(
    agent.workingDirectory,
    agent.resumeSessionId,
    candidate,
    agent.createdAt
  ) ? candidate : null;
}
