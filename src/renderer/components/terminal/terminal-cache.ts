/**
 * Module-level xterm cache + terminal-agent reaper.
 *
 * WHY THE CACHE EXISTS (do not "fix" this by disposing on unmount): a cached
 * xterm keeps its IPC subscription and its scrollback alive while the panel is
 * off-screen. That is what makes scrollback "stay" when you switch agents or
 * workspaces and come back — the cached terminal buffers live PTY output the
 * whole time you are away. `TerminalPanel`'s unmount cleanup therefore detaches
 * the DOM node only; it never disposes and never unsubscribes.
 *
 * WHY THE REAPER EXISTS: nothing disposed a cached terminal when its agent
 * DIED. A 50k-line scrollback (~12 bytes/cell) plus a WebGL context and a live
 * IPC subscription stayed pinned, per agent whose terminal had ever been
 * opened, until the app restarted. Stopping an agent released nothing.
 *
 * The reaper closes exactly that gap and nothing more:
 *
 *  - TERMINAL STATUS IS THE ONLY TRIGGER. Being off-screen, unmounted, or
 *    merely idle never disposes anything.
 *  - It waits `TERMINAL_AGENT_RELEASE_DELAY_MS` and RE-CHECKS the status, so
 *    the same-id revival paths (manual restart, continuation relaunch,
 *    auto-restart) — which all pass briefly through `done`/`crashed` on the way
 *    to `restarting` — cancel their own disposal. Those paths have their own
 *    teardown via `window.api.terminal.onRebound`; this must not race it.
 *  - A terminal agent that is CURRENTLY ON SCREEN is not disposed out from
 *    under the viewer (that would blank the panel with no remount trigger). It
 *    is queued instead and reaped the moment the panel switches away or closes.
 *
 * Re-opening a reaped agent is lossless from the user's point of view: the
 * mount path always pulls `agents.getRingBuffer(agentId)`, which for a dead
 * agent falls back to the runner's persisted `<logPath>.scrollback` (flushed by
 * the runner on exit) and then to a tail of the raw `.log`. Read-only, from
 * disk — the same shape as the dead-agent chat read.
 */

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { useDashboardStore } from '../../stores/dashboard-store';
import {
  TERMINAL_AGENT_RELEASE_DELAY_MS,
  MAX_LIVE_TERMINAL_VIEWS,
} from '../../../shared/constants';

export interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  unsub: (() => void) | null;
  // WP-3d — the loaded serialize addon, kept so eviction can snapshot the live
  // xterm buffer to a disk checkpoint before disposing it.
  serialize: SerializeAddon;
  // WP-3c exact-once rehydrate state. `appliedOffset` is the highest `.log`
  // byte offset already written into this xterm (the replay cursor);
  // `logOffsetsReliable` is false once an epoch's log-write error forced the
  // degraded ring-snapshot recovery (no `.log` replay for that epoch); `epoch`
  // is the terminal epoch this buffer was hydrated under; `lastWrite` serializes
  // every write so the cursor advances in xterm-write order; `evicting` is set
  // by WP-3d's LRU eviction — a reopen treats an evicting entry as unavailable.
  appliedOffset: number;
  logOffsetsReliable: boolean;
  epoch: string;
  lastWrite: Promise<void>;
  evicting: boolean;
}

/** Module-level cache — survives re-renders, preserves scrollback. */
export const terminalCache = new Map<string, CachedTerminal>();

/** Build a fresh cache entry with the WP-3c rehydrate fields defaulted. The
 *  rehydrate orchestrator fills `appliedOffset` / `epoch` / `logOffsetsReliable`
 *  as it applies history. */
export function createCacheEntry(
  terminal: Terminal,
  fitAddon: FitAddon,
  serialize: SerializeAddon,
  unsub: (() => void) | null,
): CachedTerminal {
  return {
    terminal,
    fitAddon,
    serialize,
    unsub,
    appliedOffset: 0,
    logOffsetsReliable: true,
    epoch: '',
    lastWrite: Promise.resolve(),
    evicting: false,
  };
}

/**
 * WP-3c write coordinator. EVERY snapshot / range / live write goes through
 * here so bytes land in xterm in a single serialized order and the replay
 * cursor (`appliedOffset`) advances only once the write has actually been
 * consumed by xterm's parser.
 *
 * `endOffset === null` is CURSOR-NEUTRAL — used for the serialized-checkpoint
 * and degraded ring-snapshot writes, where the caller sets `appliedOffset`
 * explicitly afterward (a serialized buffer has no single `.log` offset).
 *
 * Once eviction has begun (`entry.evicting`, WP-3d) live writes are dropped so
 * a disposed terminal is never written to.
 */
export function queueWrite(
  entry: CachedTerminal,
  data: string | Uint8Array,
  endOffset: number | null,
): Promise<void> {
  entry.lastWrite = entry.lastWrite.then(
    () =>
      new Promise<void>((resolve) => {
        if (entry.evicting) return resolve();
        entry.terminal.write(data, () => {
          if (endOffset !== null) entry.appliedOffset = endOffset;
          resolve();
        });
      }),
  );
  return entry.lastWrite;
}

// ── WP-3d LRU cache ──────────────────────────────────────────────────────
//
// The cache is bounded to `MAX_LIVE_TERMINAL_VIEWS` NON-EXEMPT live xterm views.
// Beyond that bound the least-recently-touched non-exempt terminals are evicted:
// their serialized buffer is saved to a disk checkpoint (unless the epoch is
// degraded), the main-side listener is torn down (epoch-scoped), and the xterm —
// WebGL context, 50k-line scrollback, IPC subscription — is disposed. Reopening
// replays from the checkpoint + `.log` via the WP-3c rehydrate.
//
// Recency is a MONOTONIC counter (`useClock`), never wall-clock: deterministic
// ordering with no ties, and it can't go backwards across a clock adjustment.

/** Monotonic "last used" stamp per cached terminal. */
const lastUsedAt = new Map<string, number>();
let useClock = 0;

/** Mark a terminal as just-used (mounted / reattached). Advances the monotonic
 *  clock so the LRU order is total and tie-free. */
export function touchTerminal(agentId: string): void {
  lastUsedAt.set(agentId, ++useClock);
}

/** Single-flight eviction promises. An entry stays in `terminalCache` (flagged
 *  `evicting`) while its checkpoint save + main detach are in flight, so a rapid
 *  reopen can await the SAME promise rather than racing a half-disposed xterm. */
const evicting = new Map<string, Promise<void>>();

/** A reopen that finds an entry mid-eviction awaits this before rebuilding.
 *  Resolves immediately when the agent is not being evicted. */
export function awaitTerminalEviction(agentId: string): Promise<void> {
  return evicting.get(agentId) ?? Promise.resolve();
}

/**
 * Enforce the live-view cap. `exempt` is always retained (the on-screen
 * terminal + any pinned agent), so the post-condition is: non-exempt cached
 * entries ≤ `MAX_LIVE_TERMINAL_VIEWS`, hence total ≤ `8 + |exempt|`.
 *
 * Entries already mid-eviction are excluded from the candidate set AND from the
 * overflow count, so repeated calls before an in-flight eviction settles never
 * over-evict — the overflow is measured against only the entries that could
 * still be victims.
 */
export function enforceLiveTerminalBound(exempt: Set<string>): void {
  const eligible = [...terminalCache.keys()]
    .filter((id) => !exempt.has(id) && !evicting.has(id))
    .sort((a, b) => (lastUsedAt.get(a) ?? 0) - (lastUsedAt.get(b) ?? 0)); // oldest first
  let overflow = Math.max(0, eligible.length - MAX_LIVE_TERMINAL_VIEWS);
  for (const id of eligible) {
    if (overflow-- <= 0) break;
    void evictCachedTerminal(id);
  }
}

/**
 * Evict a cached terminal: checkpoint its serialized buffer (healthy epochs
 * only), tear down the main-side listener (epoch-scoped), then ALWAYS release
 * the renderer resources — even if the checkpoint save or the detach rejects.
 * Single-flight via the `evicting` map; a second call returns the in-flight
 * promise. An unknown id resolves immediately.
 */
export function evictCachedTerminal(agentId: string): Promise<void> {
  const inflight = evicting.get(agentId);
  if (inflight) return inflight;
  const entry = terminalCache.get(agentId);
  if (!entry) return Promise.resolve();

  const p = (async () => {
    entry.evicting = true; // queueWrite drops live writes from here on
    try {
      if (entry.logOffsetsReliable) {
        // Never checkpoint a degraded epoch — its offset↔file mapping is
        // untrusted, so a saved cursor could not be validated on reload.
        try {
          await entry.lastWrite; // all queued bytes are in the buffer we serialize
          await window.api.terminal.saveCheckpoint(
            agentId,
            entry.epoch,
            entry.serialize.serialize(),
            entry.appliedOffset,
          );
        } catch (err) {
          console.warn('[evict] checkpoint skipped; capped replay next open', err);
        }
      }
      try {
        entry.unsub?.();
      } catch {
        // a stale subscription that already tore itself down
      }
      try {
        // Epoch-scoped: main no-ops this detach if a fresh reattach has already
        // registered a listener under a newer epoch (rebound race).
        await window.api.terminal.detach(agentId, entry.epoch);
      } catch (err) {
        console.error('[evict] main detach failed', err);
      }
    } finally {
      // ALWAYS release renderer resources, whatever failed above.
      terminalCache.delete(agentId);
      lastUsedAt.delete(agentId);
      evicting.delete(agentId);
      pendingDisposal.delete(agentId);
      try {
        entry.terminal.dispose();
      } catch {
        // xterm can throw if the element was yanked from the DOM first
      }
    }
  })();

  evicting.set(agentId, p);
  return p;
}

/**
 * Rebound-only local teardown: main has ALREADY torn down the retired epoch's
 * attachment (the BUG-38 rebound path is authoritative), so this only drops the
 * renderer's stale subscription + xterm — NO main detach (a delayed detach here
 * could race the fresh reattach). Idempotent; returns false for an unknown id.
 */
export function disposeCachedTerminalLocal(agentId: string): boolean {
  const entry = terminalCache.get(agentId);
  if (!entry) return false;
  terminalCache.delete(agentId);
  lastUsedAt.delete(agentId);
  try {
    entry.unsub?.();
  } catch {
    // a stale subscription that already tore itself down
  }
  try {
    entry.terminal.dispose();
  } catch {
    // xterm can throw if the element was yanked from the DOM first
  }
  pendingDisposal.delete(agentId);
  return true;
}

const TERMINAL_STATUSES = new Set(['done', 'crashed']);

/** Agents that went terminal while being VIEWED — disposed when the panel
 *  moves off them (see `reapIfPending`). */
const pendingDisposal = new Set<string>();

/**
 * Called by `TerminalPanel`'s unmount/switch cleanup. Disposes the terminal iff
 * the agent is dead — either queued by the reaper because it died while being
 * viewed, or already dead when the user opened it (viewing a `done` card
 * rebuilds the terminal from the on-disk scrollback, and that rebuild must not
 * become a NEW permanent cache entry the reaper will never revisit, since it
 * only ever fires on status CHANGES).
 *
 * An agent that is merely being navigated away from is untouched — that is the
 * off-screen-but-alive case the cache exists to serve.
 *
 * WP-3d: releases via `evictCachedTerminal` (checkpoint-then-dispose) so a dead
 * agent's final buffer is persisted before the xterm is destroyed — a same-
 * process dead reopen then loads that checkpoint. `pendingDisposal` is cleared
 * inside the eviction's `finally`.
 */
export function reapOnLeave(agentId: string): void {
  const status = useDashboardStore.getState().agentStatuses[agentId]?.status;
  const dead = pendingDisposal.has(agentId) || (status !== undefined && TERMINAL_STATUSES.has(status));
  if (!dead) return;
  void evictCachedTerminal(agentId);
}

/** Test seam. */
export function __pendingDisposalForTest(): string[] {
  return [...pendingDisposal];
}

/** Test seam — clear ALL module-level cache state (cache, LRU clock, in-flight
 *  evictions, pending disposals) so each test starts from a clean slate. */
export function __resetTerminalCacheForTest(): void {
  terminalCache.clear();
  lastUsedAt.clear();
  evicting.clear();
  pendingDisposal.clear();
  useClock = 0;
}

const reapTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelReap(agentId: string): void {
  const t = reapTimers.get(agentId);
  if (t) {
    clearTimeout(t);
    reapTimers.delete(agentId);
  }
}

/** Evict now if off-screen; otherwise queue for the moment the viewer leaves. */
function reapNow(agentId: string): void {
  reapTimers.delete(agentId);
  if (!terminalCache.has(agentId)) return;
  if (useDashboardStore.getState().terminalAgentId === agentId) {
    pendingDisposal.add(agentId);
    return;
  }
  void evictCachedTerminal(agentId);
}

function scheduleReap(agentId: string): void {
  if (reapTimers.has(agentId)) return;
  const timer = setTimeout(() => {
    const status = useDashboardStore.getState().agentStatuses[agentId]?.status;
    // Still gone (or the row vanished entirely — a deleted agent). A status that
    // is present and non-terminal means the agent came back to life; the rebound
    // handler owns that terminal's teardown, so leave it alone.
    if (status && !TERMINAL_STATUSES.has(status)) {
      reapTimers.delete(agentId);
      return;
    }
    reapNow(agentId);
  }, TERMINAL_AGENT_RELEASE_DELAY_MS);
  reapTimers.set(agentId, timer);
}

let started = false;

/**
 * Subscribe once to the status index the renderer already maintains
 * (`dashboard-store.agentStatuses`, fed by the existing status-change stream —
 * no new IPC channel). Returns an unsubscribe for tests; calling twice is a
 * no-op.
 */
export function startTerminalCacheReaper(): () => void {
  if (started) return () => {};
  started = true;
  return useDashboardStore.subscribe((state, prev) => {
    if (state.agentStatuses === prev.agentStatuses) return;
    for (const agentId of terminalCache.keys()) {
      const status = state.agentStatuses[agentId]?.status;
      // An id that dropped out of the index entirely was deleted — reap it too.
      if (status === undefined || TERMINAL_STATUSES.has(status)) scheduleReap(agentId);
      else cancelReap(agentId);
    }
  });
}

// Self-starting: the reaper must observe EVERY agent's death, not just the one
// whose panel happens to be mounted, so it cannot live inside a component
// effect. Importing the cache (which `TerminalPanel` must do) arms it.
startTerminalCacheReaper();
