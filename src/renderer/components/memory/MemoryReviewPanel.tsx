// MemoryReviewPanel — WP-H1 detail view for the memory review queue.
//
// Presentational only: it renders the summary DTO the banner already fetched
// (pending findings + the persisted hard-invalid / runtime state from WP-C).
// No IPC of its own — the banner owns the fetch, this owns the display — so it
// is trivially testable against a fixed DTO.

import React from 'react';
import * as Icons from 'lucide-react';
import type { MemoryReviewItemDto, MemoryReviewSummaryDto } from '../../../shared/types';

/** Human labels for the opaque WP-B finding kinds. Unknown kinds fall back to
 *  the raw kind string so a new class still renders honestly, never blank. */
const KIND_LABEL: Record<string, string> = {
  'hard-invalid': 'Index invalid',
  'cap-pressure': 'Near size cap',
  'stale-active': 'Stale active entry',
  'condition-review': 'Condition to re-check',
  'never-recalled': 'Never recalled',
  'never-fired': 'Lesson never fired',
  'evidence-unavailable': 'Firing evidence unavailable',
};

function labelFor(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export default function MemoryReviewPanel({ summary }: { summary: MemoryReviewSummaryDto }) {
  const { items, hardInvalid, lastRuntimeError, lastRuntimeErrorAt } = summary;

  return (
    <div className="space-y-2" data-testid="memory-review-panel">
      {/* Persisted invalid / runtime state from WP-C — the loudest signals. */}
      {hardInvalid && (
        <div className="text-[11px] text-accent-red flex items-start gap-1.5" role="alert">
          <Icons.AlertOctagon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            The live memory index failed validation at the last supervisor launch. The
            last-known-good copy was used instead — fix the index and relaunch.
          </span>
        </div>
      )}
      {lastRuntimeError && (
        <div className="text-[11px] text-accent-red flex items-start gap-1.5" role="alert">
          <Icons.AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Last read/parse error{lastRuntimeErrorAt ? ` (${lastRuntimeErrorAt})` : ''}:{' '}
            <span className="font-mono text-gray-400">{lastRuntimeError}</span>
          </span>
        </div>
      )}

      {items.length === 0 ? (
        <div className="text-[11px] text-gray-500">No entries pending review.</div>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => (
            <ReviewItemRow key={it.findingId} item={it} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewItemRow({ item }: { item: MemoryReviewItemDto }) {
  return (
    <li className="text-[11px] border-t border-white/5 pt-1" data-testid="memory-review-item">
      <div className="flex items-center gap-2">
        <span className="text-gray-300 font-medium">{labelFor(item.kind)}</span>
        {item.entryId && (
          <span className="font-mono text-gray-500 truncate max-w-[220px]" title={item.entryId}>
            {item.entryId}
          </span>
        )}
      </div>
      {item.reason && <div className="text-gray-500 pl-0.5">{item.reason}</div>}
      {item.exitCondition && (
        <div className="text-gray-400 pl-0.5">
          <span className="text-gray-600">Re-check: </span>
          {item.exitCondition}
        </div>
      )}
    </li>
  );
}
