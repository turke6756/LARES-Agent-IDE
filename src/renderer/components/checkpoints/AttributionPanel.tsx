// AttributionPanel.tsx — Git-Native WP-G3.2 (richer attribution UI).
//
// A WORKSPACE-scoped surface layered on the WP-G2.2 rail data (all agents' turns,
// loaded via the list route with no agentId). It adds the four G3-half pieces on
// top of the per-agent time rail (plan shape §2.3, §6, §7):
//
//   1. ATTRIBUTED-vs-UNATTRIBUTED COMPARISON — per turn, the witnessed (attributed)
//      diff is shown SIDE-BY-SIDE with the raw window ("unattributed changes in this
//      window"). The unattributed side is never labeled as attributed. A turn that
//      witnessed nothing (a shell-mediated write) lands ONLY in the unattributed
//      partition and shows only the window diff (§7 G3 gate).
//   2. CONTENTION VISUALIZATION — paths witnessed by >1 OPEN turn are surfaced
//      prominently with every contender (which agents/turns), and route to the
//      existing conflict-confirmation flow (RestoreDialog). Same-file concurrency is
//      recoverable, not surgically attributable — we never imply a clean split.
//   3. FILTERING — by path/glob, agent, turn status, attributed/unattributed.
//   4. STATISTICS — per-workspace and per-agent roll-ups from the delivered DTOs
//      (files touched, witnessed vs unattributed turn counts, contention counts).
//      Witnessed numbers are EVIDENCE, not a productivity metric.
//
// Presentation only: everything is computed from data the list/diff routes already
// deliver. No new IPC, no worktree bytes, no main-process change.

import React, { useEffect, useMemo, useState } from 'react';
import type { CheckpointTurnSummary, CheckpointDiffResult } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import RestoreDialog from './RestoreDialog';
import {
  EMPTY_FILTERS,
  type AttributionFilters,
  filterTurns,
  isAttributed,
  isOpen,
  computeAttributionStats,
  deriveWorkspaceContention,
  contendedPathSet,
  distinctAgents,
  distinctStatuses,
} from './attribution-stats';

const EMPTY_TURNS: CheckpointTurnSummary[] = [];

interface DialogState {
  turn: CheckpointTurnSummary;
  mode: 'restore' | 'revert';
  paths: string[];
}

export interface AttributionPanelProps {
  workspaceId: string;
  onClose: () => void;
}

export default function AttributionPanel({ workspaceId, onClose }: AttributionPanelProps) {
  const turns = useDashboardStore((s) => s.workspaceCheckpointTurns[workspaceId] ?? EMPTY_TURNS);
  const loading = useDashboardStore((s) => s.workspaceCheckpointLoading[workspaceId] ?? false);
  const load = useDashboardStore((s) => s.loadWorkspaceCheckpointTurns);

  const [filters, setFilters] = useState<AttributionFilters>(EMPTY_FILTERS);
  const [diffs, setDiffs] = useState<Record<string, CheckpointDiffResult>>({});
  const [openCompare, setOpenCompare] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  useEffect(() => {
    void load(workspaceId);
  }, [workspaceId, load]);

  const stats = useMemo(() => computeAttributionStats(turns), [turns]);
  const contention = useMemo(() => deriveWorkspaceContention(turns), [turns]);
  const contended = useMemo(() => contendedPathSet(turns), [turns]);
  const agents = useMemo(() => distinctAgents(turns), [turns]);
  const statuses = useMemo(() => distinctStatuses(turns), [turns]);

  const filtered = useMemo(() => filterTurns(turns, filters), [turns, filters]);
  const attributed = filtered.filter(isAttributed);
  const unattributed = filtered.filter((t) => !isAttributed(t));

  async function toggleCompare(turnId: string) {
    if (openCompare === turnId) {
      setOpenCompare(null);
      return;
    }
    setOpenCompare(turnId);
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

  function findTurn(turnId: string): CheckpointTurnSummary | undefined {
    return turns.find((t) => t.turnId === turnId);
  }

  return (
    <div
      role="dialog"
      aria-label="Workspace attribution"
      data-testid="attribution-panel"
      className="panel-shell absolute inset-0 z-40 border-accent-blue p-3 flex flex-col text-[12px] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-accent-blue font-semibold uppercase tracking-wider text-[11px]">
          Workspace attribution
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => void load(workspaceId)}
            className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px]"
          >
            Refresh
          </button>
          <button onClick={onClose} className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px]">
            Close
          </button>
        </div>
      </div>

      {loading && turns.length === 0 && (
        <div className="text-gray-500 text-[11px] italic">Loading workspace checkpoints…</div>
      )}
      {!loading && turns.length === 0 && (
        <div className="text-gray-500 text-[11px] italic" data-testid="attribution-empty">
          No checkpoints yet for this workspace.
        </div>
      )}

      {turns.length > 0 && (
        <>
          {/* ── Contention (cross-agent) — prominent, leads to conflict confirm. ── */}
          {contention.length > 0 && (
            <section
              data-testid="contention-section"
              className="mb-3 p-2 rounded text-accent-red bg-accent-red/10 border border-accent-red/40"
            >
              <div className="font-semibold mb-1 uppercase tracking-wider text-[10px]">
                Contended paths — concurrent open turns
              </div>
              <div className="text-[11px] text-accent-red/90 mb-1.5">
                Same-file concurrency is recoverable, not cleanly attributable to one
                agent. Confirm conflicts before restoring.
              </div>
              <ul className="space-y-1.5">
                {contention.map((c) => (
                  <li key={c.path} data-testid="contended-path">
                    <div className="font-mono text-[11px] text-accent-red break-all">{c.path}</div>
                    <ul className="mt-0.5 ml-2 space-y-0.5">
                      {c.contenders.map((ct) => (
                        <li
                          key={`${c.path}:${ct.turnId}`}
                          data-testid="contender"
                          className="flex items-center justify-between gap-2 text-[11px] text-gray-300"
                        >
                          <span className="truncate">
                            {ct.agentTitle || ct.agentId || 'unknown agent'}
                            {ct.taskLabel ? ` · ${ct.taskLabel}` : ''} · turn {ct.turnId}
                          </span>
                          <button
                            onClick={() => {
                              const t = findTurn(ct.turnId);
                              if (t) setDialog({ turn: t, mode: 'restore', paths: [c.path] });
                            }}
                            className="ui-btn ui-btn-ghost px-1.5 py-0.5 text-[10px] text-accent-orange shrink-0"
                          >
                            Resolve conflict…
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── Statistics roll-up ── */}
          <section data-testid="attribution-stats" className="mb-3">
            <div className="text-gray-500 uppercase text-[10px] tracking-wider mb-1">
              Statistics
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-gray-300 mb-1.5">
              <span data-testid="stat-turns">Turns: {stats.totalTurns}</span>
              <span data-testid="stat-attributed">Attributed turns: {stats.attributedTurns}</span>
              <span data-testid="stat-unattributed">
                Unattributed turns: {stats.unattributedTurns}
              </span>
              <span data-testid="stat-files">Files touched: {stats.filesTouched}</span>
              <span data-testid="stat-witnessed">Witnessed writes: {stats.witnessedWrites}</span>
              <span data-testid="stat-contended">Contended paths: {stats.contendedPaths}</span>
            </div>
            {stats.byAgent.length > 0 && (
              <table className="w-full text-[11px] text-gray-400" data-testid="agent-stats-table">
                <thead>
                  <tr className="text-gray-500 uppercase text-[10px] tracking-wider text-left">
                    <th className="font-normal pr-2">Agent</th>
                    <th className="font-normal pr-2">Turns</th>
                    <th className="font-normal pr-2">Attr.</th>
                    <th className="font-normal pr-2">Unattr.</th>
                    <th className="font-normal pr-2">Files touched</th>
                    <th className="font-normal pr-2">Contended</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byAgent.map((a) => (
                    <tr key={a.agentId ?? 'none'} data-testid="agent-stat-row">
                      <td className="pr-2 truncate max-w-[10rem] text-gray-300">
                        {a.agentTitle || a.agentId || 'unattributed'}
                      </td>
                      <td className="pr-2">{a.turnCount}</td>
                      <td className="pr-2">{a.attributedTurns}</td>
                      <td className="pr-2">{a.unattributedTurns}</td>
                      <td className="pr-2">{a.filesTouched}</td>
                      <td className="pr-2 text-accent-red">{a.contendedPaths || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ── Filters ── */}
          <section data-testid="attribution-filters" className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={filters.pathGlob}
              onChange={(e) => setFilters((f) => ({ ...f, pathGlob: e.target.value }))}
              placeholder="path or glob (e.g. src/**/*.ts)"
              aria-label="Filter by path or glob"
              data-testid="filter-path"
              className="ui-input px-2 py-1 text-[11px] font-mono flex-1 min-w-[8rem]"
            />
            <select
              value={filters.agentId ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, agentId: e.target.value || null }))}
              aria-label="Filter by agent"
              data-testid="filter-agent"
              className="ui-input px-2 py-1 text-[11px]"
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.agentTitle || a.agentId}
                </option>
              ))}
            </select>
            <select
              value={filters.status ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value || null }))}
              aria-label="Filter by status"
              data-testid="filter-status"
              className="ui-input px-2 py-1 text-[11px]"
            >
              <option value="">All statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={filters.attribution}
              onChange={(e) =>
                setFilters((f) => ({ ...f, attribution: e.target.value as AttributionFilters['attribution'] }))
              }
              aria-label="Filter by attribution"
              data-testid="filter-attribution"
              className="ui-input px-2 py-1 text-[11px]"
            >
              <option value="all">Attributed + unattributed</option>
              <option value="attributed">Attributed only</option>
              <option value="unattributed">Unattributed only</option>
            </select>
          </section>

          {/* ── Attributed partition ── */}
          <section data-testid="attributed-partition" className="mb-3">
            <div className="text-gray-500 uppercase text-[10px] tracking-wider mb-1">
              Attributed changes (witnessed) · {attributed.length}
            </div>
            {attributed.length === 0 ? (
              <div className="text-gray-600 text-[11px] italic">No attributed turns match.</div>
            ) : (
              <ol className="space-y-2">
                {attributed.map((t) => (
                  <TurnRow
                    key={t.turnId}
                    turn={t}
                    contended={contended}
                    open={openCompare === t.turnId}
                    diff={diffs[t.turnId]}
                    diffLoading={diffLoading === t.turnId}
                    onToggle={() => void toggleCompare(t.turnId)}
                    onRestore={() => setDialog({ turn: t, mode: 'restore', paths: t.witnessedPaths })}
                    onRevert={() => setDialog({ turn: t, mode: 'revert', paths: t.witnessedPaths })}
                  />
                ))}
              </ol>
            )}
          </section>

          {/* ── Unattributed partition — NEVER presented as attributed. ── */}
          <section data-testid="unattributed-partition" className="mb-1">
            <div
              className="text-gray-500 uppercase text-[10px] tracking-wider mb-1"
              data-testid="unattributed-partition-label"
            >
              Unattributed changes in this window · {unattributed.length}
            </div>
            <div className="text-[11px] text-gray-600 mb-1">
              These turns witnessed no write/create — any changes are raw-window only
              (e.g. a shell-mediated write) and are NOT attributed to the agent.
            </div>
            {unattributed.length === 0 ? (
              <div className="text-gray-600 text-[11px] italic">No unattributed turns match.</div>
            ) : (
              <ol className="space-y-2">
                {unattributed.map((t) => (
                  <TurnRow
                    key={t.turnId}
                    turn={t}
                    contended={contended}
                    open={openCompare === t.turnId}
                    diff={diffs[t.turnId]}
                    diffLoading={diffLoading === t.turnId}
                    onToggle={() => void toggleCompare(t.turnId)}
                  />
                ))}
              </ol>
            )}
          </section>
        </>
      )}

      {dialog && (
        <RestoreDialog
          workspaceId={workspaceId}
          agentId={dialog.turn.agentId ?? ''}
          turn={dialog.turn}
          mode={dialog.mode}
          paths={dialog.paths}
          onClose={() => setDialog(null)}
          onDone={() => void load(workspaceId)}
        />
      )}
    </div>
  );
}

/** One turn in a partition: witnessed paths (contention-marked) + an on-demand
 *  attributed-vs-unattributed side-by-side comparison. `onRestore`/`onRevert` are
 *  omitted for unattributed turns (nothing witnessed to restore). */
function TurnRow({
  turn,
  contended,
  open,
  diff,
  diffLoading,
  onToggle,
  onRestore,
  onRevert,
}: {
  turn: CheckpointTurnSummary;
  contended: Set<string>;
  open: boolean;
  diff: CheckpointDiffResult | undefined;
  diffLoading: boolean;
  onToggle: () => void;
  onRestore?: () => void;
  onRevert?: () => void;
}) {
  const attributed = isAttributed(turn);
  return (
    <li className="border border-surface-3 rounded p-2" data-testid="attribution-turn-row">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-gray-300 truncate" title={turn.taskLabel ?? undefined}>
          {turn.taskLabel || `Turn ${turn.turnSeq}`}
          <span className="text-gray-500"> · {turn.agentTitle || turn.agentId || 'unknown'}</span>
        </span>
        <span className="text-[10px] text-gray-500 uppercase shrink-0">
          {turn.status}
          {isOpen(turn) ? ' · open' : ''}
        </span>
      </div>

      {attributed ? (
        <ul className="mt-0.5 space-y-0.5" data-testid="row-witnessed-paths">
          {turn.witnessedPaths.map((p) => (
            <li key={p} className="font-mono text-[11px] text-gray-400 flex items-center gap-1">
              <span className="truncate" title={p}>{p}</span>
              {contended.has(p) && (
                <span
                  className="text-accent-red text-[10px] shrink-0"
                  data-testid="row-contention-marker"
                  title="Another open turn is witnessing this path"
                >
                  contended
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-0.5 text-[11px] text-gray-600 italic">
          No witnessed paths — unattributed.
        </div>
      )}

      <div className="flex items-center gap-2 mt-1">
        <button onClick={onToggle} className="ui-btn ui-btn-ghost px-1.5 py-0.5 text-[10px]">
          {open ? 'Hide comparison' : 'Compare attributed vs unattributed'}
        </button>
        {onRestore && (
          <button
            onClick={onRestore}
            disabled={turn.witnessedPaths.length === 0}
            className="ui-btn ui-btn-ghost px-1.5 py-0.5 text-[10px]"
          >
            Restore a file…
          </button>
        )}
        {onRevert && (
          <button
            onClick={onRevert}
            disabled={turn.witnessedPaths.length === 0}
            className="ui-btn ui-btn-ghost px-1.5 py-0.5 text-[10px] text-accent-orange"
          >
            Undo this turn
          </button>
        )}
      </div>

      {open && (
        <div className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-2" data-testid="comparison">
          {/* Attributed (witnessed) column. */}
          <div data-testid="comparison-attributed">
            <div className="text-gray-500 uppercase text-[10px] tracking-wider mb-0.5">
              {diff?.witnessed.label || 'witnessed changes'} · attributed
            </div>
            {diffLoading && !diff ? (
              <div className="text-gray-500 text-[11px] italic">Loading diff…</div>
            ) : !attributed ? (
              <div className="text-gray-600 text-[11px] italic">
                This turn attributed nothing — no witnessed changes.
              </div>
            ) : diff?.witnessed.available ? (
              <pre className="log-surface border border-surface-3 p-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">
                {diff.witnessed.text || '(no witnessed changes)'}
              </pre>
            ) : diff ? (
              <div className="text-gray-600 text-[11px] italic">
                Witnessed diff unavailable
                {diff.witnessed.reason ? ` (${diff.witnessed.reason})` : ''}.
              </div>
            ) : null}
          </div>

          {/* Unattributed raw window column — clearly labeled, never attributed. */}
          <div data-testid="comparison-unattributed">
            <div
              className="text-gray-500 uppercase text-[10px] tracking-wider mb-0.5"
              data-testid="comparison-unattributed-label"
            >
              {diff?.window.label || 'unattributed changes in this window'} · raw · not attributed
            </div>
            {diffLoading && !diff ? (
              <div className="text-gray-500 text-[11px] italic">Loading diff…</div>
            ) : diff?.window.available ? (
              <pre className="log-surface border border-surface-3 p-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] opacity-80">
                {diff.window.text || '(no changes in the window)'}
              </pre>
            ) : diff ? (
              <div className="text-gray-600 text-[11px] italic">
                Window diff unavailable
                {diff.window.reason ? ` (${diff.window.reason})` : ''}.
              </div>
            ) : null}
          </div>
        </div>
      )}
    </li>
  );
}
