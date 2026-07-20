import { SessionLogReader } from './session-log-reader';
import { getAgent } from '../database';
import { resolveAgentChatEvents } from './agent-chat-history';
import { SessionEvent, AssistantTextEvent, UserTextEvent, ThinkingEvent } from '../../shared/session-events';

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
      const turnEvents = eventsByTurn.get(turnId)!;
      const firstEvent = turnEvents[0];
      
      // Determine if it's a user or assistant turn
      const isUser = turnEvents.some(e => e.type === 'user-text');
      const isAssistant = turnEvents.some(e => e.type === 'assistant-text' || e.type === 'thinking' || e.type === 'tool-use');

      if (isUser) {
        const userEvents = turnEvents.filter((e): e is UserTextEvent => e.type === 'user-text');
        if (userEvents.length > 0) {
          messages.push({
            role: 'user',
            content: userEvents.map(e => e.text).join('\n'),
            ts: firstEvent.timestamp,
            sessionId: agent.resumeSessionId || '',
            turnComplete: true, // User messages are always complete turns
            provider: agent.provider,
          });
        }
      } else if (isAssistant) {
        const assistantTextEvents = turnEvents.filter((e): e is AssistantTextEvent => e.type === 'assistant-text');
        const thinkingEvents = turnEvents.filter((e): e is ThinkingEvent => e.type === 'thinking');
        
        // Combine text and thinking. In GroupThink relay, we mostly care about text.
        // If thinking exists, we could prepend it, but usually relay wants the clean output.
        // For now, let's just use assistant-text.
        if (assistantTextEvents.length > 0) {
          const lastAssistantEvent = assistantTextEvents[assistantTextEvents.length - 1];
          messages.push({
            role: 'assistant',
            content: assistantTextEvents.map(e => e.text).join('\n'),
            ts: firstEvent.timestamp,
            sessionId: agent.resumeSessionId || '',
            turnComplete: !!lastAssistantEvent.turnComplete,
            provider: agent.provider,
          });
        }
      }
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
}
