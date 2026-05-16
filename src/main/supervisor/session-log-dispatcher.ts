import { EventEmitter } from 'events';
import type {
  SessionEvent,
  ChatEventBatch,
  UserTextEvent,
  AssistantTextPatchEvent,
} from '../../shared/session-events';
import type { AgentProvider } from '../../shared/types';
import type { ChatLogReader, ChatLogReaderSession } from './log-readers/types';

interface AgentSession {
  agentId: string;
  sessionId: string;
  workingDirectory: string;
  provider: AgentProvider;
  startedAt?: string;
}

const MASTER_TICK_MS = 1000;
const SUBSCRIBED_POLL_MS = 1000;
const UNSUBSCRIBED_POLL_MS = 5000;
const RING_BUFFER_MAX = 2000;
const SEEN_UUID_MAX = RING_BUFFER_MAX * 3;

// Match window for reconciling a synthetic user-echo against the real
// `user-text` that arrives on disk seconds later. 30s spec + 5s clock skew slack.
const SYNTHETIC_DEDUPE_WINDOW_MS = 35_000;

interface SyntheticMarker {
  text: string; // already normalized
  timestamp: number;
}

function normalizeUserText(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

export class SessionLogDispatcher extends EventEmitter {
  private getActiveAgentSessions: () => AgentSession[];
  private readers = new Map<AgentProvider, ChatLogReader>();

  private eventsByAgent = new Map<string, SessionEvent[]>();
  private truncatedByAgent = new Map<string, boolean>();

  private subscribers = new Set<string>();
  private nextPollAt = new Map<string, number>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private syntheticMarkers = new Map<string, SyntheticMarker[]>(); // agentId -> markers
  private seenEventUuids = new Map<string, Set<string>>();
  private seenEventUuidOrder = new Map<string, string[]>();

  constructor(getActiveAgentSessions: () => AgentSession[]) {
    super();
    this.getActiveAgentSessions = getActiveAgentSessions;
  }

  register(reader: ChatLogReader): void {
    this.readers.set(reader.provider, reader);
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), MASTER_TICK_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  pollNow(): void {
    this.tick();
  }

  addChatSubscriber(agentId: string): void {
    this.subscribers.add(agentId);
    this.nextPollAt.set(agentId, 0);
  }

  removeChatSubscriber(agentId: string): void {
    this.subscribers.delete(agentId);
  }

  // Synthetic echo for codex/gemini. The real `user-text` can arrive later via
  // the on-disk reader; pollOne dedupes it against markers stored here.
  appendSyntheticUserText(agentId: string, text: string): void {
    const now = Date.now();
    this.recordSyntheticMarker(agentId, text, now);

    const ev: UserTextEvent = {
      type: 'user-text',
      uuid: `synthetic:${agentId}:${now}`,
      timestamp: new Date(now).toISOString(),
      agentId,
      text,
    };
    this.appendToRingBuffer(agentId, [ev]);
    this.markEventUuidSeen(agentId, ev.uuid);
    const batch: ChatEventBatch = {
      agentId,
      events: [ev],
      truncated: this.truncatedByAgent.get(agentId) || false,
    };
    this.emit('chat-events', batch);
  }

  private recordSyntheticMarker(agentId: string, text: string, now: number): void {
    let ring = this.syntheticMarkers.get(agentId);
    if (!ring) {
      ring = [];
      this.syntheticMarkers.set(agentId, ring);
    }
    // TTL-evict stale entries on every push so the ring can't grow unbounded.
    const cutoff = now - SYNTHETIC_DEDUPE_WINDOW_MS;
    let writeIdx = 0;
    for (let i = 0; i < ring.length; i++) {
      if (ring[i].timestamp >= cutoff) {
        ring[writeIdx++] = ring[i];
      }
    }
    ring.length = writeIdx;
    ring.push({ text: normalizeUserText(text), timestamp: now });
  }

  /** Returns true if `event` should be dropped (matches a recent synthetic marker). */
  private dedupeAgainstSynthetic(event: SessionEvent): boolean {
    if (event.type !== 'user-text') return false;
    const ring = this.syntheticMarkers.get(event.agentId);
    if (!ring || ring.length === 0) return false;
    const eventTs = Date.parse(event.timestamp);
    const refTs = isFinite(eventTs) ? eventTs : Date.now();
    const target = normalizeUserText(event.text);
    for (let i = 0; i < ring.length; i++) {
      const m = ring[i];
      if (Math.abs(m.timestamp - refTs) > SYNTHETIC_DEDUPE_WINDOW_MS) continue;
      if (m.text === target) {
        ring.splice(i, 1); // consume the marker on hit
        return true;
      }
    }
    return false;
  }

  private markEventUuidSeen(agentId: string, uuid: string): boolean {
    let seen = this.seenEventUuids.get(agentId);
    let order = this.seenEventUuidOrder.get(agentId);
    if (!seen) {
      seen = new Set();
      this.seenEventUuids.set(agentId, seen);
    }
    if (!order) {
      order = [];
      this.seenEventUuidOrder.set(agentId, order);
    }
    if (seen.has(uuid)) return false;

    seen.add(uuid);
    order.push(uuid);
    if (order.length > SEEN_UUID_MAX) {
      const overflow = order.length - SEEN_UUID_MAX;
      const removed = order.splice(0, overflow);
      for (const oldUuid of removed) seen.delete(oldUuid);
    }
    return true;
  }

  invalidatePath(agentId: string): void {
    for (const reader of this.readers.values()) reader.invalidatePath(agentId);
  }

  getCachedEvents(agentId: string, sinceUuid?: string): { events: SessionEvent[]; truncated: boolean } {
    const all = this.eventsByAgent.get(agentId) || [];
    const truncated = this.truncatedByAgent.get(agentId) || false;
    if (!sinceUuid) return { events: all.slice(), truncated };
    const idx = all.findIndex(e => e.uuid === sinceUuid);
    if (idx < 0) return { events: all.slice(), truncated };
    return { events: all.slice(idx + 1), truncated };
  }

  async getFullToolResult(agentId: string, toolUseId: string): Promise<string | null> {
    for (const reader of this.readers.values()) {
      if (!reader.getFullToolResult) continue;
      const result = await reader.getFullToolResult(agentId, toolUseId);
      if (result !== null && result !== undefined) return result;
    }
    return null;
  }

  // ── Polling ──────────────────────────────────────────────────────────

  private tick(): void {
    const sessions = this.getActiveAgentSessions();
    const now = Date.now();
    for (const session of sessions) {
      const due = this.nextPollAt.get(session.agentId) || 0;
      if (due > now) continue;
      try {
        this.pollOne(session);
      } catch {
        // swallow per-agent errors
      }
      const rate = this.subscribers.has(session.agentId) ? SUBSCRIBED_POLL_MS : UNSUBSCRIBED_POLL_MS;
      this.nextPollAt.set(session.agentId, now + rate);
    }
  }

  private pollOne(session: AgentSession): void {
    const reader = this.readers.get(session.provider);
    if (!reader) return;

    const readerSession: ChatLogReaderSession = {
      agentId: session.agentId,
      sessionId: session.sessionId,
      workingDirectory: session.workingDirectory,
      provider: session.provider,
      startedAt: session.startedAt,
      subscribed: this.subscribers.has(session.agentId),
    };

    const rawEvents = reader.pollSession(readerSession);
    if (rawEvents.length === 0) return;

    const newEvents: SessionEvent[] = [];
    for (const ev of rawEvents) {
      if (!this.markEventUuidSeen(ev.agentId, ev.uuid)) continue;
      if (this.dedupeAgainstSynthetic(ev)) continue;
      // Patch events carry a fresh uuid (so dedupe lets them through) and
      // target a prior `assistant-text` already in the ring. Apply the
      // mutation here so consumers reading the ring see the updated flags.
      // Re-audited 2026-05-16: `AgentChatService.getMessages` reads
      // `getCachedEvents` directly; `ChatPane.tsx` consumes batches via
      // `pairEvents` without caching envelopes — both pick up the mutation
      // naturally. The only structural cache of `assistant-text` is the
      // codex reader's `lastAssistantTextEvent`, which holds a reference
      // to the same object the dispatcher mutates here (safe).
      if (ev.type === 'assistant-text-patch') {
        this.applyAssistantTextPatch(ev.agentId, ev);
      }
      newEvents.push(ev);
    }
    if (newEvents.length === 0) return;

    this.appendToRingBuffer(session.agentId, newEvents);

    const batch: ChatEventBatch = {
      agentId: session.agentId,
      events: newEvents,
      truncated: this.truncatedByAgent.get(session.agentId) || false,
    };
    this.emit('chat-events', batch);

    for (const ev of newEvents) {
      if (ev.type === 'usage') this.emit('usage', ev);
      else if (ev.type === 'tool-use') this.emit('tool-use', ev);
      else if (ev.type === 'tool-result') this.emit('tool-result', ev);
    }
  }

  private applyAssistantTextPatch(agentId: string, patch: AssistantTextPatchEvent): void {
    const ring = this.eventsByAgent.get(agentId);
    if (!ring) return;
    // Walk backwards — the target is virtually always recent.
    for (let i = ring.length - 1; i >= 0; i--) {
      const ev = ring[i];
      if (ev.type !== 'assistant-text') continue;
      if (ev.uuid !== patch.targetUuid) continue;
      if (patch.turnComplete !== undefined) ev.turnComplete = patch.turnComplete;
      if (patch.stopReason !== undefined) ev.stopReason = patch.stopReason;
      if (patch.endsWithQuestion !== undefined) ev.endsWithQuestion = patch.endsWithQuestion;
      return;
    }
  }

  private appendToRingBuffer(agentId: string, newEvents: SessionEvent[]): void {
    let buf = this.eventsByAgent.get(agentId);
    if (!buf) {
      buf = [];
      this.eventsByAgent.set(agentId, buf);
    }
    buf.push(...newEvents);
    if (buf.length > RING_BUFFER_MAX) {
      const overflow = buf.length - RING_BUFFER_MAX;
      buf.splice(0, overflow);
      this.truncatedByAgent.set(agentId, true);
    }
  }
}
