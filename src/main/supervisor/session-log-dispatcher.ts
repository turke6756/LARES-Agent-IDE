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

// WP-1c — chat ring byte budget + per-event hard cap (memory hardening Part B).
// The ring is bounded by BOTH the count cap above AND this byte budget; whole
// turns are evicted from the front when either is exceeded. All provisional
// (recalibrated per WP-7); the marker is a small constant reserved inside the
// per-event cap so a capped field's total stays <= EVENT_TEXT_HARD_CAP.
const RING_BYTE_BUDGET = 8 * 1024 * 1024;
const EVENT_TEXT_HARD_CAP = 1 * 1024 * 1024;
const TRUNC_MARKER = '\n…[truncated]';
// Small fixed per-event bookkeeping estimate (envelope keys, uuid, timestamp,
// type) added to each event's payload byte-count. NOT exact JS-heap accounting
// — a retained-payload estimate that keeps the byte budget honest.
const EVENT_OVERHEAD_BYTES = 64;
// Depth bound for the recursive `tool-use.input` size walk.
const ESTIMATE_JSON_DEPTH_MAX = 12;

// Match window for reconciling a synthetic user-echo against the real
// `user-text` that arrives on disk seconds later. 30s spec + 5s clock skew slack.
const SYNTHETIC_DEDUPE_WINDOW_MS = 35_000;

// Recency-only marker. We used to also store a normalized text key here and
// string-match against the real event, but the PTY input path mangles non-ASCII
// bytes (em-dashes, smart quotes, ellipsis, etc. flatten to single spaces
// inside ConPTY / Win32 Input Mode) so the marker text and the real
// session-log entry no longer collide — every Codex turn with a unicode-rich
// payload double-emitted in chat. We now consume the oldest in-window marker
// FIFO regardless of payload, on the invariant that `_doSendInput` is the only
// path that produces a `user-text` event for codex/gemini agents during a
// pending synthetic. The known trade-off: a human typing into the codex TUI
// concurrently with a script send may have their own input visually attributed
// to the script (the codex side still processed both correctly; only the
// dashboard chat display can race). See plans/groupthink-duplicate-relay-
// investigation.md for the full post-mortem.
interface SyntheticMarker {
  timestamp: number;
}

/**
 * Payload for the `'agent-rebound'` event the dispatcher emits at the end of
 * `rebindAgent(agentId)`. Subscribers in the supervisor purge downstream
 * caches (ContextStatsMonitor maps + `file_activities` DB rows) that the
 * dispatcher itself doesn't own. BUG-26 Layer 2/3.
 */
export interface AgentReboundEvent {
  agentId: string;
}

/** Payload for `'session-stale'` — a Claude agent's tailed `.jsonl` went quiet
 *  (EOF streak). The supervisor uses this only as a RETRY trigger for a
 *  previously hook-bound /clear candidate; it is never the identity source.
 *  `staleSessionId` pins the signal to the session that was being tailed so the
 *  handler can drop a stale retry whose target no longer matches the agent's
 *  current `resumeSessionId` (e.g. an EOF racing in after the row already
 *  rotated). `workingDirectory` / `observedAt` are diagnostic. */
export interface SessionStaleEvent {
  agentId: string;
  staleSessionId: string;
  workingDirectory: string;
  observedAt: number;
}

/**
 * UTF-8-safe truncation (WP-1c). Returns the longest prefix of `text` whose
 * UTF-8 byte length is `<= maxBytes`, never splitting a surrogate pair (so the
 * result is always a valid UTF-16 string with no dangling high surrogate).
 * Binary search over string indices + a surrogate-boundary back-off.
 */
export function truncateUtf8ToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // `lo` is the longest fitting prefix length in UTF-16 code units. If it lands
  // between a high and low surrogate, back off one unit so we never emit a lone
  // high surrogate (which would round-trip through UTF-8 as U+FFFD).
  if (lo > 0 && lo < text.length) {
    const prev = text.charCodeAt(lo - 1);
    const cur = text.charCodeAt(lo);
    if (prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff) lo -= 1;
  }
  return text.slice(0, lo);
}

/**
 * Depth-capped, cycle-safe recursive size estimate for a `tool-use.input`
 * value (WP-1c). Saturates at `cap` and early-exits once the running total
 * reaches it, so a large input is never undercounted against the byte budget.
 * Exceeding the depth bound OR hitting a previously-visited object (cycle) both
 * saturate to `cap` — conservative, never silently drops deeper content.
 */
export function estimateJsonSize(value: unknown, cap: number): number {
  const seen = new WeakSet<object>();
  let total = 0;
  const walk = (v: unknown, depth: number): void => {
    if (total >= cap) return;
    if (depth > ESTIMATE_JSON_DEPTH_MAX) { total = cap; return; }
    if (v === null || v === undefined) { total += 4; return; }
    switch (typeof v) {
      case 'string': total += Buffer.byteLength(v, 'utf8'); return;
      case 'number': total += 8; return;
      case 'boolean': total += 4; return;
      case 'bigint': total += 16; return;
      case 'object': {
        const obj = v as object;
        if (seen.has(obj)) { total = cap; return; }
        seen.add(obj);
        if (Array.isArray(v)) {
          for (const item of v) {
            if (total >= cap) return;
            walk(item, depth + 1);
          }
        } else {
          for (const key of Object.keys(v as Record<string, unknown>)) {
            if (total >= cap) return;
            total += Buffer.byteLength(key, 'utf8');
            walk((v as Record<string, unknown>)[key], depth + 1);
          }
        }
        return;
      }
      default: total += 8; return;
    }
  };
  walk(value, 0);
  return Math.min(total, cap);
}

/**
 * Estimated retained-payload size of a single event (WP-1c) — NOT exact JS-heap
 * accounting. Sums the UTF-8 byte length of the text-bearing fields (`text` for
 * assistant/user/thinking, `content` for tool-result) plus a small fixed
 * per-event overhead; for `tool-use` it adds the depth-capped `estimateJsonSize`
 * of `input` (saturating at the byte budget). Computed once, at insert.
 */
export function estimateEventBytes(ev: SessionEvent): number {
  let bytes = EVENT_OVERHEAD_BYTES;
  const text = (ev as { text?: unknown }).text;
  if (typeof text === 'string') bytes += Buffer.byteLength(text, 'utf8');
  const content = (ev as { content?: unknown }).content;
  if (typeof content === 'string') bytes += Buffer.byteLength(content, 'utf8');
  if (ev.type === 'tool-use') bytes += estimateJsonSize(ev.input, RING_BYTE_BUDGET + 1);
  return bytes;
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
  // WP-1c — byte-budget accounting for the chat ring. `ringEventBytes` is
  // aligned index-for-index with `eventsByAgent`; `ringBytesByAgent` is its
  // running sum, mutated on append/evict without ever re-walking payloads.
  private ringEventBytes = new Map<string, number[]>();
  private ringBytesByAgent = new Map<string, number>();
  // BUG-09 §3.8 — agents whose first poll-driven batch has already been
  // emitted. The dispatcher's first batch per agent contains the
  // disk-replay of pre-existing events (post-attach reattach, app restart
  // discovering an active session, etc.). Marking that batch
  // `initialLoad: true` lets `event-bridge.onChatEvents` skip latch
  // updates for stale events without rewriting the PTY signal.
  private emittedInitialBatch = new Set<string>();

  constructor(getActiveAgentSessions: () => AgentSession[]) {
    super();
    this.getActiveAgentSessions = getActiveAgentSessions;
  }

  // Typed event surface. Existing emits ('chat-events', 'usage', 'tool-use',
  // 'tool-result') still resolve through the EventEmitter base; the overload
  // here gives BUG-26 Layer 2/3's `'agent-rebound'` subscribers a typed
  // payload instead of `any`.
  on(event: 'agent-rebound', listener: (payload: AgentReboundEvent) => void): this;
  on(event: 'session-stale', listener: (payload: SessionStaleEvent) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
  emit(event: 'agent-rebound', payload: AgentReboundEvent): boolean;
  emit(event: 'session-stale', payload: SessionStaleEvent): boolean;
  emit(event: string | symbol, ...args: any[]): boolean;
  emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
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

  // Force a poll right now, bypassing the per-agent `nextPollAt` rate-limit
  // gate that `tick()` honors. Used by request-driven callers (e.g.
  // `AgentChatService.getMessages`) that need the freshest on-disk content,
  // not whatever the background interval happened to last collect. Pass
  // `agentId` to scope the force-poll to one agent so the call does not
  // reset every other agent's gating timer. See BUG-07 (open-bugs.md).
  pollNow(agentId?: string): void {
    const sessions = this.getActiveAgentSessions();
    const now = Date.now();
    for (const session of sessions) {
      if (agentId && session.agentId !== agentId) continue;
      try {
        this.pollOne(session);
      } catch {
        // swallow per-agent errors
      }
      const rate = this.subscribers.has(session.agentId)
        ? SUBSCRIBED_POLL_MS
        : UNSUBSCRIBED_POLL_MS;
      this.nextPollAt.set(session.agentId, now + rate);
    }
    this.drainStaleSignals();
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
    this.recordSyntheticMarker(agentId, now);

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

  private recordSyntheticMarker(agentId: string, now: number): void {
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
    ring.push({ timestamp: now });
  }

  /** Returns true if `event` should be dropped — consumes the oldest in-window synthetic marker FIFO. */
  private dedupeAgainstSynthetic(event: SessionEvent): boolean {
    if (event.type !== 'user-text') return false;
    const ring = this.syntheticMarkers.get(event.agentId);
    if (!ring || ring.length === 0) return false;
    const eventTs = Date.parse(event.timestamp);
    const refTs = isFinite(eventTs) ? eventTs : Date.now();
    // Drop markers that are too old relative to this real event. We only evict
    // in the past direction — a marker dated after the event could still match
    // a later real event whose own timestamp catches up.
    let writeIdx = 0;
    for (let i = 0; i < ring.length; i++) {
      if (refTs - ring[i].timestamp <= SYNTHETIC_DEDUPE_WINDOW_MS) {
        ring[writeIdx++] = ring[i];
      }
    }
    ring.length = writeIdx;
    if (ring.length === 0) return false;
    // Ring is kept in chronological insert order; consume the oldest if it's
    // within ±window of the real event. FIFO by recency, not by text content
    // (see SyntheticMarker doc for the post-mortem).
    if (Math.abs(ring[0].timestamp - refTs) <= SYNTHETIC_DEDUPE_WINDOW_MS) {
      ring.shift();
      return true;
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

  /**
   * BUG-26 belt-and-suspenders: when an agent's `resumeSessionId` is
   * (re)bound — at post-launch discovery or recovery time — drop every
   * cached scrap of provisional state for that agent so a wrong rollout's
   * events can't survive in the ring buffer. The reader's `invalidatePath`
   * only clears file offsets; the dispatcher owns `eventsByAgent` and the
   * dedupe / initial-batch bookkeeping that's just as load-bearing for
   * "the agent's chat = the agent's session log."
   *
   * Resets:
   *  - `eventsByAgent` and `truncatedByAgent` (the ring buffer that
   *    `AgentChatService.getMessages` reads),
   *  - `seenEventUuids` / `seenEventUuidOrder` (so the freshly-resolved
   *    rollout's events aren't dropped as already-seen if they happen to
   *    collide on uuid),
   *  - `syntheticMarkers` (a stale marker from a wrongly-attributed PTY
   *    echo could otherwise eat the next real user-text),
   *  - `emittedInitialBatch` (so the next batch is marked `initialLoad:
   *    true` for the event-bridge latch suppression).
   *
   * Then delegates to the reader to drop file-offset state.
   *
   * A short-lived race exists between `pollNow(agentId)` and `getCachedEvents`
   * in `AgentChatService.getMessages` — a rebind here in between yields a
   * brief empty chat. That's intentional: empty is strictly better than
   * wrong, and rebind only fires at session-id-write time (rare).
   */
  rebindAgent(agentId: string): void {
    this.eventsByAgent.delete(agentId);
    this.truncatedByAgent.delete(agentId);
    this.ringEventBytes.delete(agentId);
    this.ringBytesByAgent.delete(agentId);
    this.seenEventUuids.delete(agentId);
    this.seenEventUuidOrder.delete(agentId);
    this.syntheticMarkers.delete(agentId);
    this.emittedInitialBatch.delete(agentId);
    for (const reader of this.readers.values()) reader.invalidatePath(agentId);
    // BUG-26 Layer 2/3: downstream caches (ContextStatsMonitor maps and the
    // file_activities DB rows) accumulate under the pre-rebind misattributed
    // agentId and don't self-heal — neither subscribes to chat events. The
    // supervisor listens for this event to purge those derived surfaces.
    this.emit('agent-rebound', { agentId } satisfies AgentReboundEvent);
  }

  /**
   * Release every per-agent scrap of RAM the dispatcher holds for `agentId`.
   *
   * Called when an agent reaches a TERMINAL state (`done` / `crashed`) and at
   * `deleteAgent`. Distinct from `rebindAgent`, which clears the same maps but
   * additionally emits `'agent-rebound'` so downstream caches (context stats,
   * `file_activities`) purge — that is a *misattribution* repair, not a
   * lifecycle release, and firing it on every stop would wrongly nuke a dead
   * agent's derived history.
   *
   * Safe because a terminal agent's chat is no longer served from this ring:
   * `resolveAgentChatEvents` (agent-chat-history.ts) reads it back from the
   * provider's on-disk session log instead. Idempotent — calling it for an
   * unknown or already-forgotten agent is a no-op.
   */
  forgetAgent(agentId: string): void {
    this.eventsByAgent.delete(agentId);
    this.truncatedByAgent.delete(agentId);
    this.ringEventBytes.delete(agentId);
    this.ringBytesByAgent.delete(agentId);
    this.seenEventUuids.delete(agentId);
    this.seenEventUuidOrder.delete(agentId);
    this.syntheticMarkers.delete(agentId);
    this.emittedInitialBatch.delete(agentId);
    // Poll bookkeeping: `tick()` only walks ACTIVE sessions, so a terminal
    // agent's entries here are pure garbage that never gets revisited.
    this.nextPollAt.delete(agentId);
    this.subscribers.delete(agentId);
    for (const reader of this.readers.values()) reader.invalidatePath(agentId);
  }

  /** Provider-agnostic check that the on-disk session log for a given session
   *  id exists. Currently only the Claude reader implements `sessionFileExists`;
   *  any other registered reader is asked via duck-typing, and a missing
   *  implementation returns false (caller treats absent as "no resume"). */
  sessionFileExists(provider: AgentProvider, workingDirectory: string, sessionId: string): boolean {
    const reader = this.readers.get(provider) as
      | (ChatLogReader & { sessionFileExists?(workingDirectory: string, sessionId: string): boolean })
      | undefined;
    if (!reader || typeof reader.sessionFileExists !== 'function') return false;
    return reader.sessionFileExists(workingDirectory, sessionId);
  }

  /** Context-brick Phase 2 — one-shot PURE read of a prior session's structured
   *  chat from disk (Claude reader only today). Does NOT subscribe, does NOT
   *  feed the live `eventsByAgent` ring, and does NOT advance any offset — a
   *  rebind already wiped the live ring, so the prior session lives only on
   *  disk. Returns `null` when the provider has no one-shot reader or the JSONL
   *  is missing/pruned; `[]` for a located-but-empty session. */
  readPriorSessionEvents(
    provider: AgentProvider,
    workingDirectory: string,
    sessionId: string,
  ): SessionEvent[] | null {
    const reader = this.readers.get(provider) as
      | (ChatLogReader & {
          readSessionEventsOnce?(workingDirectory: string, sessionId: string): SessionEvent[] | null;
        })
      | undefined;
    if (!reader || typeof reader.readSessionEventsOnce !== 'function') return null;
    return reader.readSessionEventsOnce(workingDirectory, sessionId);
  }

  /** Drain each reader's session-pinned stale signals and re-emit them as
   *  `'session-stale'`. Called at the end of every tick / pollNow so rotation
   *  handling runs on a clean stack (NOT re-entrantly inside pollSession). */
  private drainStaleSignals(): void {
    for (const reader of this.readers.values()) {
      const r = reader as ChatLogReader & { drainStaleSignals?(): SessionStaleEvent[] };
      if (typeof r.drainStaleSignals !== 'function') continue;
      for (const signal of r.drainStaleSignals()) {
        this.emit('session-stale', signal satisfies SessionStaleEvent);
      }
    }
  }

  /** Provider-agnostic validation that an already-agent-bound candidate session
   *  id is a genuine `/clear` successor (Claude reader only today). Returns
   *  false when the provider has no reader or no `validateClearSuccessor`. */
  validateClearSuccessor(
    provider: AgentProvider,
    workingDirectory: string,
    currentSessionId: string,
    candidateSessionId: string,
    startedAt?: string
  ): boolean {
    const reader = this.readers.get(provider) as
      | (ChatLogReader & { validateClearSuccessor?(
          workingDirectory: string,
          currentSessionId: string,
          candidateSessionId: string,
          startedAt?: string
        ): boolean })
      | undefined;
    if (!reader || typeof reader.validateClearSuccessor !== 'function') return false;
    return reader.validateClearSuccessor(workingDirectory, currentSessionId, candidateSessionId, startedAt);
  }

  getCachedEvents(agentId: string, sinceUuid?: string): { events: SessionEvent[]; truncated: boolean } {
    const all = this.eventsByAgent.get(agentId) || [];
    const truncated = this.truncatedByAgent.get(agentId) || false;
    if (!sinceUuid) return { events: all.slice(), truncated };
    const idx = all.findIndex(e => e.uuid === sinceUuid);
    if (idx < 0) return { events: all.slice(), truncated };
    return { events: all.slice(idx + 1), truncated };
  }

  /** Layer-3 memory telemetry gauge: an O(1)-per-agent read of the chat ring's
   *  retained footprint. `bytes` sums the per-agent running byte totals
   *  (`ringBytesByAgent`, maintained on append/evict — never re-walks payloads);
   *  `entries` sums ring lengths; `agents` is the number of agents with a ring.
   *  Cheap enough for the same 15 s cadence as the heap sampler. */
  getRingGauge(): { agents: number; entries: number; bytes: number } {
    let entries = 0;
    for (const buf of this.eventsByAgent.values()) entries += buf.length;
    let bytes = 0;
    for (const n of this.ringBytesByAgent.values()) bytes += n;
    return { agents: this.eventsByAgent.size, entries, bytes };
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
    this.drainStaleSignals();
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

    // BUG-09 §3.8 — the first batch we emit for this agent is the on-disk
    // replay of pre-existing events. Mark it so the event-bridge can suppress
    // latch updates for historical tool-use/turnComplete that no longer
    // reflect live state.
    const isInitial = !this.emittedInitialBatch.has(session.agentId);
    if (isInitial) this.emittedInitialBatch.add(session.agentId);

    const batch: ChatEventBatch = {
      agentId: session.agentId,
      events: newEvents,
      truncated: this.truncatedByAgent.get(session.agentId) || false,
      initialLoad: isInitial || undefined,
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
    let sizes = this.ringEventBytes.get(agentId);
    if (!sizes) {
      sizes = [];
      this.ringEventBytes.set(agentId, sizes);
    }
    let totalBytes = this.ringBytesByAgent.get(agentId) || 0;

    for (const ev of newEvents) {
      // Truncation/cloning operates ONLY on the ring copy — the `newEvents`
      // objects are the SAME references handed to live 'chat-events' /
      // 'usage' / 'tool-use' / 'tool-result' listeners (verified wiring:
      // appendToRingBuffer runs before those emits), so mutating them would
      // corrupt the live delivery. Never mutate `ev`.
      const { stored, bytes } = this.prepareRingEvent(ev);
      buf.push(stored);
      sizes.push(bytes);
      totalBytes += bytes;
    }

    totalBytes = this.evictRing(agentId, buf, sizes, totalBytes);
    this.ringBytesByAgent.set(agentId, totalBytes);
  }

  /**
   * Produce the ring copy of an event and its estimated retained-payload size
   * (computed ONCE, here at insert). A `text`/`content` field exceeding
   * EVENT_TEXT_HARD_CAP forces a shallow clone whose field is truncated to
   * `<= 1 MiB including the marker` (marker reserved inside the cap). Events
   * under the cap are stored BY ORIGINAL REFERENCE — no clone, preserving event
   * identity and avoiding allocation. `tool-use.input` is never structurally
   * truncated (that would corrupt the tool JSON); its only bound is byte-budget
   * eviction.
   */
  private prepareRingEvent(ev: SessionEvent): { stored: SessionEvent; bytes: number } {
    const cap = EVENT_TEXT_HARD_CAP;
    const markerBytes = Buffer.byteLength(TRUNC_MARKER, 'utf8');
    let clone: Record<string, unknown> | null = null;
    const text = (ev as { text?: unknown }).text;
    if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > cap) {
      clone = clone ?? { ...(ev as unknown as Record<string, unknown>) };
      clone.text = truncateUtf8ToBytes(text, cap - markerBytes) + TRUNC_MARKER;
    }
    const content = (ev as { content?: unknown }).content;
    if (typeof content === 'string' && Buffer.byteLength(content, 'utf8') > cap) {
      clone = clone ?? { ...(ev as unknown as Record<string, unknown>) };
      clone.content = truncateUtf8ToBytes(content, cap - markerBytes) + TRUNC_MARKER;
    }
    const stored: SessionEvent = clone ? (clone as unknown as SessionEvent) : ev;
    return { stored, bytes: estimateEventBytes(stored) };
  }

  /**
   * Whole-turn eviction from the front while the ring exceeds EITHER the count
   * cap OR the byte budget. A turn is keyed by `uuid.split('#')[0]`; we always
   * remove a COMPLETE leading turn so the surviving head is a turn boundary.
   * Keeps `sizes` aligned with `buf` and returns the updated byte total.
   */
  private evictRing(agentId: string, buf: SessionEvent[], sizes: number[], totalBytes: number): number {
    let evicted = false;
    while ((buf.length > RING_BUFFER_MAX || totalBytes > RING_BYTE_BUDGET) && buf.length > 0) {
      const frontTurnId = buf[0].uuid.split('#')[0];
      let count = 0;
      while (count < buf.length && buf[count].uuid.split('#')[0] === frontTurnId) count++;
      let removedBytes = 0;
      for (let i = 0; i < count; i++) removedBytes += sizes[i];
      buf.splice(0, count);
      sizes.splice(0, count);
      totalBytes -= removedBytes;
      evicted = true;
    }
    if (evicted) this.truncatedByAgent.set(agentId, true);
    return totalBytes < 0 ? 0 : totalBytes;
  }
}
