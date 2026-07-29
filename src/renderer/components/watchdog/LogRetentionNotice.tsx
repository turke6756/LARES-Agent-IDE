// Terminal-log retention first-sweep banner (WP-8).
//
// App-chrome, NOT a per-terminal overlay: the first time the background sweep
// clears a real backlog (bytes > 0), a durable, dismissible banner surfaces
// WHAT actually happened — the real agent count and real bytes reclaimed, read
// verbatim from the create-once `firstSweepNotice` (never a plan/estimate).
//
// Pull + push: an initial `getState()` means a renderer that mounted AFTER the
// sweep completed still sees the notice; the `onStateChanged` subscription keeps
// an already-mounted renderer live. It shows only while
// `firstSweepNotice && !acknowledgedAt`; dismissing calls `acknowledgeNotice`,
// which persists the acknowledgement main-side and rebroadcasts so a second
// window's banner clears too.

import React, { useEffect, useState } from 'react';
import * as Icons from 'lucide-react';
import type { LogRetentionState } from '../../../shared/types';
import { formatBytes } from './format';

export default function LogRetentionNotice() {
  const [state, setState] = useState<LogRetentionState | null>(null);

  useEffect(() => {
    let live = true;
    // Pull first: covers the case where the sweep completed BEFORE this renderer
    // mounted (no push would ever arrive for it).
    window.api.logRetention
      .getState()
      .then((s) => { if (live) setState(s); })
      .catch(() => {});
    const unsub = window.api.logRetention.onStateChanged((s) => {
      if (live) setState(s);
    });
    return () => { live = false; unsub(); };
  }, []);

  const notice = state?.firstSweepNotice ?? null;
  if (!notice || notice.acknowledgedAt) return null;

  const dismiss = (): void => {
    window.api.logRetention
      .acknowledgeNotice()
      .then((s) => setState(s))
      .catch(() => {});
  };

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[125] app-no-drag">
      <div className="w-[420px] max-w-[90vw] rounded-lg border border-accent-blue/50 bg-accent-blue/15 shadow-xl overflow-hidden">
        <div className="flex items-start gap-2.5 p-3">
          <Icons.Trash2 className="w-4 h-4 mt-0.5 shrink-0 text-accent-blue" />
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-semibold text-accent-blue">
              Terminal history reclaimed
            </div>
            <div className="text-[11px] text-gray-300 mt-0.5">
              Freed {formatBytes(notice.bytes)} of terminal-log disk space across{' '}
              {notice.agents} finished {notice.agents === 1 ? 'agent' : 'agents'} to keep Lares
              under its storage cap. Live agents were never touched.
            </div>
          </div>
          <button
            onClick={dismiss}
            className="text-gray-400 hover:text-gray-100 shrink-0"
            aria-label="Dismiss"
          >
            <Icons.X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
