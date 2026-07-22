// Detached-process transparency section (incident-2026-07-11 §5 Wave 5).
//
// Lists the detached OS processes that agents self-registered under the
// workspace's .lares/detached/ directory. Each row's `liveness` is the
// main-process verdict — NEVER the raw `running` flag — so a hard-killed
// process (whose descriptor still claims running:true) shows as "dead", and a
// recycled PID shows as "reused". Read-only; polls on a slow cadence.

import React, { useCallback, useEffect, useState } from 'react';
import * as Icons from 'lucide-react';
import type { DetachedProcessDto, DetachedLiveness } from '../../../shared/types';

const LIVENESS: Record<DetachedLiveness, { label: string; cls: string; hint: string }> = {
  running: { label: 'running', cls: 'text-accent-green bg-accent-green/10', hint: 'PID alive and command line matches' },
  ended: { label: 'ended', cls: 'text-gray-400 bg-white/5', hint: 'Descriptor recorded a clean exit' },
  dead: { label: 'dead (stale)', cls: 'text-accent-red bg-accent-red/10', hint: 'Descriptor claims running, but the PID is gone — hard-killed' },
  reused: { label: 'PID reused', cls: 'text-accent-orange bg-accent-orange/10', hint: 'PID is alive but running a different command — recycled by an unrelated process' },
  unknown: { label: 'unknown', cls: 'text-accent-yellow bg-accent-yellow/10', hint: 'Could not verify (no PID, unreadable descriptor, or probe unavailable)' },
};

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function relTime(startTime: number | null): string {
  if (startTime == null || !Number.isFinite(startTime)) return '';
  const secs = Math.max(0, Math.round((Date.now() - startTime) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

interface Props {
  workspaceRoot: string | undefined;
}

export default function DetachedProcessesPanel({ workspaceRoot }: Props) {
  const [rows, setRows] = useState<DetachedProcessDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!workspaceRoot) { setRows([]); return; }
    setError(null);
    try {
      setRows(await window.api.detached.list(workspaceRoot));
    } catch (e) {
      setError(String(e));
      setRows([]);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 8_000);
    return () => window.clearInterval(id);
  }, [load]);

  const toggle = (file: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file); else next.add(file);
      return next;
    });

  const staleCount = (rows ?? []).filter((r) => r.liveness === 'dead' || r.liveness === 'reused').length;

  return (
    <section className="ui-card p-0 overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-2.5 border-b border-white/10">
        <Icons.Unplug className="w-4 h-4 text-accent-blue" />
        <h3 className="text-[13px] font-semibold text-gray-100">Detached processes</h3>
        {staleCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded text-accent-red bg-accent-red/10">
            {staleCount} stale
          </span>
        )}
        <button
          onClick={() => void load()}
          className="ml-auto text-gray-500 hover:text-gray-200"
          title="Rescan"
          aria-label="Rescan detached processes"
        >
          <Icons.RefreshCw className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="px-4 py-2 text-[11px] text-gray-500 border-b border-white/5">
        Long-running OS processes that agents launched outside the dashboard's own supervision.
        A hard kill can't update the descriptor file, so every "running" claim is re-verified
        against the live PID — dead and reused rows are flagged distinctly.
      </div>

      {rows === null && <div className="p-5 text-center text-[12px] text-gray-500">Scanning…</div>}
      {error && <div className="px-4 py-2 text-[12px] text-accent-red">{error}</div>}
      {rows !== null && rows.length === 0 && !error && (
        <div className="p-5 text-center text-[12px] text-gray-500">No detached processes registered.</div>
      )}

      {(rows ?? []).map((r) => {
        const meta = LIVENESS[r.liveness];
        const open = expanded.has(r.file);
        return (
          <div key={r.file} className="border-b border-white/5 text-[12px]">
            <button
              onClick={() => toggle(r.file)}
              className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-white/5"
            >
              <Icons.ChevronRight
                className={`w-3 h-3 shrink-0 text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`}
              />
              <div className="flex-1 min-w-0">
                <div className="text-gray-200 font-mono truncate">
                  {r.command ?? basename(r.file)}
                </div>
                <div className="text-gray-500 text-[10px]">
                  {r.pid != null ? `pid ${r.pid}` : 'no pid'}
                  {r.agentId ? ` · ${r.agentId}` : ''}
                  {r.phase ? ` · ${r.phase}` : ''}
                  {r.startTime != null ? ` · started ${relTime(r.startTime)}` : ''}
                </div>
              </div>
              <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${meta.cls}`} title={meta.hint}>
                {meta.label}
              </span>
            </button>

            {open && (
              <div className="px-4 pb-3 pl-10 text-[11px] text-gray-400 space-y-1">
                <div className="text-gray-500">{meta.hint}.</div>
                {r.error && <Field label="Error" value={r.error} mono />}
                {r.command && <Field label="Recorded command" value={r.command} mono />}
                {r.liveness === 'reused' && r.actualCommand && (
                  <Field label="Live command (mismatch)" value={r.actualCommand} mono danger />
                )}
                {r.stateFile && <Field label="State file" value={r.stateFile} mono />}
                {r.logFile && <Field label="Log file" value={r.logFile} mono />}
                {r.stopFile && <Field label="STOP file" value={r.stopFile} mono />}
                <Field label="Running flag (recorded)" value={String(r.runningFlag)} />
                <Field label="Descriptor" value={r.file} mono />
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Field({ label, value, mono, danger }: { label: string; value: string; mono?: boolean; danger?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-gray-600 shrink-0 w-40">{label}</span>
      <span className={`min-w-0 break-all ${mono ? 'font-mono' : ''} ${danger ? 'text-accent-orange' : 'text-gray-300'}`}>
        {value}
      </span>
    </div>
  );
}
