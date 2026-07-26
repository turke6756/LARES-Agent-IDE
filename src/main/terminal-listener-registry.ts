// WP-3d — epoch-scoped active-listener registry for terminal:attach / detach.
//
// Each live terminal attach registers a forwarding listener under the runner's
// CURRENT terminal epoch. Two teardown paths remove it:
//
//   • rebound (BUG-38 same-id PTY swap) — unconditional: the retired runner is
//     already gone, so drop whatever listener is registered.
//   • detach (renderer, incl. WP-3d LRU eviction) — EPOCH-SCOPED: a detach
//     carrying a retired epoch must NOT remove a listener that a fresh reattach
//     registered under a newer epoch. Concretely: an eviction begins under
//     epoch A; before its detach lands, a rebound + reattach installs a listener
//     under epoch B; the delayed detach(A) must be a full no-op so the epoch-B
//     listener survives.
//
// The registry is pure map bookkeeping — it never touches the supervisor. The
// IPC handler owns the supervisor.removeAgentListener / detachAgent side
// effects and consults this to decide whether to run them.

export type TerminalDataListener = (data: string, endOffset?: number) => void;

interface Entry {
  listener: TerminalDataListener;
  epoch: string | null;
}

export interface EpochDetachResult {
  /** The listener to tear down, or null when there is nothing to remove. */
  removed: TerminalDataListener | null;
  /** True when a LIVE entry under a DIFFERENT epoch was left intact — the whole
   *  detach must no-op (do not call detachAgent). */
  noop: boolean;
}

export class TerminalListenerRegistry {
  private readonly entries = new Map<string, Entry>();

  has(agentId: string): boolean {
    return this.entries.has(agentId);
  }

  /** Register (or replace) the forwarding listener + the epoch it belongs to. */
  register(agentId: string, listener: TerminalDataListener, epoch: string | null): void {
    this.entries.set(agentId, { listener, epoch });
  }

  /** Unconditional removal (rebound / hard teardown). Returns the removed
   *  listener, or null if none was registered. */
  removeUnconditional(agentId: string): TerminalDataListener | null {
    const e = this.entries.get(agentId);
    if (!e) return null;
    this.entries.delete(agentId);
    return e.listener;
  }

  /** Epoch-scoped removal (detach). Removes iff the registered epoch matches
   *  `expectedEpoch`; `expectedEpoch === undefined` (legacy 1-arg callers) is
   *  unconditional. A live entry under a different epoch is LEFT INTACT and the
   *  result is flagged `noop`. */
  removeForEpoch(agentId: string, expectedEpoch: string | null | undefined): EpochDetachResult {
    const e = this.entries.get(agentId);
    if (e && expectedEpoch !== undefined && e.epoch !== expectedEpoch) {
      return { removed: null, noop: true };
    }
    if (e) {
      this.entries.delete(agentId);
      return { removed: e.listener, noop: false };
    }
    return { removed: null, noop: false };
  }
}
