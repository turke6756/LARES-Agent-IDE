// MemoryWarningBanner — WP-H1 workspace-level memory signal.
//
// The ONE ambient signal the proposal (§6) specifies:
//   "Memory index: N entries pending review, cap at P%"
// — the same warning family as the memory-pressure pop-up. It surfaces only
// when there is something to act on (pending review items, a persisted
// hard-invalid index, or a persisted runtime error from WP-C); otherwise it
// renders nothing. "Details" expands the MemoryReviewPanel inline; the fetch is
// owned here (renderer-only IPC via useMemoryReview), the display by the panel.
//
// Dismissal latches for the session only — a reload re-pulls WP-C's persisted
// state, so a fixed index re-quiets the banner on its own after a relaunch.

import React, { useState } from 'react';
import * as Icons from 'lucide-react';
import { useMemoryReview } from '../../hooks/useMemoryReview';
import MemoryReviewPanel from './MemoryReviewPanel';

export default function MemoryWarningBanner({ workspaceId }: { workspaceId: string | null }) {
  const { summary, reload } = useMemoryReview(workspaceId);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (!summary) return null;
  const { pendingCount, capPercent, hardInvalid, lastRuntimeError } = summary;
  const hasSignal = pendingCount > 0 || hardInvalid || lastRuntimeError != null;
  if (!hasSignal || dismissed) return null;

  // Hard-invalid or a runtime error is a red (blocking) condition; a queue of
  // advisory review items alone is a softer yellow.
  const severe = hardInvalid || lastRuntimeError != null;

  const headline =
    pendingCount > 0
      ? `Memory index: ${pendingCount} ${pendingCount === 1 ? 'entry' : 'entries'} pending review${
          capPercent != null ? `, cap at ${capPercent}%` : ''
        }`
      : hardInvalid
        ? 'Memory index invalid — using the last-known-good copy'
        : 'Memory index: last read/parse failed';

  return (
    <div className="fixed bottom-4 left-4 z-[120] app-no-drag" data-testid="memory-warning-banner">
      <div
        className={`w-[320px] rounded-lg border shadow-xl overflow-hidden ${
          severe
            ? 'bg-accent-red/15 border-accent-red/60'
            : 'bg-accent-yellow/15 border-accent-yellow/50'
        }`}
      >
        <div className="flex items-start gap-2.5 p-3">
          <Icons.NotebookText
            className={`w-4 h-4 mt-0.5 shrink-0 ${severe ? 'text-accent-red' : 'text-accent-yellow'}`}
          />
          <div className="flex-1 min-w-0">
            <div className={`text-[12px] font-semibold ${severe ? 'text-accent-red' : 'text-accent-yellow'}`}>
              {headline}
            </div>
            <div className="text-[11px] text-gray-300 mt-0.5">
              Dispatch a janitor agent to work the queue, or review the flagged entries.
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

        {expanded && (
          <div className="px-3 pb-2.5 border-t border-white/10 pt-2 max-h-[240px] overflow-y-auto">
            <MemoryReviewPanel summary={summary} />
          </div>
        )}

        <div className="flex justify-end gap-2 px-3 pb-2.5">
          <button
            onClick={() => reload()}
            className="ui-btn px-2.5 py-1 text-[11px]"
            title="Re-read the persisted review state"
          >
            Refresh
          </button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="ui-btn px-2.5 py-1 text-[11px]"
            aria-expanded={expanded}
          >
            {expanded ? 'Hide details' : 'Details'}
          </button>
        </div>
      </div>
    </div>
  );
}
