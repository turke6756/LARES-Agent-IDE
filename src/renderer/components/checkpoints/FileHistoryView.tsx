// FileHistoryView.tsx — Git-Native WP-G3.1 (file right-click → History).
//
// Per-turn / per-agent version list for ONE canonical path ("edited by worker-7,
// turn 12, yesterday 2:14 pm"): view / diff / restore that single path. This is the
// MEMORY.md-truncation insurance — even after a file has been overwritten many
// times, every retained turn that witnessed a write/create to it, whose before-edge
// ref STILL live-verifies, is a recoverable version.
//
// Two load-bearing rules the surface preserves:
//   1. A listed version is ALWAYS restorable — the main-side query only returns
//      edges with a live-verified before-ref (a pruned/dead edge is never shown),
//      so the human never confirms a restore against a ref git can no longer read.
//   2. Restore reuses the WP-G2.4 preview-required flow (RestoreDialog). There is NO
//      preview-less restore path here: the button just mounts the same dialog, whose
//      confirm stays disabled until a fresh preview (with anti-TOCTOU tokens) exists.

import React, { useEffect, useState } from 'react';
import type {
  CheckpointFileHistoryVersion,
  CheckpointTurnSummary,
  CheckpointDiffEntry,
} from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import RestoreDialog from './RestoreDialog';

export interface FileHistoryViewProps {
  workspaceId: string;
  /** The path the human right-clicked. Absolute or workspace-relative — the main
   *  side canonicalizes it against the repo root to match the witnessed key. */
  path: string;
  onClose: () => void;
}

/** Base name for the header, tolerant of both separators. */
function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** "yesterday 2:14 pm"-style stamp; falls back to a plain locale string. */
function whenLabel(ms: number | null): string {
  if (!ms) return 'unknown time';
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (sameDay) return `today ${time}`;
  if (isYesterday) return `yesterday ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

/** Build the CheckpointTurnSummary RestoreDialog expects, narrowed to THIS path so
 *  the dialog only ever offers to restore the one file the history is scoped to. */
function toTurnSummary(v: CheckpointFileHistoryVersion): CheckpointTurnSummary {
  return {
    turnId: v.turnId,
    turnSeq: v.turnSeq,
    agentId: v.agentId,
    agentTitle: v.agentTitle,
    taskLabel: v.taskLabel,
    status: v.status,
    startedAt: v.startedAt,
    endedAt: v.endedAt,
    beforeReady: v.beforeReady,
    afterReady: v.afterReady,
    beforeQuality: v.beforeQuality,
    afterQuality: v.afterQuality,
    witnessedPaths: [v.witnessedPath],
    failureReason: null,
    beforeRawFilterBypassed: v.beforeRawFilterBypassed,
  };
}

export default function FileHistoryView({ workspaceId, path, onClose }: FileHistoryViewProps) {
  const loadFileHistory = useDashboardStore((s) => s.loadFileHistory);

  const [versions, setVersions] = useState<CheckpointFileHistoryVersion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<CheckpointFileHistoryVersion | null>(null);
  const [openDiff, setOpenDiff] = useState<Record<string, CheckpointDiffEntry | 'loading' | undefined>>({});

  const reload = React.useCallback(async () => {
    setLoading(true);
    const res = await loadFileHistory(workspaceId, path);
    setVersions(res ?? []);
    setUnavailable(res === null);
    setLoading(false);
  }, [loadFileHistory, workspaceId, path]);

  useEffect(() => { void reload(); }, [reload]);

  async function toggleDiff(v: CheckpointFileHistoryVersion) {
    if (openDiff[v.turnId] && openDiff[v.turnId] !== 'loading') {
      setOpenDiff((prev) => ({ ...prev, [v.turnId]: undefined }));
      return;
    }
    setOpenDiff((prev) => ({ ...prev, [v.turnId]: 'loading' }));
    try {
      const diff = await window.api.checkpoints.diff(workspaceId, v.turnId);
      setOpenDiff((prev) => ({ ...prev, [v.turnId]: diff.witnessed }));
    } catch {
      setOpenDiff((prev) => ({
        ...prev,
        [v.turnId]: { available: false, reason: 'diff-failed', label: 'witnessed changes', text: null },
      }));
    }
  }

  return (
    <div
      role="dialog"
      aria-label="File history"
      data-testid="file-history-view"
      className="panel-shell absolute inset-0 z-40 border-accent-blue p-3 flex flex-col text-[12px] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-accent-blue font-semibold uppercase tracking-wider text-[11px]">
          History — <span className="font-mono normal-case tracking-normal" title={path}>{baseName(path)}</span>
        </span>
        <button onClick={onClose} className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px]">
          Close
        </button>
      </div>

      {loading ? (
        <div className="text-gray-400 animate-pulse">Loading history…</div>
      ) : unavailable ? (
        <div className="text-gray-500 italic" data-testid="file-history-unavailable">
          Checkpoint history is unavailable (no usable git, or the engine is still starting).
        </div>
      ) : versions && versions.length === 0 ? (
        <div className="text-gray-500 italic" data-testid="file-history-empty">
          No recoverable versions for this file.
        </div>
      ) : (
        <ul className="space-y-1" data-testid="file-history-list">
          {(versions ?? []).map((v) => {
            const who = v.agentTitle || v.agentId || 'unknown agent';
            const diff = openDiff[v.turnId];
            return (
              <li key={v.turnId} className="border border-surface-3 rounded p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-gray-200 truncate">
                      <span className="text-[10px] uppercase tracking-wider px-1 py-0.5 mr-1.5 rounded bg-white/5 text-gray-400">
                        {v.op === 'create' ? 'created' : 'edited'}
                      </span>
                      by <span className="text-accent-blue">{who}</span>, turn {v.turnSeq}
                    </div>
                    <div className="text-gray-500 text-[11px] truncate">
                      {whenLabel(v.endedAt ?? v.startedAt)}
                      {v.taskLabel ? ` · ${v.taskLabel}` : ''}
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button
                      onClick={() => void toggleDiff(v)}
                      disabled={!v.afterVerified}
                      title={v.afterVerified ? undefined : 'Diff needs both edges live-verified'}
                      className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px]"
                    >
                      Diff
                    </button>
                    <button
                      onClick={() => setRestoreTarget(v)}
                      data-testid={`restore-${v.turnId}`}
                      className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px] text-accent-orange"
                    >
                      Restore
                    </button>
                  </div>
                </div>

                {diff && (
                  <div className="mt-2" data-testid={`diff-${v.turnId}`}>
                    {diff === 'loading' ? (
                      <div className="text-gray-500 italic text-[11px]">Loading diff…</div>
                    ) : diff.available ? (
                      <pre className="log-surface border border-surface-3 p-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">
                        {diff.text || '(no witnessed changes)'}
                      </pre>
                    ) : (
                      <div className="text-gray-500 italic text-[11px]">
                        Diff unavailable{diff.reason ? ` (${diff.reason})` : ''}.
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {restoreTarget && (
        <RestoreDialog
          workspaceId={workspaceId}
          agentId={restoreTarget.agentId ?? ''}
          turn={toTurnSummary(restoreTarget)}
          mode="restore"
          paths={[restoreTarget.witnessedPath]}
          onClose={() => setRestoreTarget(null)}
          onDone={() => { void reload(); }}
        />
      )}
    </div>
  );
}
