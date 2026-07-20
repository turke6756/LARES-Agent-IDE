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
import { useDashboardStore } from '../../stores/dashboard-store';
import { TERMINAL_AGENT_RELEASE_DELAY_MS } from '../../../shared/constants';

export interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  unsub: (() => void) | null;
}

/** Module-level cache — survives re-renders, preserves scrollback. */
export const terminalCache = new Map<string, CachedTerminal>();

const TERMINAL_STATUSES = new Set(['done', 'crashed']);

/**
 * Single teardown path for a cached terminal: drop the IPC subscription, kill
 * the xterm (and with it the WebGL canvas + DOM node), forget the entry.
 * Idempotent — an unknown or already-disposed agent id is a no-op and returns
 * false. Shared by the reaper and by the BUG-38 rebound handler so the two can
 * never diverge.
 */
export function disposeCachedTerminal(agentId: string): boolean {
  const entry = terminalCache.get(agentId);
  if (!entry) return false;
  terminalCache.delete(agentId);
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
 */
export function reapOnLeave(agentId: string): boolean {
  const status = useDashboardStore.getState().agentStatuses[agentId]?.status;
  const dead = pendingDisposal.has(agentId) || (status !== undefined && TERMINAL_STATUSES.has(status));
  if (!dead) return false;
  return disposeCachedTerminal(agentId);
}

/** Test seam. */
export function __pendingDisposalForTest(): string[] {
  return [...pendingDisposal];
}

const reapTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelReap(agentId: string): void {
  const t = reapTimers.get(agentId);
  if (t) {
    clearTimeout(t);
    reapTimers.delete(agentId);
  }
}

/** Dispose now if off-screen; otherwise queue for the moment the viewer leaves. */
function reapNow(agentId: string): void {
  reapTimers.delete(agentId);
  if (!terminalCache.has(agentId)) return;
  if (useDashboardStore.getState().terminalAgentId === agentId) {
    pendingDisposal.add(agentId);
    return;
  }
  disposeCachedTerminal(agentId);
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
