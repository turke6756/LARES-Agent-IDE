import React, { useEffect, useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore, type HistoryEntry } from '../../stores/browser-store';
import { useBrowserSuspension } from './useBrowserSuspension';

// ── History view (WP4-HIST-UI) ───────────────────────────────────────────────
// A full-pane overlay shown when historyViewOpen. Searchable + date-grouped.
// Rows open via navigate/createTab → M6. History is user-partition only by
// construction (the main store records visits under `if partition === 'user'`),
// so no partition gate is needed here.
//
// Because a WebContentsView paints above renderer DOM, this overlay suspends the
// pane (useBrowserSuspension) for its lifetime — only the inner component (which
// mounts solely while open) calls the hook, so the pane is restored on close.

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function rowInitial(title: string, url: string): string {
  const source = (title.trim() || hostLabel(url)).replace(/^https?:\/\//, '').trim();
  return (source[0] ?? '?').toUpperCase();
}

/** Bucket label for a visit timestamp: Today / Yesterday / locale date. */
function dayGroup(visitedAt: number): string {
  const d = new Date(visitedAt);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayMs = 86_400_000;
  const diff = Math.round((startOf(now) - startOf(d)) / dayMs);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function timeLabel(visitedAt: number): string {
  return new Date(visitedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function HistoryViewInner() {
  useBrowserSuspension();

  const closeHistory = useBrowserStore((s) => s.closeHistory);
  const fetchHistory = useBrowserStore((s) => s.fetchHistory);
  const deleteHistory = useBrowserStore((s) => s.deleteHistory);
  const clearHistory = useBrowserStore((s) => s.clearHistory);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const navigate = useBrowserStore((s) => s.navigate);
  const createTab = useBrowserStore((s) => s.createTab);

  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  // Re-fetch on query change (the main store does the LIKE filtering).
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      void (async () => {
        const rows = await fetchHistory(query.trim() || undefined);
        if (live) setEntries(rows);
      })();
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, fetchHistory]);

  // Close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeHistory();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeHistory]);

  const groups = useMemo(() => {
    const map = new Map<string, HistoryEntry[]>();
    for (const e of entries) {
      const key = dayGroup(e.visitedAt);
      const arr = map.get(key);
      if (arr) arr.push(e);
      else map.set(key, [e]);
    }
    return Array.from(map.entries());
  }, [entries]);

  const open = (url: string) => {
    if (activeTabId) navigate(activeTabId, url);
    else void createTab('user', url);
    closeHistory();
  };

  const onDelete = (id: string) => {
    deleteHistory(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const onClearAll = () => {
    clearHistory();
    setEntries([]);
  };

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[var(--color-surface-0)] text-fg-primary">
      {/* Header: title + search + clear-all + close. */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-browser-divider)] shrink-0">
        <div className="flex items-center gap-2 text-fg-primary">
          <Icons.History className="w-5 h-5" />
          <span className="text-[14px] font-semibold">History</span>
        </div>
        <div className="flex-1 flex items-center gap-2 rounded-full px-3 py-1.5 bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] max-w-md">
          <Icons.Search className="w-3.5 h-3.5 text-fg-secondary shrink-0" />
          <input
            type="text"
            value={query}
            spellCheck={false}
            placeholder="Search history"
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 min-w-0 bg-transparent text-[12px] text-fg-primary placeholder-fg-muted focus:outline-none"
          />
        </div>
        <button onClick={onClearAll} className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] text-accent-red">
          Clear all
        </button>
        <button onClick={closeHistory} className="ui-btn ui-btn-ghost p-1.5" title="Close history">
          <Icons.X className="w-4 h-4" />
        </button>
      </div>

      {/* Body: date-grouped rows. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-fg-muted gap-2">
            <Icons.History className="w-8 h-8 opacity-40" />
            <span className="text-[12px]">{query.trim() ? 'No matching history.' : 'No history yet.'}</span>
          </div>
        ) : (
          groups.map(([label, rows]) => (
            <section key={label} className="mb-4">
              <div className="text-[10px] uppercase tracking-wide font-semibold text-fg-secondary mb-1 px-1 sticky top-0 bg-[var(--color-surface-0)] py-1">
                {label}
              </div>
              <div className="flex flex-col">
                {rows.map((e) => (
                  <div
                    key={e.id}
                    className="group flex items-center gap-3 px-2 py-1.5 rounded hover:bg-[var(--color-tab-hover-bg)] transition-colors"
                  >
                    <span className="w-6 h-6 rounded-sm flex items-center justify-center text-[10px] font-bold bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] text-fg-secondary shrink-0">
                      {rowInitial(e.title, e.url)}
                    </span>
                    <button
                      onClick={() => open(e.url)}
                      title={e.url}
                      className="flex-1 min-w-0 flex flex-col items-start text-left"
                    >
                      <span className="text-[12px] text-fg-primary truncate max-w-full">
                        {e.title || hostLabel(e.url)}
                      </span>
                      <span className="text-[10px] text-fg-muted truncate max-w-full">{e.url}</span>
                    </button>
                    <span className="text-[10px] text-fg-muted shrink-0 tabular-nums">{timeLabel(e.visitedAt)}</span>
                    <button
                      onClick={() => onDelete(e.id)}
                      className="ui-btn ui-btn-ghost p-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      title="Remove from history"
                    >
                      <Icons.X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

export default function HistoryView() {
  const historyViewOpen = useBrowserStore((s) => s.historyViewOpen);
  if (!historyViewOpen) return null;
  return <HistoryViewInner />;
}
