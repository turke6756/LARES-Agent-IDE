import React, { useEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore } from '../../stores/browser-store';

// ── Find-in-page bar (WP5-FIND-ZOOM-UI) ──────────────────────────────────────
// A slim bar mounted ABOVE the host (no WebContentsView paint-over hazard, so no
// suspension needed). Debounced runFind drives native wc.findInPage in main; the
// match counter reflects the counts-only foundInPage event (never page text).
// Enter = next, Shift+Enter = prev, Esc = close (+ stopFindInPage). Render only
// when findOpen.

export default function FindBar() {
  const findOpen = useBrowserStore((s) => s.findOpen);
  const findState = useBrowserStore((s) => s.findState);
  const runFind = useBrowserStore((s) => s.runFind);
  const closeFind = useBrowserStore((s) => s.closeFind);

  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus + select the field each time the bar opens.
  useEffect(() => {
    if (findOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      setText('');
    }
  }, [findOpen]);

  if (!findOpen) return null;

  const { activeMatchOrdinal, matches } = findState;
  const counter = text.trim() ? `${matches > 0 ? activeMatchOrdinal : 0}/${matches}` : '';

  const onChange = (next: string) => {
    setText(next);
    runFind(next);
  };

  const next = () => runFind(text, { forward: true, findNext: true });
  const prev = () => runFind(text, { forward: false, findNext: true });

  return (
    <div className="browser-toolbar shrink-0 justify-end">
      <div className="flex items-center gap-1 rounded px-2 py-1 bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)]">
        <input
          ref={inputRef}
          type="text"
          value={text}
          spellCheck={false}
          placeholder="Find in page"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) prev();
              else next();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeFind();
            }
          }}
          className="w-48 min-w-0 bg-transparent text-[12px] text-fg-primary placeholder-fg-muted focus:outline-none"
        />
        <span className="text-[11px] text-fg-muted tabular-nums min-w-[40px] text-right select-none">
          {counter}
        </span>
      </div>
      <button
        onClick={prev}
        disabled={matches === 0}
        className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
        title="Previous match (Shift+Enter)"
      >
        <Icons.ChevronUp className="w-4 h-4" />
      </button>
      <button
        onClick={next}
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
