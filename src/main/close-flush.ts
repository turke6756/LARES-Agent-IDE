// Main-window/app close flush handshake — main side (edit-loss plan §4.3).
//
// No handshake existed before Phase 4B: closing the main window silently
// dropped every dirty editor tab (only 'closed' listeners ran). Now main
// intercepts the close (index.ts), asks EVERY relevant renderer — the main
// window AND every detached file window, enumerated via the registry in
// detached-windows.ts — to run `saveCoordinator.flushAll(deadlineMs)`, and
// only proceeds once every reported outcome is 'saved'/'pristine'. Anything
// else ('conflict'/'error'/'timeout') raises a native dialog:
//
//   Keep waiting      → action:'retry'  for the error/timeout tabs
//   Overwrite anyway  → action:'force'  (conflict tabs ONLY; shown only when
//                       conflicts exist — the one unconditional-write path)
//   Discard and close → explicit user intent; proceed
//   Cancel            → abort the close
//
// If failures remain after a retry/force round the dialog returns — never a
// silent close. OS-forced shutdown/session-end Electron cannot delay stays a
// documented best-effort exception (flush attempted; no dialog possible).
//
// Electron-free by construction (mirrors detached-windows' seams): callers
// inject the flush targets and the dialog, so the whole state machine runs
// under plain `node` in the main test suite.

import type { FlushReplyPayload, FlushRequestPayload, FlushResult } from '../shared/types';

/** Renderer-side budget per round; the reply wait adds a small margin. */
export const CLOSE_FLUSH_DEADLINE_MS = 10_000;
const REPLY_MARGIN_MS = 2_000;

/** One renderer that can run a flush round (main window / detached window). */
export interface FlushTarget {
  /** Stable identity across rounds (window id). */
  id: string;
  /** Window label for the synthetic row when the renderer never replies. */
  label: string;
  send(payload: FlushRequestPayload): void;
  isAlive(): boolean;
}

export interface CloseFlushDialogOptions {
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

export interface CloseFlushDeps {
  targets(): FlushTarget[];
  /** Native dialog seam (production: dialog.showMessageBox → response index). */
  showDialog(opts: CloseFlushDialogOptions): Promise<number>;
  deadlineMs?: number;
  /** Test seam: extra wait past the deadline before a no-reply window is
   *  written off as a whole-window timeout. */
  replyMarginMs?: number;
}

// ── Reply correlation ───────────────────────────────────────────────────
// One outstanding request per (round, target); ipc-handlers routes
// TAB_CHANNELS.flushReply invokes here.

let requestSeq = 0;
const pendingReplies = new Map<string, (results: FlushResult[]) => void>();

/** IPC entry point (ipc-handlers.ts): a renderer answered a flush request. */
export function handleFlushReply(payload: FlushReplyPayload): void {
  const resolve = pendingReplies.get(payload.requestId);
  if (!resolve) return; // stale/unknown (round already timed out)
  pendingReplies.delete(payload.requestId);
  resolve(payload.results);
}

/** Synthetic tabId for a whole window that never replied. */
const windowRow = (target: FlushTarget, outcome: 'timeout' | 'error', error?: string): FlushResult => ({
  tabId: `window:${target.id}`,
  fileName: target.label,
  outcome,
  ...(error !== undefined ? { error } : {}),
});

function flushTarget(
  target: FlushTarget,
  action: FlushRequestPayload['action'],
  tabIds: string[] | undefined,
  deadlineMs: number,
  replyMarginMs: number,
): Promise<FlushResult[]> {
  const requestId = `close-flush:${++requestSeq}`;
  return new Promise<FlushResult[]>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingReplies.delete(requestId)) resolve([windowRow(target, 'timeout')]);
    }, deadlineMs + replyMarginMs);
    pendingReplies.set(requestId, (results) => {
      clearTimeout(timer);
      resolve(results);
    });
    try {
      target.send({ requestId, deadlineMs, action, ...(tabIds ? { tabIds } : {}) });
    } catch (err) {
      clearTimeout(timer);
      pendingReplies.delete(requestId);
      resolve([windowRow(target, 'error', err instanceof Error ? err.message : 'window unreachable')]);
    }
  });
}

const FAILURE_OUTCOMES = new Set<FlushResult['outcome']>(['conflict', 'error', 'timeout']);

/**
 * Run the full close-flush state machine. Resolves `true` when the close may
 * proceed (everything saved/pristine, or the user chose Discard), `false`
 * when the user cancelled the close.
 */
export async function runCloseFlush(deps: CloseFlushDeps): Promise<boolean> {
  const deadlineMs = deps.deadlineMs ?? CLOSE_FLUSH_DEADLINE_MS;
  const replyMarginMs = deps.replyMarginMs ?? REPLY_MARGIN_MS;
  // Latest known outcome per (target, tabId); targeted rounds merge over it.
  const latest = new Map<string, Map<string, FlushResult>>();

  const runRound = async (
    plan: Array<{ target: FlushTarget; action: FlushRequestPayload['action']; tabIds?: string[] }>,
  ): Promise<void> => {
    const settled = await Promise.all(
      plan.map(async ({ target, action, tabIds }) => ({
        target,
        results: await flushTarget(target, action, tabIds, deadlineMs, replyMarginMs),
      })),
    );
    for (const { target, results } of settled) {
      let per = latest.get(target.id);
      if (!per) {
        per = new Map();
        latest.set(target.id, per);
      }
      // A real reply supersedes any synthetic whole-window row.
      if (results.some((r) => !r.tabId.startsWith('window:'))) {
        per.delete(`window:${target.id}`);
      }
      for (const r of results) per.set(r.tabId, r);
    }
  };

  // Round 1: flush everything, everywhere.
  await runRound(deps.targets().filter((t) => t.isAlive()).map((target) => ({ target, action: 'flush' as const })));

  // Dialog loop: keep returning until clean, discarded, forced, or cancelled.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const failures: Array<{ targetId: string; result: FlushResult }> = [];
    for (const [targetId, per] of latest) {
      for (const result of per.values()) {
        if (FAILURE_OUTCOMES.has(result.outcome)) failures.push({ targetId, result });
      }
    }
    if (failures.length === 0) return true;

    const conflicts = failures.filter((f) => f.result.outcome === 'conflict');
    const buttons = [
      'Keep waiting',
      ...(conflicts.length > 0 ? ['Overwrite anyway'] : []),
      'Discard and close',
      'Cancel',
    ];
    const detail = failures
      .map((f) => `${f.result.fileName} — ${f.result.outcome}${f.result.error ? `: ${f.result.error}` : ''}`)
      .join('\n');
    const choice = await deps.showDialog({
      message: 'Some files could not be saved',
      detail,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    });
    const label = buttons[choice] ?? 'Cancel';

    if (label === 'Cancel') return false;
    if (label === 'Discard and close') return true;

    // Keep waiting → 'retry' the error/timeout tabs; Overwrite anyway →
    // 'force' the CONFLICT tabs only. Build one targeted request per window
    // that still owns matching tabs.
    const action: FlushRequestPayload['action'] = label === 'Overwrite anyway' ? 'force' : 'retry';
    const wanted =
      action === 'force'
        ? conflicts
        : failures.filter((f) => f.result.outcome === 'error' || f.result.outcome === 'timeout');
    const byTarget = new Map<string, string[]>();
    for (const f of wanted) {
      const list = byTarget.get(f.targetId) ?? [];
      list.push(f.result.tabId);
      byTarget.set(f.targetId, list);
    }
    const alive = new Map(deps.targets().filter((t) => t.isAlive()).map((t) => [t.id, t]));
    const plan: Array<{ target: FlushTarget; action: FlushRequestPayload['action']; tabIds?: string[] }> = [];
    for (const [targetId, tabIds] of byTarget) {
      const target = alive.get(targetId);
      if (!target) {
        // The window is gone — nothing left to save there; drop its rows.
        latest.delete(targetId);
        continue;
      }
      const realTabIds = tabIds.filter((id) => !id.startsWith('window:'));
      // A window that never replied has only its synthetic row: re-ask the
      // whole window (no tabIds) rather than target a fabricated id.
      plan.push({
        target,
        action,
        ...(realTabIds.length === tabIds.length ? { tabIds: realTabIds } : {}),
      });
    }
    await runRound(plan);
  }
}

// Test-only: reset the reply correlation state between cases.
export function __resetCloseFlushForTest(): void {
  pendingReplies.clear();
  requestSeq = 0;
}
