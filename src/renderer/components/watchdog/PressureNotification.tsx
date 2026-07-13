// Corner memory-pressure notification (incident-2026-07-11 §5 Wave 5).
//
// Replaces the always-on meter as the ONLY ambient memory surface: nothing shows
// until commit pressure crosses Warn (75%). Then a small pop-up appears in the
// bottom-right corner, pulses for attention, escalates its styling at Critical
// (88%), and does NOT auto-dismiss — the user must close it. Dismissal latches
// for the current pressure *episode*: once dismissed it stays hidden while
// pressure persists, but if pressure drops below Warn and later crosses again a
// new episode re-surfaces it. A rise in severity within an episode
// (Warn → Critical) also re-surfaces, since a worse state warrants re-attention.
//
// Drives off the same `memory:*` read surface the System Memory view uses — an
// initial getSnapshot pull plus the live onPressure subscription. "View details"
// opens the System Memory tool tab.

import React, { useEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { MemorySnapshotDto, WatchdogPressureLevel } from '../../../shared/types';
import { formatMinutesToLimit } from './format';

const RANK: Record<WatchdogPressureLevel, number> = { normal: 0, warn: 1, critical: 2 };

export default function PressureNotification() {
  const [snap, setSnap] = useState<MemorySnapshotDto | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const prevRank = useRef(0);
  const openToolTab = useDashboardStore((s) => s.openToolTab);

  useEffect(() => {
    let live = true;
    const apply = (s: MemorySnapshotDto) => {
      if (!live) return;
      const rank = RANK[s.level];
      // A rising edge (new episode 0→1, or escalation 1→2) re-surfaces the
      // pop-up; returning to normal ends the episode and clears the latch.
      if (rank > prevRank.current) setDismissed(false);
      else if (rank === 0) setDismissed(false);
      prevRank.current = rank;
      setSnap(s);
    };
    window.api.memory.getSnapshot().then((s) => { if (s) apply(s); }).catch(() => {});
    const unsub = window.api.memory.onPressure((s) => apply(s));
    return () => { live = false; unsub(); };
  }, []);

  const level = snap?.level ?? 'normal';
  const pressured = level === 'warn' || level === 'critical';
  if (!snap || !pressured || dismissed) return null;

  const critical = level === 'critical';
  const pct = snap.commitPercent != null ? Math.round(snap.commitPercent) : null;

  return (
    <div className="fixed bottom-4 right-4 z-[130] app-no-drag">
      <div
        className={`w-[300px] rounded-lg border shadow-xl overflow-hidden animate-pulse ${
          critical
            ? 'bg-accent-red/15 border-accent-red/60'
            : 'bg-accent-yellow/15 border-accent-yellow/50'
        }`}
      >
        <div className="flex items-start gap-2.5 p-3">
          <Icons.AlertTriangle
            className={`w-4 h-4 mt-0.5 shrink-0 ${critical ? 'text-accent-red' : 'text-accent-yellow'}`}
          />
          <div className="flex-1 min-w-0">
            <div className={`text-[12px] font-semibold ${critical ? 'text-accent-red' : 'text-accent-yellow'}`}>
              {critical ? 'Critical memory pressure' : 'Memory pressure'}
            </div>
            <div className="text-[11px] text-gray-300 mt-0.5">
              Commit at {pct != null ? `${pct}%` : 'high %'} of the limit
              {snap.projectedMinutesToLimit != null ? ` · ${formatMinutesToLimit(snap.projectedMinutesToLimit)}` : ''}.
              {critical
                ? ' New agent launches and tabs are being refused.'
                : ' Consider reaping idle or finished agents.'}
            </div>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="text-gray-400 hover:text-gray-100 shrink-0"
            aria-label="Dismiss"
          >
            <Icons.X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex justify-end px-3 pb-2.5">
          <button
            onClick={() => openToolTab('system-memory', 'System Memory')}
            className="ui-btn px-2.5 py-1 text-[11px]"
          >
            View details
          </button>
        </div>
      </div>
    </div>
  );
}
