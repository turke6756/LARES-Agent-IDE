// RestoreDialog.tsx — Git-Native WP-G2.4.
//
// The human confirmation surface for a checkpoint restore ("Restore a file…") or a
// whole-turn undo ("Undo this turn"). Three load-bearing rules from the plan shape
// (§2.4 / §2.9) live in this component:
//
//   1. A PREVIEW IS REQUIRED before any restore can be confirmed. The confirm
//      button stays disabled until a fresh preview is fetched — the preview carries
//      the anti-TOCTOU tokens (current worktree OID per path) that the restore
//      echoes back, and surfaces the current open-turn contention.
//   2. The RAW WINDOW diff is shown but CLEARLY LABELED "unattributed changes in
//      this window" — it is NOT attributed to this turn (attribution is witnessed
//      write/create paths only, plan §8.2). Restore never touches those bytes; the
//      section is informational so the human sees what else moved in the window.
//   3. A CONTENT-SEMANTICS WARNING shows when the turn's before-edge captured
//      filter-managed bytes (LFS / git-crypt) as raw on-disk bytes
//      (`beforeRawFilterBypassed`): a restore rewrites those on-disk bytes and does
//      NOT reconstruct the managed form.
//
// The dialog drives the store's checkpoint actions; it invents no IPC of its own.

import React, { useState } from 'react';
import type {
  CheckpointTurnSummary,
  CheckpointPreviewResult,
  CheckpointDiffEntry,
  CheckpointRestoreResult,
} from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';

export interface RestoreDialogProps {
  workspaceId: string;
  /** The agent whose rail opened this dialog — used to refresh after the mutation.
   *  Not `turn.agentId` (which may be null on a late-bound row). */
  agentId: string;
  turn: CheckpointTurnSummary;
  /** 'restore' = a chosen subset of witnessed paths; 'revert' = the whole turn. */
  mode: 'restore' | 'revert';
  /** Candidate paths (a subset of the turn's witnessed set). For 'revert' these are
   *  informational (the whole witnessed set is undone server-side). */
  paths: string[];
  onClose: () => void;
  onDone?: (result: CheckpointRestoreResult) => void;
}

/** The exact content-semantics warning copy (plan §2.4). */
export const FILTER_BYPASS_WARNING =
  'Restoring writes on-disk bytes; the LFS/git-crypt-managed form is not reconstructed.';

export default function RestoreDialog({
  workspaceId,
  agentId,
  turn,
  mode,
  paths,
  onClose,
  onDone,
}: RestoreDialogProps) {
  const previewCheckpointRestore = useDashboardStore((s) => s.previewCheckpointRestore);
  const restoreCheckpointPaths = useDashboardStore((s) => s.restoreCheckpointPaths);
  const revertCheckpointTurn = useDashboardStore((s) => s.revertCheckpointTurn);

  // For a path-scoped restore the human can trim the candidate set; a revert always
  // acts on the whole witnessed set, so the checkboxes are display-only there.
  const [selected, setSelected] = useState<Set<string>>(new Set(paths));
  const effectivePaths = mode === 'revert' ? turn.witnessedPaths : Array.from(selected);

  const [preview, setPreview] = useState<CheckpointPreviewResult | null>(null);
  const [windowDiff, setWindowDiff] = useState<CheckpointDiffEntry | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckpointRestoreResult | null>(null);

  const contention = preview?.contention ?? [];
  const rejected = preview?.rejectedPaths ?? [];
  // A stale preview is one taken before the current selection — confirming with a
  // preview in hand is the whole gate, so any preview unlocks confirm; re-preview is
  // offered whenever the selection changes.
  const canConfirm = !!preview && !confirming && (mode === 'revert' || effectivePaths.length > 0);

  async function handlePreview() {
    setPreviewing(true);
    setError(null);
    setResult(null);
    try {
      const [pv, diff] = await Promise.all([
        previewCheckpointRestore(workspaceId, turn.turnId, effectivePaths),
        window.api.checkpoints.diff(workspaceId, turn.turnId),
      ]);
      setPreview(pv);
      setWindowDiff(diff.window);
    } catch (err) {
      setError(`Preview failed: ${String(err)}`);
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    if (!preview) return; // hard gate — never restore without a preview in hand
    setConfirming(true);
    setError(null);
    try {
      // Echo back only the tokens for the paths we are actually restoring.
      const tokens: Record<string, string> = {};
      const scope = mode === 'revert' ? turn.witnessedPaths : effectivePaths;
      for (const p of scope) {
        if (preview.tokens[p] !== undefined) tokens[p] = preview.tokens[p];
      }
      const out =
        mode === 'revert'
          ? await revertCheckpointTurn(
              { workspaceId, turnId: turn.turnId, previewTokens: tokens, force },
              agentId,
            )
          : await restoreCheckpointPaths(
              { workspaceId, turnId: turn.turnId, paths: effectivePaths, previewTokens: tokens, force },
              agentId,
            );
      setResult(out);
      onDone?.(out);
    } catch (err) {
      setError(`Restore failed: ${String(err)}`);
    } finally {
      setConfirming(false);
    }
  }

  function togglePath(p: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
    // Any change to the selection invalidates the preview (its tokens are
    // path-scoped) — force a re-preview before the next confirm.
    setPreview(null);
    setWindowDiff(null);
  }

  const title = mode === 'revert' ? 'Undo this turn' : 'Restore a file';

  return (
    <div
      role="dialog"
      aria-label={title}
      data-testid="restore-dialog"
      className="panel-shell absolute inset-0 z-40 border-accent-orange p-3 flex flex-col text-[12px] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-accent-orange font-semibold uppercase tracking-wider text-[11px]">
          {title}
        </span>
        <button onClick={onClose} className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px]">
          Close
        </button>
      </div>

      <div className="text-gray-400 mb-2">
        {turn.taskLabel || `Turn ${turn.turnSeq}`}
        {turn.agentTitle ? ` — ${turn.agentTitle}` : ''}
      </div>

      {/* CONTENT-SEMANTICS warning — a property of the turn's before-edge, shown
          up front (independent of the preview). */}
      {turn.beforeRawFilterBypassed && (
        <div
          role="alert"
          data-testid="filter-bypass-warning"
          className="mb-2 p-2 rounded text-accent-orange bg-accent-orange/10 border border-accent-orange/40"
        >
          <span className="font-semibold">Filtered content: </span>
          {FILTER_BYPASS_WARNING}
        </div>
      )}

      {/* Witnessed path selection (restore) / summary (revert). */}
      <div className="mb-2">
        <div className="text-gray-500 uppercase text-[10px] tracking-wider mb-1">
          Witnessed paths {mode === 'restore' ? '(select to restore)' : '(all undone)'}
        </div>
        {turn.witnessedPaths.length === 0 ? (
          <div className="text-gray-500 italic">No witnessed paths for this turn.</div>
        ) : (
          <ul className="space-y-0.5">
            {turn.witnessedPaths.map((p) => (
              <li key={p} className="flex items-center gap-1.5 font-mono">
                <input
                  type="checkbox"
                  checked={mode === 'revert' ? true : selected.has(p)}
                  disabled={mode === 'revert'}
                  onChange={() => togglePath(p)}
                />
                <span className="truncate" title={p}>{p}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={handlePreview}
          disabled={previewing || (mode === 'restore' && effectivePaths.length === 0)}
          className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] font-semibold"
        >
          {previewing ? 'Previewing…' : preview ? 'Re-preview' : 'Preview changes'}
        </button>
        {!preview && (
          <span className="text-gray-500 text-[11px]">A preview is required before restoring.</span>
        )}
      </div>

      {/* Current conflicts — open-turn contention + non-witnessed rejects. */}
      {preview && (contention.length > 0 || rejected.length > 0) && (
        <div
          data-testid="conflicts"
          className="mb-2 p-2 rounded text-accent-red bg-accent-red/10 border border-accent-red/30"
        >
          <div className="font-semibold mb-1">Current conflicts</div>
          {contention.map((c) => (
            <div key={`${c.path}:${c.turnId}`} className="font-mono text-[11px]">
              {c.path} — witnessed by open turn {c.turnId}
            </div>
          ))}
          {rejected.map((p) => (
            <div key={`rej:${p}`} className="font-mono text-[11px]">
              {p} — not witnessed by this turn (rejected)
            </div>
          ))}
        </div>
      )}

      {/* Optional force: IPC-only stale-preview override. Main STILL refuses it while
          an active turn witnesses a path, so it is offered, not guaranteed. */}
      {preview && contention.length > 0 && (
        <label className="flex items-center gap-1.5 mb-2 text-[11px] text-gray-400">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          Override a stale preview (force) — main refuses this while a turn is still active.
        </label>
      )}

      {/* Unattributed window diff — CLEARLY labeled as raw/unattributed. */}
      {preview && windowDiff && (
        <div className="mb-2" data-testid="unattributed-window">
          <div className="text-gray-500 uppercase text-[10px] tracking-wider mb-1">
            {windowDiff.label /* "unattributed changes in this window" */} · raw · not attributed to this turn
          </div>
          {windowDiff.available ? (
            <pre className="log-surface border border-surface-3 p-2 max-h-32 overflow-auto whitespace-pre-wrap text-[11px]">
              {windowDiff.text || '(no changes in the window)'}
            </pre>
          ) : (
            <div className="text-gray-500 italic">
              Window diff unavailable{windowDiff.reason ? ` (${windowDiff.reason})` : ''}.
            </div>
          )}
        </div>
      )}

      {error && (
        <div role="alert" className="mb-2 text-accent-red text-[11px]">
          {error}
        </div>
      )}

      {result && (
        <div role="status" className="mb-2 text-[11px] text-gray-300" data-testid="restore-result">
          Restore {result.status}: {result.completedPaths.length} restored
          {result.failures.length > 0 ? `, ${result.failures.length} failed` : ''}
          {result.failureReason ? ` — ${result.failureReason}` : ''}
        </div>
      )}

      <div className="flex gap-2 mt-auto pt-1">
        <button
          onClick={handleConfirm}
          disabled={!canConfirm}
          data-testid="confirm-restore"
          className="ui-btn ui-btn-danger flex-1 py-1 text-[12px] font-semibold border-accent-orange/50"
          title={!preview ? 'Preview the changes before restoring' : undefined}
        >
          {confirming ? 'Restoring…' : mode === 'revert' ? 'Confirm undo' : 'Confirm restore'}
        </button>
        <button onClick={onClose} className="ui-btn ui-btn-ghost px-3 py-1 text-[12px]">
          Cancel
        </button>
      </div>
    </div>
  );
}
