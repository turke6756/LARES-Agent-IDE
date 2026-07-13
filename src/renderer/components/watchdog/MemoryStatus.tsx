// Memory-watchdog status strip (incident-2026-07-11 §5 D5 UI, Wave 4b).
//
// A slim always-visible commit meter that lives just under the top chrome, plus a
// pressure banner that unfolds at the Warn (≥75%) / Critical bands. Reads the D5
// sampler snapshot via `window.api.memory` — an initial `getSnapshot` pull plus a
// live `onPressure` subscription (pushed on every 15 s sampler tick). The banner's
// "Free memory…" action opens the orphan-sweep panel (D4). Purely a consumer of
// the trusted main-process snapshot; it enforces nothing itself.

import React, { useEffect, useState } from 'react';
import * as Icons from 'lucide-react';
import type { MemorySnapshotDto } from '../../../shared/types';
import { formatBytes, formatMinutesToLimit } from './format';
import OrphanSweepPanel from './OrphanSweepPanel';

const BAND = {
  normal: { bar: 'bg-accent-green', text: 'text-accent-green', label: 'Memory' },
  warn: { bar: 'bg-accent-yellow', text: 'text-accent-yellow', label: 'Memory pressure' },
  critical: { bar: 'bg-accent-red', text: 'text-accent-red', label: 'Critical memory pressure' },
} as const;

export default function MemoryStatus() {
  const [snap, setSnap] = useState<MemorySnapshotDto | null>(null);
  const [showSweep, setShowSweep] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    window.api.memory.getSnapshot().then((s) => { if (live) setSnap(s); }).catch(() => {});
    const unsub = window.api.memory.onPressure((s) => {
      setSnap(s);
      setDismissed(false); // a fresh pressure tick re-surfaces a dismissed banner
    });
    return () => { live = false; unsub(); };
  }, []);

  if (!snap) return null;

  const level = snap.level;
  const band = BAND[level];
  const unknown = !snap.commitKnown;
  const pct = snap.commitPercent ?? 0;
  const pressured = level !== 'normal';
  const showBanner = pressured && !dismissed;

  return (
    <div className="shrink-0 app-no-drag">
      {/* Slim always-on commit meter. */}
      <div className="flex items-center gap-2 px-3 h-[18px] bg-surface-0 border-b border-white/5 text-[10px]">
        <Icons.Cpu className={`w-3 h-3 ${unknown ? 'text-gray-500' : band.text}`} />
        <div className="relative h-[4px] flex-1 max-w-[220px] rounded-full bg-white/10 overflow-hidden">
          {!unknown && (
            <div
              className={`absolute inset-y-0 left-0 ${band.bar} transition-[width] duration-500`}
              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            />
          )}
        </div>
        <span className={`tabular-nums ${unknown ? 'text-gray-500' : band.text}`}>
          {unknown ? 'commit unknown' : `${Math.round(pct)}%`}
        </span>
        <span className="text-gray-600">
          {snap.liveAgentCount} agents · {formatBytes(snap.appMemoryBytes)}
          {snap.staticCapsOnly ? ' · static caps' : ''}
        </span>
        <button
          onClick={() => setShowSweep(true)}
          className="ml-auto text-gray-500 hover:text-gray-200"
          title="Orphaned agent processes"
        >
          <Icons.Recycle className="w-3 h-3" />
        </button>
      </div>

      {/* Pressure banner — Warn (≥75%) and Critical. */}
      {showBanner && (
        <div
          className={`flex items-center gap-3 px-3 py-1.5 text-[12px] border-b border-white/10 ${
            level === 'critical' ? 'bg-accent-red/10' : 'bg-accent-yellow/10'
          }`}
        >
          <Icons.AlertTriangle className={`w-4 h-4 shrink-0 ${band.text}`} />
          <span className={`font-medium ${band.text}`}>{band.label}</span>
          <span className="text-gray-400 min-w-0 truncate">
            Commit at {Math.round(pct)}% of limit
            {snap.projectedMinutesToLimit != null
              ? ` · ${formatMinutesToLimit(snap.projectedMinutesToLimit)}`
              : ''}
            {level === 'critical'
              ? ' — new agent launches and tabs are being refused.'
              : ' — consider reaping idle or finished agents.'}
          </span>
          <button
            onClick={() => setShowSweep(true)}
            className="ml-auto ui-btn px-2.5 py-1 text-[11px] shrink-0"
          >
            Free memory…
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="text-gray-500 hover:text-gray-200 shrink-0"
            aria-label="Dismiss"
          >
            <Icons.X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {showSweep && <OrphanSweepPanel onClose={() => setShowSweep(false)} />}
    </div>
  );
}
