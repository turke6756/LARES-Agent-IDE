// Unified "Live agents & memory" panel (System-Memory polish Part 5) — one
// section replacing both the raw AttributionTable and the standalone §B8
// stale-idle card.
//
// Two trusted sources meet here, joined main-side (memory:system-view):
//   - the live-agent REGISTRY (getActiveAgents) — exactly one row per live
//     agent, human titles, never prior-epoch trees;
//   - the attribution rollup — per-row memory with explicit "unattributable"
//     (null) rather than a false 0 B.
//
// The §B8 sweep invariants are preserved exactly (they live in
// useStaleIdleSweep): preview before action, preview pinned to the persisted
// threshold, exclusions shown. Results render honestly: a `failed` item means
// the process was NOT confirmed gone and is never folded into "stopped".
//
// Deliberately NO per-row Stop button: the destructive surface here is the
// threshold sweep; per-agent stop already exists on the AgentCard (§B8).

import React, { useCallback, useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import type {
  AutoStopThreshold,
  LiveAgentMemoryRowDto,
  LogRetentionCap,
  SystemMemoryViewDto,
} from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import { summarizeStopExclusions } from '../../lib/stop-exclusion-copy';
import { formatBytes, idleFor } from './format';
import { useStaleIdleSweep } from './useStaleIdleSweep';

/** Selector options. Order and values mirror `AutoStopThreshold` exactly. */
const THRESHOLD_OPTIONS: Array<{ value: AutoStopThreshold; label: string }> = [
  { value: 'never', label: 'Never (off)' },
  { value: '6h', label: 'After 6 hours idle' },
  { value: '12h', label: 'After 12 hours idle' },
  { value: '24h', label: 'After 24 hours idle' },
  { value: '3d', label: 'After 3 days idle' },
  { value: '7d', label: 'After 7 days idle' },
];

/** Terminal-history cap options (WP-7). Order and values mirror
 *  `LogRetentionCap`; 'unlimited' keeps every log (disk-cost only). */
const CAP_OPTIONS: Array<{ value: LogRetentionCap; label: string }> = [
  { value: '1gib', label: '1 GiB' },
  { value: '2gib', label: '2 GiB' },
  { value: '5gib', label: '5 GiB' },
  { value: 'unlimited', label: 'Unlimited' },
];

const THRESHOLD_PHRASE: Record<AutoStopThreshold, string> = {
  never: 'never',
  '6h': '6 hours',
  '12h': '12 hours',
  '24h': '24 hours',
  '3d': '3 days',
  '7d': '7 days',
};

/** Parse a registry idleSince (SQLite UTC string) to epoch ms; null if invalid. */
function parseIdleSince(idleSince: string): number | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(idleSince)
    ? `${idleSince.replace(' ', 'T')}Z`
    : idleSince;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

export default function LiveAgentsPanel({
  view,
  onAfterStop,
}: {
  view: SystemMemoryViewDto | null;
  onAfterStop: () => void;
}) {
  const storeAgents = useDashboardStore((s) => s.agents);
  // ALWAYS invoked (no optional hook-or-prop pattern — hook invocation must
  // not vary between renders).
  const sweep = useStaleIdleSweep({ onAfterStop });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((agentId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  // Titles resolve from the composed view first (live rows), then the store
  // (ids no longer live — they were just stopped), then the raw id.
  const titleOf = useCallback(
    (agentId: string) =>
      view?.liveAgents.find((r) => r.agentId === agentId)?.title
      ?? storeAgents.find((a) => a.id === agentId)?.title
      ?? agentId,
    [view, storeAgents],
  );

  const rows = useMemo(() => {
    const list = (view?.liveAgents ?? []).slice();
    // workingSetBytes desc, nulls last, title tie-breaker.
    list.sort((a, b) => {
      if (a.workingSetBytes == null && b.workingSetBytes == null) return a.title.localeCompare(b.title);
      if (a.workingSetBytes == null) return 1;
      if (b.workingSetBytes == null) return -1;
      if (b.workingSetBytes !== a.workingSetBytes) return b.workingSetBytes - a.workingSetBytes;
      return a.title.localeCompare(b.title);
    });
    return list;
  }, [view]);

  const { preview, previewStale, threshold, logRetentionCap, busy, error, result, grouped, tally, eligibleCount, canStop, settings } = sweep;

  // Per-row sweep verdicts, only meaningful for a current (non-stale) preview.
  const sweepVerdicts = useMemo(() => {
    if (!preview || previewStale) return null;
    return {
      eligible: new Set(preview.eligible.map((e) => e.agentId)),
      excluded: new Map(preview.excluded.map((e) => [e.agentId, e.codes])),
    };
  }, [preview, previewStale]);

  const unregisteredSum = useMemo(
    () => (view?.unregisteredTrees ?? []).reduce((s, t) => s + t.workingSetBytes, 0),
    [view],
  );

  return (
    <section className="ui-card p-0 overflow-hidden" data-testid="stop-stale-idle-panel">
      <header className="flex items-center gap-2 px-4 py-2.5 border-b border-white/10">
        <Icons.Users className="w-4 h-4 text-accent-blue" />
        <h3 className="text-[13px] font-semibold text-gray-100">Live agents &amp; memory</h3>
        <span
          className="ml-auto text-[11px] text-gray-500 tabular-nums"
          title="Registered non-terminal agents (launching/working/idle/waiting/restarting)"
        >
          {view ? `${view.liveAgentCount} live agent${view.liveAgentCount === 1 ? '' : 's'}` : '…'}
        </span>
      </header>

      <div className="p-4 space-y-3">
        {/* Threshold — persisted main-side; the sweep reads the same value. */}
        <div className="flex items-center gap-3 flex-wrap">
          <label htmlFor="stale-idle-threshold" className="text-[12px] text-gray-400">
            Auto-stop agents idle longer than
          </label>
          <select
            id="stale-idle-threshold"
            className="ui-input text-[12px] px-2 py-1"
            value={threshold ?? '24h'}
            disabled={settings === null || busy !== null}
            onChange={(e) => void sweep.onThresholdChange(e.target.value as AutoStopThreshold)}
          >
            {THRESHOLD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {busy === 'settings' && <span className="text-[11px] text-gray-500">Saving…</span>}
        </div>

        {threshold === 'never' ? (
          <p className="text-[11px] text-accent-yellow">
            Automatic stopping is off. No agent is stopped for being idle, by the background sweep
            or from this panel — pick a threshold to enable it.
          </p>
        ) : (
          <p className="text-[11px] text-gray-500">
            A background sweep applies this threshold on its own schedule. Previewing here shows
            what that sweep would do right now, and lets you run it immediately.
          </p>
        )}

        {/* WP-7 — terminal-history retention cap. Persisted main-side as a
            PARTIAL set, so it never disturbs the auto-stop threshold above. */}
        <div className="flex items-center gap-3 flex-wrap border-t border-white/5 pt-3">
          <label htmlFor="log-retention-cap" className="text-[12px] text-gray-400">
            Keep terminal history up to
          </label>
          <select
            id="log-retention-cap"
            className="ui-input text-[12px] px-2 py-1"
            value={logRetentionCap ?? '2gib'}
            disabled={settings === null || busy !== null}
            onChange={(e) => void sweep.onCapChange(e.target.value as LogRetentionCap)}
          >
            {CAP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {busy === 'settings' && <span className="text-[11px] text-gray-500">Saving…</span>}
        </div>
        {logRetentionCap === 'unlimited' ? (
          <p className="text-[11px] text-gray-500">
            Terminal logs are never reclaimed to save disk — memory observability continues either
            way; this only governs on-disk history.
          </p>
        ) : (
          <p className="text-[11px] text-gray-500">
            When a stopped agent's logs push total on-disk history past this cap, the oldest are
            reclaimed to free space. A one-time notice reports the first cleanup.
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            className="ui-btn px-3 py-1.5 text-[12px]"
            disabled={settings === null || busy !== null || threshold === 'never'}
            onClick={() => void sweep.runPreview()}
          >
            {busy === 'preview' ? 'Checking…' : 'Preview'}
          </button>
          <button
            className="ui-btn ui-btn-danger px-3 py-1.5 text-[12px]"
            disabled={!canStop}
            onClick={() => void sweep.runStop()}
            title={
              preview === null
                ? 'Preview first'
                : previewStale
                  ? 'The threshold changed — preview again'
                  : undefined
            }
          >
            {busy === 'stop'
              ? 'Stopping…'
              : `Stop ${eligibleCount} idle agent${eligibleCount === 1 ? '' : 's'}`}
          </button>
        </div>

        {error && (
          <div className="text-[11px] text-accent-red" role="alert">{error}</div>
        )}

        {previewStale && (
          <div className="text-[11px] text-accent-yellow" role="alert">
            This preview was computed for {THRESHOLD_PHRASE[preview!.thresholdLabel]}, but the
            threshold is now {THRESHOLD_PHRASE[threshold!]}. Preview again before stopping.
          </div>
        )}

        {preview && !previewStale && (
          <div className="text-[11px] text-gray-400">
            {eligibleCount === 0
              ? 'No agent currently meets the threshold with every safety check clear.'
              : `${eligibleCount} agent${eligibleCount === 1 ? '' : 's'} would be stopped.`}
            {preview.estimatedReclaimBytes != null && eligibleCount > 0 && (
              preview.reclaimEstimateComplete
                ? <> ≈{formatBytes(preview.estimatedReclaimBytes)} would be reclaimed.</>
                : <> At least ≈{formatBytes(preview.estimatedReclaimBytes)} would be reclaimed (some agents unmeasured).</>
            )}
          </div>
        )}

        {/* Live-agent table — one row per registry live agent, joined to
            attribution main-side. "—" means unattributable, never 0 B. */}
        <div className="overflow-x-auto border-t border-white/5 pt-1">
          <table className="w-full text-[12px] border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-gray-600">
                <th className="text-left font-medium px-2 py-1.5">Agent</th>
                <th className="text-left font-medium px-2 py-1.5">Status</th>
                <th className="text-left font-medium px-2 py-1.5">Transport</th>
                <th className="text-right font-medium px-2 py-1.5">Working set</th>
                <th className="text-right font-medium px-2 py-1.5">Commit</th>
                <th className="text-right font-medium px-2 py-1.5">Procs</th>
                <th className="text-left font-medium px-2 py-1.5">Source</th>
                <th className="text-left font-medium px-2 py-1.5">Sweep</th>
              </tr>
            </thead>
            <tbody>
              {view === null && (
                <tr><td colSpan={8} className="p-4 text-center text-gray-500">Loading…</td></tr>
              )}
              {view !== null && rows.length === 0 && (
                <tr><td colSpan={8} className="p-4 text-center text-gray-500">No live agents.</td></tr>
              )}
              {rows.map((row) => (
                <LiveAgentRow
                  key={row.agentId}
                  row={row}
                  expanded={expanded.has(row.agentId)}
                  onToggle={() => toggleExpanded(row.agentId)}
                  verdict={
                    sweepVerdicts === null
                      ? null
                      : sweepVerdicts.eligible.has(row.agentId)
                        ? { kind: 'eligible' as const }
                        : sweepVerdicts.excluded.has(row.agentId)
                          ? { kind: 'excluded' as const, codes: sweepVerdicts.excluded.get(row.agentId)! }
                          : { kind: 'other' as const }
                  }
                />
              ))}
            </tbody>
          </table>
        </div>

        {preview && !previewStale && grouped.length > 0 && (
          <div className="border-t border-white/5 pt-2 space-y-2">
            <div className="text-[11px] text-gray-500">
              {preview.excluded.length} agent{preview.excluded.length === 1 ? '' : 's'} left
              running:
            </div>
            {grouped.map((g) => (
              <div key={g.code} className="text-[11px]">
                <div className="text-gray-300">
                  {g.copy.label}
                  <span className="text-gray-600"> — {g.copy.explanation}</span>
                </div>
                <div className="text-gray-500 pl-3 truncate">
                  {g.agentIds.map(titleOf).join(', ')}
                </div>
              </div>
            ))}
          </div>
        )}

        {result && tally && (
          <div className="border-t border-white/5 pt-2 space-y-1" role="status">
            <div className="text-[12px] text-gray-300">
              Stopped {tally.stopped}
              {tally.skipped > 0 && <>, skipped {tally.skipped}</>}
              {tally.not_found > 0 && <>, already gone {tally.not_found}</>}
              {tally.failed > 0 && (
                <span className="text-accent-red">, failed {tally.failed}</span>
              )}
            </div>
            {/* Every non-stopped item is named. A failure is a live process we
                could not confirm we killed — it must never read as success. */}
            {result.items
              .filter((i) => i.result !== 'stopped')
              .map((i) => (
                <div key={i.agentId} className="text-[11px] pl-1">
                  <span className={i.result === 'failed' ? 'text-accent-red' : 'text-gray-500'}>
                    {titleOf(i.agentId)} — {i.result === 'failed'
                      ? 'could not be confirmed stopped; it may still be running'
                      : summarizeStopExclusions(i.codes) ?? i.result.replace('_', ' ')}
                  </span>
                </div>
              ))}
          </div>
        )}

        {/* Prior-run trees stay VISIBLE in a memory view; the orphan sweep is
            where they get reclaimed. */}
        {view !== null && view.unregisteredTrees.length > 0 && (
          <div className="border-t border-white/5 pt-2 text-[11px] text-gray-500">
            {view.unregisteredTrees.length} process tree{view.unregisteredTrees.length === 1 ? '' : 's'} from
            prior runs holding {formatBytes(unregisteredSum)} — use the Orphaned-processes sweep below.
          </div>
        )}
      </div>
    </section>
  );
}

type SweepVerdict =
  | { kind: 'eligible' }
  | { kind: 'excluded'; codes: Parameters<typeof summarizeStopExclusions>[0] }
  | { kind: 'other' }
  | null; // null ⇒ no current preview: no badges at all

function LiveAgentRow({
  row,
  expanded,
  onToggle,
  verdict,
}: {
  row: LiveAgentMemoryRowDto;
  expanded: boolean;
  onToggle: () => void;
  verdict: SweepVerdict;
}) {
  const detailRowId = `live-agent-detail-${row.agentId}`;
  const unattributableTitle = 'unattributable (WSL / no resolved tree)';
  const idleMs = row.idleSince != null ? parseIdleSince(row.idleSince) : null;

  return (
    <>
      <tr
        className={`border-t border-white/5 ${verdict?.kind === 'eligible' ? 'bg-accent-red/5' : ''}`}
        onClick={onToggle}
      >
        <td className="px-2 py-1.5">
          <span className="flex items-center gap-1.5 min-w-0">
            {/* The button is the accessible control; the row click is a bonus. */}
            <button
              aria-expanded={expanded}
              aria-controls={detailRowId}
              aria-label={`Details for ${row.title}`}
              className="p-0.5 text-gray-500 hover:text-gray-300 shrink-0"
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
            >
              {expanded
                ? <Icons.ChevronDown className="w-3.5 h-3.5" />
                : <Icons.ChevronRight className="w-3.5 h-3.5" />}
            </button>
            <span className="text-gray-200 truncate max-w-[200px]" title={row.agentId}>{row.title}</span>
          </span>
        </td>
        <td className="px-2 py-1.5 text-gray-400">{row.status}</td>
        <td className="px-2 py-1.5 text-gray-400">{row.transport ?? '—'}</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-gray-300">
          {row.workingSetBytes != null
            ? formatBytes(row.workingSetBytes)
            : <span title={unattributableTitle}>—</span>}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">
          {row.commitBytes != null
            ? `${row.commitComplete ? '' : '≥'}${formatBytes(row.commitBytes)}`
            : <span title={unattributableTitle}>—</span>}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">{row.pidCount}</td>
        <td className="px-2 py-1.5 text-gray-500">{row.source ?? '—'}</td>
        <td className="px-2 py-1.5">
          {verdict !== null && (
            verdict.kind === 'eligible' ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded text-accent-red bg-accent-red/10">
                would stop
              </span>
            ) : verdict.kind === 'excluded' ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded text-gray-400 bg-white/5">
                {summarizeStopExclusions(verdict.codes) ?? 'excluded'}
              </span>
            ) : (
              <span className="text-[10px] text-gray-600">
                {row.status === 'idle' ? 'below threshold' : 'active'}
              </span>
            )
          )}
        </td>
      </tr>
      {expanded && (
        <tr id={detailRowId} className="border-t border-white/5 bg-white/[0.02]">
          <td colSpan={8} className="px-4 py-2 text-[11px] text-gray-400 space-y-1">
            <div>
              <span className="text-gray-600">Status: </span>{row.status}
            </div>
            <div>
              <span className="text-gray-600">Last active: </span>
              {idleMs != null
                ? <>idle {idleFor(row.idleSince!)} · since {new Date(idleMs).toLocaleString()}</>
                : row.status !== 'idle'
                  ? 'Currently active'
                  : 'Last-active time unavailable'}
            </div>
            <div>
              <span className="text-gray-600">Agent id: </span>
              <span className="font-mono text-gray-500">{row.agentId}</span>
            </div>
            <div>
              <span className="text-gray-600">Attribution: </span>
              source {row.source ?? 'none (no ownership row yet)'} · {row.pidCount} proc{row.pidCount === 1 ? '' : 's'}
              {(row.transport === 'wsl' || row.source === 'none' || row.source === null) && (
                <span className="text-gray-600">
                  {' '}— per-process memory cannot be attributed for this agent
                  {row.transport === 'wsl' ? ' (WSL processes have no Win32 PID)' : ''};
                  its usage is counted in the system remainder.
                </span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
