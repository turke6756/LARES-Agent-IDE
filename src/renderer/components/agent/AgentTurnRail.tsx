// AgentTurnRail.tsx — Git-Native WP-G2.4.
//
// One dot per turn in an agent's checkpoint history. Each turn shows its task
// label + status, its WITNESSED touched paths (first-class — attribution is
// witnessed write/create paths only, plan §8.2), a contention marker derived from
// other OPEN turns witnessing the same path, and an on-demand path-scoped diff that
// renders the witnessed changes first-class alongside the SEPARATELY LABELED raw
// window ("unattributed changes in this window"). Two actions per turn: "Restore a
// file…" (a chosen subset) and "Undo this turn" (the whole witnessed set) — both
// open the RestoreDialog, which enforces the preview-before-restore gate.
//
// Mounted COLLAPSED by default in AgentCard (this component renders only when the
// card's timeline is expanded), so the default card footprint is unchanged.

import React, { useEffect, useState } from 'react';
import type { CheckpointTurnSummary, CheckpointDiffResult } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import RestoreDialog from '../checkpoints/RestoreDialog';

const EMPTY_TURNS: CheckpointTurnSummary[] = [];

const STATUS_DOT: Record<string, string> = {
  completed: 'bg-accent-green',
  integrated: 'bg-accent-green',
  open: 'bg-accent-blue',
  working: 'bg-accent-blue',
  interrupted: 'bg-accent-orange',
  stopped: 'bg-accent-orange',
  crashed: 'bg-accent-red',
  failed: 'bg-accent-red',
};

/** A turn is OPEN while it has not ended — its witnessed set is still growing, so a
 *  path it shares with another open turn is contended (concurrent workers must not
 *  drag each other backward, plan §7 G2). */
function isOpen(t: CheckpointTurnSummary): boolean {
  return t.endedAt == null;
}

/** Paths witnessed by MORE THAN ONE open turn — the renderer-side contention hint
 *  derived purely from the list data (the authoritative open-turn contention for a
 *  specific restore still comes server-side via the preview). */
function deriveContendedPaths(turns: CheckpointTurnSummary[]): Set<string> {
  const counts = new Map<string, number>();
  for (const t of turns) {
    if (!isOpen(t)) continue;
    for (const p of new Set(t.witnessedPaths)) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  const contended = new Set<string>();
  for (const [p, n] of counts) if (n > 1) contended.add(p);
  return contended;
}

interface DialogState {
  turn: CheckpointTurnSummary;
  mode: 'restore' | 'revert';
  paths: string[];
}

export default function AgentTurnRail({
  workspaceId,
  agentId,
}: {
  workspaceId: string;
  agentId: string;
}) {
  const turns = useDashboardStore((s) => s.checkpointTurns[agentId] ?? EMPTY_TURNS);
  const loading = useDashboardStore((s) => s.checkpointLoading[agentId] ?? false);
  const loadCheckpointTurns = useDashboardStore((s) => s.loadCheckpointTurns);

  const [diffs, setDiffs] = useState<Record<string, CheckpointDiffResult>>({});
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  useEffect(() => {
    void loadCheckpointTurns(workspaceId, agentId);
  }, [workspaceId, agentId, loadCheckpointTurns]);

  const contended = deriveContendedPaths(turns);

  async function toggleDiff(turnId: string) {
    if (openDiff === turnId) {
      setOpenDiff(null);
      return;
    }
    setOpenDiff(turnId);
    if (!diffs[turnId]) {
      setDiffLoading(turnId);
      try {
        const d = await window.api.checkpoints.diff(workspaceId, turnId);
        setDiffs((prev) => ({ ...prev, [turnId]: d }));
      } catch {
        /* leave unloaded; the row shows the no-diff state */
      } finally {
        setDiffLoading(null);
      }
    }
  }

  return (
    <div className="mt-2 border-t border-surface-3 pt-2" data-testid="agent-turn-rail">
      <div className="text-gray-500 uppercase text-[10px] tracking-wider mb-1">Checkpoint timeline</div>

      {loading && turns.length === 0 && (
        <div className="text-gray-500 text-[11px] italic">Loading checkpoints…</div>
      )}
      {!loading && turns.length === 0 && (
        <div className="text-gray-500 text-[11px] italic">No checkpoints yet for this agent.</div>
      )}

      <ol className="space-y-2">
        {turns.map((t) => {
          const dotClass = STATUS_DOT[t.status] ?? 'bg-gray-600';
          const diff = diffs[t.turnId];
          return (
            <li key={t.turnId} className="relative pl-4" data-testid="turn-row">
              <span
                className={`absolute left-0 top-1 w-2 h-2 rounded-full ${dotClass}`}
                aria-hidden="true"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-gray-300 truncate" title={t.taskLabel ?? undefined}>
                  {t.taskLabel || `Turn ${t.turnSeq}`}
                </span>
                <span className="text-[10px] text-gray-500 uppercase shrink-0">
                  {t.status}
                  {isOpen(t) ? ' · open' : ''}
                </span>
              </div>

              {/* Witnessed paths — first-class. */}
              {t.witnessedPaths.length > 0 ? (
                <ul className="mt-0.5 space-y-0.5" data-testid="witnessed-paths">
                  {t.witnessedPaths.map((p) => (
                    <li key={p} className="font-mono text-[11px] text-gray-400 flex items-center gap-1">
                      <span className="truncate" title={p}>{p}</span>
                      {contended.has(p) && (
                        <span
                          className="text-accent-red text-[10px] shrink-0"
                          data-testid="contention-marker"
                          title="Another open turn is witnessing this path"
                        >
                          contended
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-0.5 text-[11px] text-gray-600 italic">No witnessed paths.</div>
              )}

              <div className="flex items-center gap-2 mt-1">
                <button
                  onClick={() => toggleDiff(t.turnId)}
                  className="ui-btn ui-btn-ghost px-1.5 py-0.5 text-[10px]"
                >
                  {openDiff === t.turnId ? 'Hide diff' : 'Show diff'}
                </button>
                <button
                  onClick={() =>
                    setDialog({ turn: t, mode: 'restore', paths: t.witnessedPaths })
                  }
                  disabled={t.witnessedPaths.length === 0}
                  className="ui-btn ui-btn-ghost px-1.5 py-0.5 text-[10px]"
                >
                  Restore a file…
                </button>
                <button
                  onClick={() => setDialog({ turn: t, mode: 'revert', paths: t.witnessedPaths })}
                  disabled={t.witnessedPaths.length === 0}
                  className="ui-btn ui-btn-ghost px-1.5 py-0.5 text-[10px] text-accent-orange"
                >
                  Undo this turn
                </button>
              </div>

              {openDiff === t.turnId && (
                <div className="mt-1" data-testid="turn-diff">
                  {diffLoading === t.turnId && !diff && (
                    <div className="text-gray-500 text-[11px] italic">Loading diff…</div>
                  )}
                  {diff && (
                    <>
                      {/* Witnessed diff — first-class. */}
                      <div className="text-gray-500 uppercase text-[10px] tracking-wider mb-0.5">
                        {diff.witnessed.label || 'witnessed changes'}
                      </div>
                      {diff.witnessed.available ? (
                        <pre className="log-surface border border-surface-3 p-2 max-h-28 overflow-auto whitespace-pre-wrap text-[11px]">
                          {diff.witnessed.text || '(no witnessed changes)'}
                        </pre>
                      ) : (
                        <div className="text-gray-600 text-[11px] italic">
                          Witnessed diff unavailable
                          {diff.witnessed.reason ? ` (${diff.witnessed.reason})` : ''}.
                        </div>
                      )}

                      {/* Raw window — SEPARATELY labeled as unattributed. */}
                      <div
                        className="text-gray-500 uppercase text-[10px] tracking-wider mt-1 mb-0.5"
                        data-testid="unattributed-label"
                      >
                        {diff.window.label /* "unattributed changes in this window" */} · raw
                      </div>
                      {diff.window.available ? (
                        <pre className="log-surface border border-surface-3 p-2 max-h-28 overflow-auto whitespace-pre-wrap text-[11px] opacity-80">
                          {diff.window.text || '(no changes in the window)'}
                        </pre>
                      ) : (
                        <div className="text-gray-600 text-[11px] italic">
                          Window diff unavailable
                          {diff.window.reason ? ` (${diff.window.reason})` : ''}.
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {dialog && (
        <RestoreDialog
          workspaceId={workspaceId}
          agentId={agentId}
          turn={dialog.turn}
          mode={dialog.mode}
          paths={dialog.paths}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
