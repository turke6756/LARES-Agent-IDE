import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { AgentPersona, ContextGaugeSettings } from '../../../shared/types';
import {
  CONTEXT_GAUGE_CAP_MIN_TOKENS,
  CONTEXT_GAUGE_CAP_MAX_TOKENS,
  CONTEXT_GAUGE_CAP_TOKENS,
} from '../../../shared/constants';

// Context Window Warning tool tab: one slider per agent role setting the token
// count at which that role's context gauge reads 100%. Fixed rows for the three
// app lanes plus one row per custom persona in the selected workspace (same
// enumeration source as the Launch Agent dropdown). Persisted main-side via the
// context-gauge settings IPC; the readers pick a change up on their next poll
// and the supervisor recomputes cached claude readings immediately.

const SLIDER_STEP = 10_000;
/** Debounce commits so dragging a slider doesn't write a file per pixel. */
const COMMIT_DEBOUNCE_MS = 400;

function formatTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(v / 1000)}K`;
}

interface RowSpec {
  key: string; // 'worker' | 'supervisor' | 'researcher' | 'persona:<name>'
  label: string;
  description: string;
}

const FIXED_ROWS: RowSpec[] = [
  { key: 'worker', label: 'Worker', description: 'Default lane for launched agents (.lares/workers/…)' },
  { key: 'supervisor', label: 'Supervisor', description: 'The workspace supervisor (.lares/supervisor/)' },
  { key: 'researcher', label: 'Researcher', description: 'The browsing researcher lane (.lares/researcher/)' },
];

export default function ContextWindowWarningPanel() {
  const workspaces = useDashboardStore((s) => s.workspaces);
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  const [settings, setSettings] = useState<ContextGaugeSettings | null>(null);
  const [personas, setPersonas] = useState<AgentPersona[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Live slider values keyed by row key — the source of truth while dragging.
  const [values, setValues] = useState<Record<string, number>>({});
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The freshest settings snapshot, for merging unlisted personas on save.
  const settingsRef = useRef<ContextGaugeSettings | null>(null);
  settingsRef.current = settings;

  const applySettings = useCallback((s: ContextGaugeSettings) => {
    setSettings(s);
    setValues((prev) => {
      const caps = s.contextWindowCaps;
      const next: Record<string, number> = { ...prev };
      next['worker'] = caps.worker;
      next['supervisor'] = caps.supervisor;
      next['researcher'] = caps.researcher;
      for (const [name, cap] of Object.entries(caps.personas)) next[`persona:${name}`] = cap;
      return next;
    });
  }, []);

  // Load settings + subscribe to changes from other windows.
  useEffect(() => {
    let disposed = false;
    window.api.contextGauge.getSettings()
      .then((s) => { if (!disposed) applySettings(s); })
      .catch((e) => setError(String(e?.message ?? e)));
    const off = window.api.contextGauge.onSettingsChanged((s) => { if (!disposed) applySettings(s); });
    return () => { disposed = true; off(); };
  }, [applySettings]);

  // Persona rows — reuse the Launch Agent dropdown's enumeration (persona:list),
  // minus the reserved supervisor persona (it is the Supervisor row).
  useEffect(() => {
    if (!workspace) { setPersonas([]); return; }
    window.api.personas.list(workspace.path, workspace.pathType)
      .then((list) => setPersonas(list.filter((p) => !p.isSupervisor)))
      .catch(console.error);
  }, [workspace?.id, workspace?.path, workspace?.pathType]);

  const rows: RowSpec[] = useMemo(() => [
    ...FIXED_ROWS,
    ...personas.map((p) => ({
      key: `persona:${p.name}`,
      label: p.name,
      description: p.lane ? `Custom persona (${p.lane} lane)` : 'Custom persona',
    })),
  ], [personas]);

  const commit = useCallback((nextValues: Record<string, number>) => {
    const base = settingsRef.current;
    if (!base) return;
    const personasOut: Record<string, number> = { ...base.contextWindowCaps.personas };
    for (const [key, v] of Object.entries(nextValues)) {
      if (key.startsWith('persona:')) personasOut[key.slice('persona:'.length)] = v;
    }
    const payload: ContextGaugeSettings = {
      contextWindowCaps: {
        worker: nextValues['worker'] ?? base.contextWindowCaps.worker,
        supervisor: nextValues['supervisor'] ?? base.contextWindowCaps.supervisor,
        researcher: nextValues['researcher'] ?? base.contextWindowCaps.researcher,
        personas: personasOut,
      },
    };
    window.api.contextGauge.setSettings(payload)
      .then((saved) => applySettings(saved))
      .catch((e) => setError(String(e?.message ?? e)));
  }, [applySettings]);

  const onSlide = useCallback((key: string, v: number) => {
    setValues((prev) => {
      const next = { ...prev, [key]: v };
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = setTimeout(() => commit(next), COMMIT_DEBOUNCE_MS);
      return next;
    });
  }, [commit]);

  // Flush a pending commit on unmount so a drag-then-close isn't lost.
  useEffect(() => () => { if (commitTimer.current) clearTimeout(commitTimer.current); }, []);

  return (
    <div className="h-full overflow-y-auto p-6 text-gray-200">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <Gauge size={18} className="text-blue-400" />
          <h2 className="text-[15px] font-semibold text-gray-100">Context Window Warning</h2>
        </div>
        <p className="text-[12px] text-gray-500 mb-5">
          Set, per agent role, the token count at which the context gauge reads 100%. Dashboard
          advisories (e.g. the 95% context warning) follow the same percentage. The default is
          200K; the effective cap never exceeds the model&apos;s real window. Changes apply to the
          next context reading — no restart needed.
        </p>
        {error && (
          <div className="mb-4 text-[12px] text-red-400 border border-red-900/50 rounded px-3 py-2">
            {error}
          </div>
        )}
        {!settings ? (
          <div className="text-[12px] text-gray-500">Loading settings…</div>
        ) : (
          <div className="space-y-4">
            {rows.map((row) => {
              const value = values[row.key] ?? CONTEXT_GAUGE_CAP_TOKENS;
              return (
                <div key={row.key} className="border border-gray-700/60 rounded-md px-4 py-3 bg-gray-900/40">
                  <div className="flex items-baseline justify-between mb-1">
                    <div>
                      <span className="text-[13px] font-medium text-gray-100">{row.label}</span>
                      <span className="ml-2 text-[11px] text-gray-500">{row.description}</span>
                    </div>
                    <span className="text-[13px] font-mono text-blue-300 tabular-nums">
                      {formatTokens(value)} tokens
                    </span>
                  </div>
                  <input
                    type="range"
                    min={CONTEXT_GAUGE_CAP_MIN_TOKENS}
                    max={CONTEXT_GAUGE_CAP_MAX_TOKENS}
                    step={SLIDER_STEP}
                    value={value}
                    aria-label={`Context gauge cap for ${row.label}`}
                    onChange={(e) => onSlide(row.key, Number(e.target.value))}
                    className="w-full accent-blue-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
                    <span>{formatTokens(CONTEXT_GAUGE_CAP_MIN_TOKENS)}</span>
                    <span>{formatTokens(CONTEXT_GAUGE_CAP_TOKENS)} (default)</span>
                    <span>{formatTokens(CONTEXT_GAUGE_CAP_MAX_TOKENS)}</span>
                  </div>
                </div>
              );
            })}
            {personas.length === 0 && (
              <p className="text-[11px] text-gray-600">
                No custom personas in this workspace — persona rows appear here once personas
                exist under the workspace state dir.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
