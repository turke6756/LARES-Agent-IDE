import React, { useEffect, useRef } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore } from '../../stores/browser-store';

// ── Find-in-page bar (Slice 15 — stateful, per-tab) ──────────────────────────
// A slim bar mounted ABOVE the host (no WebContentsView paint-over hazard, so no
// suspension needed). The input value is the ACTIVE TAB's stored query, so
// switching tabs restores what was typed there; the counter reflects the
// per-tab onFoundInPage counts (which self-restore on switch — main re-runs the
// active query). Typing → runFind (fresh search, debounced); Enter = next,
// Shift+Enter = prev (both immediate, using main's stored query); the Aa toggle
// re-issues with matchCase; Esc / ✕ = stopFind + hide. Render only when findOpen.

export default function FindBar() {
  const findOpen = useBrowserStore((s) => s.findOpen);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const query = useBrowserStore((s) => (s.activeTabId ? s.findQueries[s.activeTabId] ?? '' : ''));
  const matchCase = useBrowserStore((s) =>
    s.activeTabId ? s.findMatchCase[s.activeTabId] ?? false : false,
  );
  const findState = useBrowserStore((s) =>
    s.activeTabId ? s.findStates[s.activeTabId] : undefined,
  );
  const runFind = useBrowserStore((s) => s.runFind);
  const findNext = useBrowserStore((s) => s.findNext);
  const findPrev = useBrowserStore((s) => s.findPrev);
  const setFindMatchCase = useBrowserStore((s) => s.setFindMatchCase);
  const closeFind = useBrowserStore((s) => s.closeFind);

  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus + select the field each time the bar opens or the active tab changes
  // (a tab switch swaps in that tab's stored query).
  useEffect(() => {
    if (findOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [findOpen, activeTabId]);

  if (!findOpen) return null;

  const { activeMatchOrdinal, matches } = findState ?? { activeMatchOrdinal: 0, matches: 0 };
  const hasQuery = query.trim() !== '';
  const noResults = hasQuery && matches === 0;
  const counter = !hasQuery ? '' : noResults ? 'No results' : `${activeMatchOrdinal} of ${matches}`;

  return (
    <div className="browser-toolbar shrink-0 justify-end">
      <div
        className={`flex items-center gap-1 rounded px-2 py-1 bg-[var(--color-browser-chrome-2)] border ${
          noResults ? 'border-accent-red' : 'border-[var(--color-browser-divider)]'
        }`}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          spellCheck={false}
          placeholder="Find in page"
          aria-label="Find in page"
          onChange={(e) => runFind(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) findPrev();
              else findNext();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeFind();
            }
          }}
          className={`w-48 min-w-0 bg-transparent text-[12px] placeholder-fg-muted focus:outline-none ${
            noResults ? 'text-accent-red' : 'text-fg-primary'
          }`}
        />
        <span
          aria-live="polite"
          className={`text-[11px] tabular-nums min-w-[64px] text-right select-none ${
            noResults ? 'text-accent-red' : 'text-fg-muted'
          }`}
        >
          {counter}
        </span>
      </div>
      <button
        onClick={() => setFindMatchCase(!matchCase)}
        aria-pressed={matchCase}
        className={`ui-btn ui-btn-ghost px-1.5 py-1 text-[12px] font-medium ${
          matchCase ? 'text-accent-blue bg-[var(--color-tab-active-bg)]' : ''
        }`}
        title="Match case"
      >
        Aa
      </button>
      <button
        onClick={findPrev}
        disabled={matches === 0}
        className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
        title="Previous match (Shift+Enter)"
      >
        <Icons.ChevronUp className="w-4 h-4" />
      </button>
      <button
        onClick={findNext}
        disabled={matches === 0}
        className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
        title="Next match (Enter)"
      >
        <Icons.ChevronDown className="w-4 h-4" />
      </button>
      <button onClick={closeFind} className="ui-btn ui-btn-ghost p-1.5" title="Close (Esc)">
        <Icons.X className="w-4 h-4" />
      </button>
    </div>
  );
}
