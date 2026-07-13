// Orphan-sweep panel (incident-2026-07-11 §5 D4/D5 UI, Wave 4b).
//
// A minimal modal over the durable-ownership orphan-sweep contract
// (`window.api.memory.listOrphans` / `reapOrphans`, main handlers in
// ipc-handlers.ts). Lists leftover CLI process trees from prior app epochs (and
// current terminal rows the reaper flagged), lets the user select a subset, shows
// a best-effort reclaimable-bytes estimate, and reaps the selection. Every tree is
// re-verified in the main process before any kill; `unverifiable` rows are
// display-only (no checkbox) — manual cleanup only, per the plan.

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Icons from 'lucide-react';
import type { OrphanCandidateDto } from '../../../shared/types';
import { formatBytes } from './format';

interface Props {
  onClose: () => void;
}

const STATUS_LABEL: Record<OrphanCandidateDto['status'], string> = {
  tree: 'live tree',
  'no-tree': 'already gone',
  unverifiable: 'unverifiable',
  wsl: 'WSL / tmux',
};

/** A candidate is safely reapable when it has a verified live tree (or a WSL
 *  tmux session). `unverifiable` / `no-tree` are display-only. */
function isReapable(c: OrphanCandidateDto): boolean {
  return c.status === 'tree' || (c.status === 'wsl' && !!c.tmuxSession);
}

export default function OrphanSweepPanel({ onClose }: Props) {
  const [candidates, setCandidates] = useState<OrphanCandidateDto[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [estimateBytes, setEstimateBytes] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await window.api.memory.listOrphans();
      setCandidates(rows);
      // Pre-select every safely-reapable candidate.
      setSelected(new Set(rows.filter(isReapable).map((r) => r.agentId)));
    } catch (e) {
      setError(String(e));
      setCandidates([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Recompute the reclaimable-bytes estimate whenever the selection changes.
  useEffect(() => {
    let cancelled = false;
    const pids = (candidates ?? [])
      .filter((c) => selected.has(c.agentId))
      .flatMap((c) => c.pids);
    if (pids.length === 0) {
      setEstimateBytes(0);
      return;
    }
    void window.api.memory
      .reapEstimate(pids)
      .then((b) => { if (!cancelled) setEstimateBytes(b); })
      .catch(() => { if (!cancelled) setEstimateBytes(0); });
    return () => { cancelled = true; };
  }, [selected, candidates]);

  const toggle = (agentId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const reap = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const results = await window.api.memory.reapOrphans([...selected]);
      const reaped = results.filter((r) => r.pids.length > 0).length;
      setResult(`Reaped ${reaped} of ${results.length} selected tree(s).`);
      await load();
      setSelected(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reapableCount = (candidates ?? []).filter(isReapable).length;

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 app-no-drag"
      onClick={onClose}
    >
      <div
        className="ui-card w-[560px] max-w-[92vw] max-h-[80vh] flex flex-col p-0 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Icons.Recycle className="w-4 h-4 text-accent-orange" />
            <h2 className="text-[14px] font-semibold text-gray-100">Orphaned agent processes</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200" aria-label="Close">
            <Icons.X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-2 text-[11px] text-gray-500 border-b border-white/5">
          Leftover CLI process trees from prior app runs (and current terminals the reaper
          flagged). Each tree is re-verified before it is terminated; unverifiable rows are
          display-only.
        </div>

        <div className="flex-1 overflow-y-auto">
          {candidates === null && (
            <div className="p-6 text-center text-[12px] text-gray-500">Scanning…</div>
          )}
          {candidates !== null && candidates.length === 0 && (
            <div className="p-6 text-center text-[12px] text-gray-500">
              No orphaned process trees found.
            </div>
          )}
          {(candidates ?? []).map((c) => {
            const reapable = isReapable(c);
            return (
              <label
                key={`${c.agentId}:${c.instanceEpoch}`}
                className={`flex items-center gap-3 px-4 py-2 border-b border-white/5 text-[12px] ${
                  reapable ? 'cursor-pointer hover:bg-white/5' : 'opacity-60 cursor-default'
                }`}
              >
                <input
                  type="checkbox"
                  disabled={!reapable || busy}
                  checked={selected.has(c.agentId)}
                  onChange={() => toggle(c.agentId)}
                  className="accent-accent-orange"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-gray-200 font-mono truncate">{c.agentId}</div>
                  <div className="text-gray-500 text-[10px]">
                    {c.transport}
                    {c.priorEpoch ? ' · prior run' : ' · current run'}
                    {c.rootPid != null ? ` · pid ${c.rootPid}` : ''}
                    {c.pids.length > 0 ? ` · ${c.pids.length} proc` : ''}
                  </div>
                </div>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${
                    c.status === 'tree'
                      ? 'text-accent-orange bg-accent-orange/10'
                      : c.status === 'unverifiable'
                        ? 'text-accent-yellow bg-accent-yellow/10'
                        : 'text-gray-500 bg-white/5'
                  }`}
                >
                  {STATUS_LABEL[c.status]}
                </span>
              </label>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-white/10 flex items-center justify-between gap-3">
          <div className="text-[11px] text-gray-500">
            {selected.size} selected
            {estimateBytes > 0 ? ` · ~${formatBytes(estimateBytes)} reclaimable` : ''}
            {result ? ` · ${result}` : ''}
            {error ? <span className="text-accent-red"> · {error}</span> : ''}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void load()}
              disabled={busy}
              className="ui-btn px-3 py-1.5 text-[12px] disabled:opacity-50"
            >
              Rescan
            </button>
            <button
              onClick={() => void reap()}
              disabled={busy || selected.size === 0 || reapableCount === 0}
              className="ui-btn ui-btn-primary px-3 py-1.5 text-[12px] disabled:opacity-50"
            >
              {busy ? 'Reaping…' : `Reap ${selected.size || ''}`.trim()}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
