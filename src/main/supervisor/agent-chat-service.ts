import { SessionLogReader } from './session-log-reader';
import { getAgent } from '../database';
import { resolveAgentChatEvents } from './agent-chat-history';
import { SessionEvent, AssistantTextEvent, UserTextEvent } from '../../shared/session-events';

export interface ChatMessage {
  role: 'assistant' | 'user';
  content: string;
  ts: string;
  sessionId: string;
  turnComplete: boolean;
  provider: string;
}

export interface GetMessagesOptions {
  limit?: number;
  role?: 'assistant' | 'user';
}

/** The slice of an agent DB row the per-turn message build needs. */
export interface TurnAgent {
  resumeSessionId?: string | null;
  provider: string;
}

/**
 * Build the single `ChatMessage` for one turn's events (WP-4). Pure helper
 * shared by both the full path and the `limit:1` short-circuit so their
 * classification and content-join semantics can never drift:
 *
 *  - user precedence: any `user-text` in the turn makes it a user message
 *    (even alongside assistant-text), matching the full path's `isUser` branch;
 *  - a turn with only thinking/tool-use (no `assistant-text`) yields `null`
 *    (no message), exactly as the full path pushes nothing for it;
 *  - `turnComplete` for an assistant turn comes from the LAST assistant-text
 *    event; user messages are always complete.
 *
 * `turnEvents` must be in chronological order (`turnEvents[0]` is the turn's
 * first event, supplying the timestamp).
 */
export function buildMessageForTurn(turnEvents: SessionEvent[], agent: TurnAgent): ChatMessage | null {
  const firstEvent = turnEvents[0];
  if (!firstEvent) return null;

  const isUser = turnEvents.some(e => e.type === 'user-text');
  const isAssistant = turnEvents.some(
    e => e.type === 'assistant-text' || e.type === 'thinking' || e.type === 'tool-use',
  );

  if (isUser) {
    const userEvents = turnEvents.filter((e): e is UserTextEvent => e.type === 'user-text');
    if (userEvents.length > 0) {
      return {
        role: 'user',
        content: userEvents.map(e => e.text).join('\n'),
        ts: firstEvent.timestamp,
        sessionId: agent.resumeSessionId || '',
        turnComplete: true, // User messages are always complete turns
        provider: agent.provider,
      };
    }
  } else if (isAssistant) {
    const assistantTextEvents = turnEvents.filter((e): e is AssistantTextEvent => e.type === 'assistant-text');
    if (assistantTextEvents.length > 0) {
      const lastAssistantEvent = assistantTextEvents[assistantTextEvents.length - 1];
      return {
        role: 'assistant',
        content: assistantTextEvents.map(e => e.text).join('\n'),
        ts: firstEvent.timestamp,
        sessionId: agent.resumeSessionId || '',
        turnComplete: !!lastAssistantEvent.turnComplete,
        provider: agent.provider,
      };
    }
  }
  return null;
}

/**
 * Full path (WP-4): group every event into turns (first-seen order), build a
 * message per turn, reverse to newest-first, then apply the role filter and
 * limit. This preserves the original `getMessages` semantics exactly.
 */
export function buildMessagesFullPath(
  events: SessionEvent[],
  agent: TurnAgent,
  options: GetMessagesOptions,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const eventsByTurn = new Map<string, SessionEvent[]>();
  const turnOrder: string[] = [];

  for (const ev of events) {
    const turnId = ev.uuid.split('#')[0];
    if (!eventsByTurn.has(turnId)) {
      eventsByTurn.set(turnId, []);
      turnOrder.push(turnId);
    }
    eventsByTurn.get(turnId)!.push(ev);
  }

  // Process turns in order (oldest first, we'll reverse at the end if needed)
  for (const turnId of turnOrder) {
    const msg = buildMessageForTurn(eventsByTurn.get(turnId)!, agent);
    if (msg) messages.push(msg);
  }

  // Apply filters
  let filtered = messages;
  if (options.role) {
    filtered = filtered.filter(m => m.role === options.role);
  }

  // Default: newest first (reverse the oldest-first order)
  filtered.reverse();

  if (options.limit) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

/**
 * `limit:1` short-circuit (WP-4) — two-scan, no contiguity assumption. O(events)
 * with no all-turn arrays and no all-turn string joins (the material allocation
 * win). Guaranteed to agree with `buildMessagesFullPath` for `limit:1`.
 *
 *  - Scan 1 records per-turn metadata (`hasUser` / `hasAssistantText`) in
 *    first-seen order — turns may be non-contiguous in `events`.
 *  - Selection walks the first-seen order BACKWARD (newest first): a turn with
 *    `hasUser` is a user turn (user precedence, as the full path classifies),
 *    else `hasAssistantText` is an assistant turn; a turn eligible for neither
 *    (thinking/tool-use only) is skipped; `options.role` requires a match.
 *  - Scan 2 rebuilds only the chosen turn chronologically and reuses
 *    `buildMessageForTurn`.
 */
export function buildMessagesLimitOne(
  events: SessionEvent[],
  agent: TurnAgent,
  options: GetMessagesOptions,
): ChatMessage[] {
  const order: string[] = [];
  const meta = new Map<string, { hasUser: boolean; hasAssistantText: boolean }>();

  for (const ev of events) {
    const turnId = ev.uuid.split('#')[0];
    let m = meta.get(turnId);
    if (!m) {
      m = { hasUser: false, hasAssistantText: false };
      meta.set(turnId, m);
      order.push(turnId);
    }
    if (ev.type === 'user-text') m.hasUser = true;
    else if (ev.type === 'assistant-text') m.hasAssistantText = true;
  }

  // Select the newest role-eligible turn (walk first-seen order backward).
  let chosen: string | null = null;
  for (let i = order.length - 1; i >= 0; i--) {
    const turnId = order[i];
    const m = meta.get(turnId)!;
    const role: 'user' | 'assistant' | null = m.hasUser
      ? 'user'
      : m.hasAssistantText
        ? 'assistant'
        : null;
    if (role === null) continue;
    if (options.role && role !== options.role) continue;
    chosen = turnId;
    break;
  }
  if (chosen === null) return [];

  const chosenId = chosen;
  const turnEvents = events.filter(ev => ev.uuid.split('#')[0] === chosenId);
  const msg = buildMessageForTurn(turnEvents, agent);
  return msg ? [msg] : [];
}

/**
 * Route between the `limit:1` fast path and the full path (WP-4). Only
 * `limit === 1` short-circuits; `limit:0` (and any other value) falls through
 * to the full path, whose `if (options.limit)` is falsy for 0 and returns all —
 * semantics preserved.
 */
export function buildMessages(
  events: SessionEvent[],
  agent: TurnAgent,
  options: GetMessagesOptions,
): ChatMessage[] {
  if (options.limit === 1) return buildMessagesLimitOne(events, agent, options);
  return buildMessagesFullPath(events, agent, options);
}

export class AgentChatService {
  constructor(private dispatcher: SessionLogReader) {}

  async getMessages(agentId: string, options: GetMessagesOptions = {}): Promise<ChatMessage[]> {
    const agent = getAgent(agentId);
    if (!agent) return [];

    // Live agent: trigger a fresh poll to ensure we have the latest messages.
    // Scoped to this agent so the force-poll does not reset other agents'
    // rate-limit timers. BUG-07: must bypass the dispatcher's `nextPollAt` gate
    // or a recent background tick can silently keep our read stale.
    //
    // Terminal agent (`done`/`crashed`): the ring is released on exit and
    // `pollNow` is a no-op for it anyway, so the events come back off disk.
    // Everything below is unchanged — same events, same turn grouping, same
    // output shape — so `read_agent_chat` cannot tell a dead agent's history
    // from a live one except that it is frozen.
    const { events } = resolveAgentChatEvents(
      {
        getAgent,
        getCachedEvents: (id, since) => this.dispatcher.getCachedEvents(id, since),
        pollNow: (id) => this.dispatcher.pollNow(id),
        readPriorSessionEvents: (p, wd, sid) => this.dispatcher.readPriorSessionEvents(p, wd, sid),
      },
      agentId,
      { pollLive: true },
    );
    if (events.length === 0) return [];

    // WP-4: `limit:1` short-circuits to a two-scan fast path that avoids the
    // all-turn arrays and all-turn string joins; every other limit (incl. 0)
    // falls through to the full path. Both share `buildMessageForTurn`.
    return buildMessages(events, agent, options);
  }
}
