// System Memory tool view (incident-2026-07-11 §5 Wave 5).
//
// Opened as a tab from the Tools ▸ "System Memory" menu (not ambient chrome —
// the always-on meter was removed). A consumer of the trusted main-process
// watchdog snapshot + attribution; it enforces nothing itself. Sections:
//   • current commit-memory usage, with the Warn (75%) / Critical (88%) bands
//     drawn on the meter;
//   • a short in-view usage history (a small ring buffer of poll samples — no
//     new persistence, discarded when the tab closes);
//   • per-agent memory attribution (memory:attribution);
//   • orphaned-process sweep (the existing D4 OrphanSweepPanel, opened here);
//   • detached-process transparency (Wave 5 registry).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { MemorySnapshotDto, SystemMemoryViewDto, CommitBreakdownDto, CommitCategoryDto } from '../../../shared/types';
import { formatBytes, formatMinutesToLimit } from './format';
import OrphanSweepPanel from './OrphanSweepPanel';
import DetachedProcessesPanel from './DetachedProcessesPanel';
import LiveAgentsPanel from './LiveAgentsPanel';

const WARN_PCT = 75;
const CRITICAL_PCT = 88;
const HISTORY_CAP = 90; // ring-buffer length (≈ a few minutes at 4 s cadence)
const POLL_MS = 4_000;

const BAND = {
  normal: { bar: 'bg-accent-green', text: 'text-accent-green', ring: 'stroke-accent-green' },
  warn: { bar: 'bg-accent-yellow', text: 'text-accent-yellow', ring: 'stroke-accent-yellow' },
  critical: { bar: 'bg-accent-red', text: 'text-accent-red', ring: 'stroke-accent-red' },
} as const;

interface HistPoint { at: number; pct: number; level: MemorySnapshotDto['level']; }

export default function SystemMemoryView() {
  const workspaceRoot = useDashboardStore(
    (s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.path,
  );
  const [snap, setSnap] = useState<MemorySnapshotDto | null>(null);
  const [view, setView] = useState<SystemMemoryViewDto | null>(null);
  const [showSweep, setShowSweep] = useState(false);
  const history = useRef<HistPoint[]>([]);
  const [, forceTick] = useState(0);

  // Poll the sampler snapshot + attribution; also ride live pressure pushes.
  useEffect(() => {
    let live = true;
    const push = (s: MemorySnapshotDto) => {
      if (!live) return;
      setSnap(s);
      if (s.commitKnown && s.commitPercent != null) {
        const buf = history.current;
        buf.push({ at: s.at || Date.now(), pct: s.commitPercent, level: s.level });
        if (buf.length > HISTORY_CAP) buf.splice(0, buf.length - HISTORY_CAP);
      }
      forceTick((n) => n + 1);
    };
    const poll = () => {
      window.api.memory.getSnapshot().then((s) => { if (s) push(s); }).catch(() => {});
      window.api.memory.getSystemView().then((v) => { if (live) setView(v); }).catch(() => {});
    };
    poll();
    const id = window.setInterval(poll, POLL_MS);
    const unsub = window.api.memory.onPressure((s) => push(s));
    return () => { live = false; window.clearInterval(id); unsub(); };
  }, []);

  // Immediate refresh after a sweep stop — the 4 s poll remains as eventual
  // recovery if this pull races the kill.
  const refetchView = useCallback(() => {
    window.api.memory.getSystemView().then((v) => { if (v) setView(v); }).catch(() => {});
  }, []);

  const level = snap?.level ?? 'normal';
  const band = BAND[level];
  const unknown = !snap || !snap.commitKnown;
  const pct = snap?.commitPercent ?? 0;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin bg-surface-0">
      <div className="max-w-3xl mx-auto p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Icons.MemoryStick className="w-5 h-5 text-gray-300" />
          <h1 className="text-[16px] font-semibold text-gray-100">System Memory</h1>
          {snap?.staticCapsOnly && (
            <span className="text-[10px] px-1.5 py-0.5 rounded text-accent-yellow bg-accent-yellow/10">
              static caps
            </span>
          )}
        </div>

        {/* Current usage + threshold meter. */}
        <section className="ui-card p-4">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-[12px] text-gray-400">Commit charge</span>
            <span className={`text-[22px] font-semibold tabular-nums ${unknown ? 'text-gray-500' : band.text}`}>
              {unknown ? '—' : `${Math.round(pct)}%`}
            </span>
          </div>

          <ThresholdMeter pct={unknown ? 0 : pct} band={band} unknown={unknown} />

          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-[11px] text-gray-500">
            <Stat label="Committed"
              value={snap?.commitChargeBytes != null ? formatBytes(snap.commitChargeBytes) : '—'} />
            <Stat label="Commit limit"
              value={snap?.commitLimitBytes != null ? formatBytes(snap.commitLimitBytes) : '—'} />
            {/* appMemoryBytes is a WORKING SET — named as such so it is never
                conflated with the commit breakdown below. */}
            <Stat label="Electron working set" value={snap ? formatBytes(snap.appMemoryBytes) : '—'} />
            <span
              className="tabular-nums"
              title="Registered non-terminal agents (launching/working/idle/waiting/restarting)"
            >
              <span className="text-gray-600">Live agents: </span>
              {/* Prefer the composed DTO so this number equals the live-agent
                  table's row count by construction. */}
              <span className="text-gray-300">{view ? String(view.liveAgentCount) : snap ? String(snap.liveAgentCount) : '—'}</span>
            </span>
            <Stat label="Agent tabs" value={snap ? String(snap.agentViewCount) : '—'} />
            {snap?.projectedMinutesToLimit != null && (
              <Stat label="Projection" value={formatMinutesToLimit(snap.projectedMinutesToLimit)} />
            )}
          </div>

          {/* Commit-charge breakdown: App / live agents / other-system. Commit
              bytes ONLY — the working-set stats above never enter this bar. */}
          <CommitBreakdownBar breakdown={view?.breakdown ?? null} />
        </section>

        {/* In-view usage history sparkline. */}
        <section className="ui-card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] text-gray-400">Recent history</span>
            <span className="text-[10px] text-gray-600">last {history.current.length} samples</span>
          </div>
          <Sparkline points={history.current} />
        </section>

        {/* Live agents & memory (Part 5) — registry rows joined to attribution
            plus the §B8 stale-idle sweep, above the orphan sweep: an idle agent
            is a LIVE process we own, the orphan sweep deals with leftovers from
            prior runs. Different things, adjacent reclaim. */}
        <LiveAgentsPanel view={view} onAfterStop={refetchView} />

        {/* Orphaned-process sweep — reuse the D4 panel. */}
        <section className="ui-card p-4 flex items-center gap-3">
          <Icons.Recycle className="w-4 h-4 text-accent-orange shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-gray-100">Orphaned agent processes</div>
            <div className="text-[11px] text-gray-500">
              Leftover CLI process trees from prior app runs — verify and reclaim.
            </div>
          </div>
          <button onClick={() => setShowSweep(true)} className="ui-btn px-3 py-1.5 text-[12px] shrink-0">
            Sweep…
          </button>
        </section>

        {/* Detached-process transparency (Wave 5). */}
        <DetachedProcessesPanel workspaceRoot={workspaceRoot} />
      </div>

      {showSweep && <OrphanSweepPanel onClose={() => setShowSweep(false)} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="tabular-nums">
      <span className="text-gray-600">{label}: </span>
      <span className="text-gray-300">{value}</span>
    </span>
  );
}

/** ≥-qualified byte figure for a category legend: "≥1.2 GB" when the category
 *  is a known-incomplete sum, "—" when the category itself is unknown. */
function categoryFigure(cat: CommitCategoryDto | null): string {
  if (cat == null) return '—';
  return `${cat.complete ? '' : '≥'}${formatBytes(cat.bytes)}`;
}

/** Stacked commit-charge breakdown (System-Memory polish task 1).
 *
 *  Three renders, honest about what is known:
 *    - full data: exact stacked bar App / Live agents / Other-system;
 *    - partial attribution: known segments exact, remainder labeled
 *      "Other/system + unattributed" with NO percentage;
 *    - unknown total: no bar, legend-only "system total unknown" line.
 *  Unknown ≠ zero everywhere: "—" and "≥" qualifiers, never a false 0 B.
 *
 *  Exported for direct renderer tests (CommitBreakdownBar.test.tsx). */
export function CommitBreakdownBar({ breakdown }: { breakdown: CommitBreakdownDto | null }) {
  if (breakdown == null) {
    return <div className="mt-3 text-[11px] text-gray-600">attribution loading…</div>;
  }
  const { commitChargeBytes, electron, liveAgents, otherSystemBytes, unattributedLiveAgentCount, approximate } = breakdown;
  const approx = (s: string) => (approximate ? `≈${s}` : s);

  // Unknown total (staticCapsOnly / commit sampler failure): no bar, no
  // percentages — the known category sums only, "≥" when incomplete.
  if (commitChargeBytes == null) {
    return (
      <div className="mt-3 text-[11px] text-gray-500 tabular-nums">
        App {categoryFigure(electron)} · Live agents {categoryFigure(liveAgents)} · system total unknown
      </div>
    );
  }

  // Segment widths from RAW bytes (never rounded display values), clamped.
  const pctOf = (bytes: number) => Math.min(100, Math.max(0, (bytes / commitChargeBytes) * 100));
  const electronBytes = electron?.bytes ?? 0;
  const liveBytes = liveAgents?.bytes ?? 0;
  const exact = otherSystemBytes != null;
  const remainderBytes = exact
    ? otherSystemBytes
    : Math.max(0, commitChargeBytes - electronBytes - liveBytes);

  const segments = [
    { key: 'app', label: 'App (Electron)', cls: 'bg-accent-blue', bytes: electronBytes, cat: electron },
    { key: 'agents', label: 'Live agent CLIs', cls: 'bg-accent-purple', bytes: liveBytes, cat: liveAgents },
  ];

  return (
    <div className="mt-3">
      <div className="flex h-3 rounded-full bg-white/10 overflow-hidden">
        {segments.map((s) => (
          <div key={s.key} className={s.cls} style={{ width: `${pctOf(s.bytes)}%` }} />
        ))}
        <div className="bg-white/25" style={{ width: `${pctOf(remainderBytes)}%` }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[10px] text-gray-500 tabular-nums">
        {segments.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-sm ${s.cls} inline-block shrink-0`} />
            <span>
              {s.label}{' '}
              <span className="text-gray-400">
                {s.cat == null ? '—' : <>{approx(categoryFigure(s.cat))} · {approx(`${pctOf(s.bytes).toFixed(1)}%`)}</>}
              </span>
            </span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-white/25 inline-block shrink-0" />
          {exact ? (
            <span>
              Other/system{' '}
              <span className="text-gray-400">
                {approx(formatBytes(remainderBytes))} · {approx(`${pctOf(remainderBytes).toFixed(1)}%`)}
              </span>
            </span>
          ) : (
            // Partial attribution: the remainder contains unattributed agent
            // memory — no percentage, never presented as purely other processes.
            <span>Other/system + unattributed <span className="text-gray-400">{approx(formatBytes(remainderBytes))}</span></span>
          )}
        </span>
      </div>
      {!exact && (unattributedLiveAgentCount > 0 || electron == null) && (
        <div className="mt-1 text-[10px] text-gray-600">
          {unattributedLiveAgentCount > 0 && (
            <>
              {unattributedLiveAgentCount} live agent{unattributedLiveAgentCount === 1 ? '' : 's'} unattributable
              (e.g. WSL) — their memory is inside the remainder.
            </>
          )}
          {electron == null && (
            <>
              {unattributedLiveAgentCount > 0 ? ' ' : ''}App (Electron) share unknown — its memory is
              also inside the remainder.
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Horizontal commit meter with Warn (75%) / Critical (88%) marker lines. */
function ThresholdMeter({ pct, band, unknown }: { pct: number; band: typeof BAND[keyof typeof BAND]; unknown: boolean }) {
  return (
    <div>
      <div className="relative h-3 rounded-full bg-white/10 overflow-hidden">
        {!unknown && (
          <div
            className={`absolute inset-y-0 left-0 ${band.bar} transition-[width] duration-500`}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        )}
        {/* Threshold markers. */}
        <div className="absolute inset-y-0 w-px bg-accent-yellow/70" style={{ left: `${WARN_PCT}%` }} />
        <div className="absolute inset-y-0 w-px bg-accent-red/80" style={{ left: `${CRITICAL_PCT}%` }} />
      </div>
      <div className="relative h-4 mt-0.5 text-[9px] text-gray-500">
        <span className="absolute -translate-x-1/2" style={{ left: `${WARN_PCT}%` }}>warn 75%</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${CRITICAL_PCT}%` }}>critical 88%</span>
      </div>
    </div>
  );
}

/** Tiny inline SVG sparkline of the commit-% history with threshold guides. */
function Sparkline({ points }: { points: HistPoint[] }) {
  const W = 600;
  const H = 80;
  if (points.length < 2) {
    return <div className="h-20 flex items-center justify-center text-[11px] text-gray-600">Collecting samples…</div>;
  }
  const n = points.length;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - (Math.min(100, Math.max(0, v)) / 100) * H;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.pct).toFixed(1)}`).join(' ');
  const last = points[n - 1];
  const stroke = BAND[last.level].ring;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
      {/* Threshold guides. */}
      <line x1={0} x2={W} y1={y(WARN_PCT)} y2={y(WARN_PCT)} className="stroke-accent-yellow/40" strokeWidth={1} strokeDasharray="4 4" />
      <line x1={0} x2={W} y1={y(CRITICAL_PCT)} y2={y(CRITICAL_PCT)} className="stroke-accent-red/40" strokeWidth={1} strokeDasharray="4 4" />
      <path d={path} fill="none" className={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

