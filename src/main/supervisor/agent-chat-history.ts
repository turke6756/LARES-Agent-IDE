/**
 * Dead-agent chat history — served from DISK, not from RAM held open.
 *
 * Background. A live agent's chat is tailed into `SessionLogDispatcher`'s
 * per-agent ring buffer (`eventsByAgent`, capped at RING_BUFFER_MAX). Both chat
 * consumers read that ring:
 *
 *   - the renderer chat pane, via `agent:get-chat-events` → `getCachedEvents`
 *   - the supervisor's `read_agent_chat` MCP tool + `GET /api/agents/:id/messages`,
 *     via `AgentChatService.getMessages` → `pollNow` + `getCachedEvents`
 *
 * For a TERMINAL agent (`done` / `crashed`) that ring was both a leak and a lie:
 *
 *   - `pollNow` walks `getActiveAgentSessions()`, which filters out terminal
 *     agents — so the force-poll is a silent no-op and the ring can only ever
 *     hold whatever happened to be resident at the moment of death;
 *   - after an app restart the ring is empty, so a dead agent's chat rendered
 *     blank even though the provider's session log is intact on disk;
 *   - nothing released the ring on stop/exit, so the RAM stayed pinned for the
 *     life of the process.
 *
 * This module is the read half of the fix: for a terminal agent, resolve the
 * chat from the provider's on-disk session log via the dispatcher's existing
 * one-shot `readPriorSessionEvents` primitive. The write half is
 * `SessionLogDispatcher.forgetAgent`, called from the stop / runner-exit /
 * delete paths — safe precisely BECAUSE reads now come from disk.
 *
 * Provider support (deliberate, stated scope decision): only the Claude reader
 * implements `readSessionEventsOnce` today, so `readPriorSessionEvents` returns
 * `null` for codex/gemini. Rather than balloon this change into three log-reader
 * implementations, a dead non-Claude agent degrades EXPLICITLY: the result
 * carries `source: 'unavailable'` so the UI can say "history not available for
 * this provider" instead of rendering a silent empty pane. Implementing
 * `readSessionEventsOnce` for the codex/gemini readers is the follow-up that
 * flips those agents to `source: 'disk'` with no change to this file.
 */

import type { AgentProvider, AgentStatus } from '../../shared/types';
import type { SessionEvent } from '../../shared/session-events';

/**
 * Where the returned events came from.
 *
 *  - `live`        — the in-memory ring (agent is running, or a dead agent whose
 *                    ring is still warm from before it died).
 *  - `disk`        — re-read from the provider's session log. Frozen but complete,
 *                    and survives an app restart.
 *  - `unavailable` — the agent is dead and its history cannot be recovered:
 *                    no `resumeSessionId`, a provider with no one-shot reader,
 *                    or a pruned/missing session file. Renders as an explicit
 *                    "history not available" state, never a silent empty chat.
 */
export type ChatHistorySource = 'live' | 'disk' | 'unavailable';

export interface AgentChatEvents {
  events: SessionEvent[];
  truncated: boolean;
  source: ChatHistorySource;
}

/** Statuses after which an agent has no runner and no session-log tail. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<AgentStatus>(['done', 'crashed']);

export function isTerminalChatStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status);
}

/** The slice of an agent DB row this module needs. */
export interface ChatHistoryAgent {
  status: string;
  provider: AgentProvider;
  workingDirectory: string;
  resumeSessionId?: string | null;
}

/**
 * Injected seams — the real wiring passes `getAgent` from the database and the
 * three dispatcher methods. Keeping them as plain functions makes the branch
 * unit-testable without a database, a supervisor, or a real session log.
 */
export interface ChatHistoryDeps {
  getAgent(agentId: string): ChatHistoryAgent | null | undefined;
  getCachedEvents(agentId: string, sinceUuid?: string): { events: SessionEvent[]; truncated: boolean };
  pollNow(agentId: string): void;
  readPriorSessionEvents(
    provider: AgentProvider,
    workingDirectory: string,
    sessionId: string,
  ): SessionEvent[] | null;
}

export interface ResolveChatOptions {
  /** Only meaningful for a LIVE agent: force a fresh tail before reading the
   *  ring. The MCP / HTTP path does this (a stale read there is a correctness
   *  bug); the renderer IPC path does not, because it also holds a live
   *  subscription and a forced poll on every pane render would be wasteful.
   *  Never runs for a terminal agent — `pollNow` is a no-op there by
   *  construction. */
  pollLive?: boolean;
  /** Return only the events AFTER this uuid, matching `getCachedEvents`. */
  sinceUuid?: string;
}

/** Apply `getCachedEvents`' since-uuid semantics to a disk-read array, so the
 *  disk path and the live path are indistinguishable to callers: an unknown
 *  uuid yields the FULL list (caller re-syncs) rather than an empty one. */
function sliceSince(events: SessionEvent[], sinceUuid?: string): SessionEvent[] {
  if (!sinceUuid) return events;
  const idx = events.findIndex((e) => e.uuid === sinceUuid);
  if (idx < 0) return events;
  return events.slice(idx + 1);
}

/**
 * Resolve an agent's chat events, transparently falling back to disk once the
 * agent is terminal. The event SHAPE is identical on both paths — same
 * `SessionEvent[]` produced by the same reader/parser — so downstream
 * turn-grouping and rendering need no branch of their own.
 */
export function resolveAgentChatEvents(
  deps: ChatHistoryDeps,
  agentId: string,
  options: ResolveChatOptions = {},
): AgentChatEvents {
  const agent = deps.getAgent(agentId);
  if (!agent) return { events: [], truncated: false, source: 'live' };

  if (!isTerminalChatStatus(agent.status)) {
    if (options.pollLive) deps.pollNow(agentId);
    const { events, truncated } = deps.getCachedEvents(agentId, options.sinceUuid);
    return { events, truncated, source: 'live' };
  }

  // ── Terminal agent ──────────────────────────────────────────────────
  // The ring is (or is about to be) released, and `pollNow` cannot refill it.
  const sessionId = agent.resumeSessionId || '';
  const fromDisk = sessionId
    ? deps.readPriorSessionEvents(agent.provider, agent.workingDirectory, sessionId)
    : null;

  if (fromDisk) {
    return { events: sliceSince(fromDisk, options.sinceUuid), truncated: false, source: 'disk' };
  }

  // Disk read impossible (no session id, no one-shot reader for this provider,
  // or a pruned file). A ring that has not been released yet is still better
  // than nothing — report it as `live` because that is exactly what it is.
  const cached = deps.getCachedEvents(agentId, options.sinceUuid);
  if (cached.events.length > 0) {
    return { events: cached.events, truncated: cached.truncated, source: 'live' };
  }
  return { events: [], truncated: false, source: 'unavailable' };
}
