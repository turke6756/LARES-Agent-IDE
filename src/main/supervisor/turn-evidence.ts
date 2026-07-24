// WP3 (hook-absence-resilience, MVP slice) — a per-agent, hook-independent
// tracker of turn-START evidence drawn from the live session-log stream. It
// exists so a send can be confirmed from the transcript when the status hooks
// can't run (no Node on PATH), WITHOUT the two ways transcript evidence can lie:
//
//   1. SYNTHETIC-ECHO GUARD. For codex/gemini, Lares injects a synthetic
//      `user-text` echo of what it just typed (SessionLogDispatcher.append-
//      SyntheticUserText, uuid `synthetic:…`). That echo is created by Lares, not
//      the agent, so it must NEVER count as proof the agent's turn started.
//      Rejected by the `synthetic:` uuid prefix.
//
//   2. SESSION-REBOUND GUARD. Many agents share one cwd (see CLAUDE.md), and an
//      agent's `resumeSessionId` can rotate (/clear, recovery, continuation). A
//      baseline captured for the send to session A must not be satisfied by a
//      start event from a different session B. Every record is tagged with the
//      agent's session id at capture time; a baseline only accepts start records
//      whose session id matches the baseline's. `reset(agentId)` (called on
//      rebind) additionally drops all records so a stale session can't linger.
//
// This is intentionally NOT the full WP3 turn-evidence abstraction (progress/end
// tracking, waitForStart promises, the six-reader sweep). It records exactly the
// START evidence WP5 confirmation needs, and only from LIVE events — historical
// replay (initialLoad) advances nothing here (the caller passes isLive=false).

import type { SessionEvent } from '../../shared/session-events';

export interface TurnEvidenceBaseline {
  /** Monotonic high-water mark of records seen for this agent at baseline time.
   *  A start record confirms a send only if its seq is strictly greater. */
  seq: number;
  /** The agent's session id at baseline time (rebound guard). */
  sessionId: string | null;
}

interface StartRecord {
  seq: number;
  sessionId: string | null;
}

export class TurnEvidenceTracker {
  // Latest start record per agent (we only ever need "is there a start newer
  // than the baseline for the same session", so one slot suffices).
  private lastStart = new Map<string, StartRecord>();
  private seqByAgent = new Map<string, number>();

  private nextSeq(agentId: string): number {
    const n = (this.seqByAgent.get(agentId) ?? 0) + 1;
    this.seqByAgent.set(agentId, n);
    return n;
  }

  /** Snapshot the current high-water mark + session before a send, so replayed
   *  or pre-existing start evidence can never confirm it (baseline-gated). */
  baseline(agentId: string, sessionId: string | null): TurnEvidenceBaseline {
    return { seq: this.seqByAgent.get(agentId) ?? 0, sessionId };
  }

  /**
   * Feed one live session-log batch. Only turn-START evidence is recorded:
   *   - a NON-synthetic `user-text` (the agent's own prompt echo lands here for
   *     claude; the synthetic echo for codex/gemini is rejected by uuid), or
   *   - a codex `task-started`.
   * `isLive` must be false for the dispatcher's initialLoad replay so historical
   * events advance the seq counter but never register as a live start.
   * `sessionId` is the agent's current session id (rebound guard tag).
   */
  noteEvents(
    agentId: string,
    events: SessionEvent[],
    sessionId: string | null,
    isLive: boolean,
  ): void {
    for (const ev of events) {
      const isStart =
        (ev.type === 'user-text' && !ev.uuid.startsWith('synthetic:')) ||
        ev.type === 'task-started';
      if (!isStart) continue;
      const seq = this.nextSeq(agentId);
      if (isLive) this.lastStart.set(agentId, { seq, sessionId });
    }
  }

  /** True iff a live, non-synthetic start event for the SAME session has been
   *  recorded since `baseline`. This is the WP5 `session-log` confirmation
   *  source. */
  hasStartSince(agentId: string, baseline: TurnEvidenceBaseline): boolean {
    const rec = this.lastStart.get(agentId);
    if (!rec) return false;
    if (rec.seq <= baseline.seq) return false;
    // Rebound guard: a start from a different session id never confirms this
    // baseline. (A null baseline session accepts any — used only where the
    // caller could not resolve a session.)
    if (baseline.sessionId !== null && rec.sessionId !== baseline.sessionId) return false;
    return true;
  }

  /** Drop all evidence for an agent — called on session rebind (a stale
   *  session's start events must not survive into the new session) and on
   *  terminal/forget. */
  reset(agentId: string): void {
    this.lastStart.delete(agentId);
    this.seqByAgent.delete(agentId);
  }
}
