import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore, type HistoryEntry } from '../../stores/browser-store';
import { useBrowserSuspension } from './useBrowserSuspension';

// ── History view (Slice-8 — history upgrade) ──────────────────────────────────
// A full-pane overlay shown when historyViewOpen. Searchable + date-grouped with
// sticky headers, relative "x ago" labels, favicons, infinite scroll pagination,
// row multi-select + delete-selected, a confirm-gated clear-all, and a per-row
// context menu (Reopen in new tab / Copy URL / Delete).
//
// Rows open via navigate/createTab → M6. History is user-partition only by
// construction (the main store records visits under `if partition === 'user'`),
// so no partition gate is needed here.
//
// Because a WebContentsView paints above renderer DOM, this overlay suspends the
// pane (useBrowserSuspension) for its lifetime — only the inner component (which
// mounts solely while open) calls the hook, so the pane is restored on close.

const PAGE_SIZE = 100;

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

/** Relative "x ago" label, falling back to a locale date past a week. */
function relativeTime(visitedAt: number): string {
  const diff = Date.now() - visitedAt;
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${Math.max(1, min)}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return new Date(visitedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A favicon with letter fallback (img errors → initial glyph). */
function RowIcon({ entry }: { entry: HistoryEntry }) {
  const [broken, setBroken] = useState(false);
  const initial = (
    <span className="w-6 h-6 rounded-sm flex items-center justify-center text-[10px] font-bold bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] text-fg-secondary shrink-0">
      {rowInitial(entry.title, entry.url)}
    </span>
  );
  if (!entry.favicon || broken) return initial;
  return (
    <img
      src={entry.favicon}
      alt=""
      onError={() => setBroken(true)}
      className="w-6 h-6 rounded-sm object-contain shrink-0 bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] p-0.5"
    />
  );
}

function SkeletonRows() {
  return (
    <div className="flex flex-col gap-1 px-4 py-2" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-1.5">
          <span className="w-6 h-6 rounded-sm bg-[var(--color-browser-chrome-2)] animate-pulse shrink-0" />
          <div className="flex-1 flex flex-col gap-1">
            <span className="h-3 w-1/3 rounded bg-[var(--color-browser-chrome-2)] animate-pulse" />
            <span className="h-2.5 w-1/2 rounded bg-[var(--color-browser-chrome-2)] animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface ContextMenuState {
  entry: HistoryEntry;
  x: number;
  y: number;
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
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Guards a fetch in flight so a scroll storm can't fire overlapping pages.
  const fetchingRef = useRef(false);
  const offsetRef = useRef(0);

  const loadPage = useCallback(
    async (reset: boolean) => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      setLoading(true);
      const offset = reset ? 0 : offsetRef.current;
      const rows = await fetchHistory({
        query: query.trim() || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      offsetRef.current = offset + rows.length;
      setHasMore(rows.length === PAGE_SIZE);
      setEntries((prev) => (reset ? rows : [...prev, ...rows]));
      setLoading(false);
      fetchingRef.current = false;
    },
    [fetchHistory, query],
  );

  // Re-fetch (page 0) on query change, debounced.
  useEffect(() => {
    let live = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      if (!live) return;
      offsetRef.current = 0;
      void loadPage(true);
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, loadPage]);

  // Infinite scroll: load the next page when near the bottom.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loading || !hasMore || fetchingRef.current) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
      void loadPage(false);
    }
  }, [loading, hasMore, loadPage]);

  // Esc: dismiss the context menu first, otherwise close the view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menu) setMenu(null);
      else closeHistory();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeHistory, menu]);

  // Close the context menu on any outside click.
  useEffect(() => {
    if (!menu) return;
    const onClick = () => setMenu(null);
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [menu]);

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

  const reopenInNewTab = (url: string) => {
    void createTab('user', url);
    setMenu(null);
    closeHistory();
  };

  const copyUrl = (url: string) => {
    try {
      void navigator.clipboard?.writeText(url);
    } catch {
      /* clipboard may be unavailable; best-effort */
    }
    setMenu(null);
  };

  const onDelete = (id: string) => {
    deleteHistory(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    offsetRef.current = Math.max(0, offsetRef.current - 1);
    setMenu(null);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteSelected = () => {
    const ids = selected;
    for (const id of ids) deleteHistory(id);
    setEntries((prev) => prev.filter((e) => !ids.has(e.id)));
    offsetRef.current = Math.max(0, offsetRef.current - ids.size);
    setSelected(new Set());
  };

  const onClearAll = () => {
    clearHistory();
    setEntries([]);
    setSelected(new Set());
    setHasMore(false);
    offsetRef.current = 0;
    setConfirmingClear(false);
  };

  const showInitialSkeleton = loading && entries.length === 0;

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[var(--color-surface-0)] text-fg-primary">
      {/* Header: title + search + bulk/clear actions + close. */}
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

        {selected.size > 0 && (
          <button
            onClick={deleteSelected}
            className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] text-accent-red"
          >
            Delete selected ({selected.size})
          </button>
        )}

        {confirmingClear ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-fg-secondary">Clear all history?</span>
            <button
              onClick={onClearAll}
              className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] text-accent-red font-semibold"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmingClear(false)}
              className="ui-btn ui-btn-ghost px-2 py-1 text-[11px]"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingClear(true)}
            className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] text-accent-red"
          >
            Clear all
          </button>
        )}

        <button onClick={closeHistory} className="ui-btn ui-btn-ghost p-1.5" title="Close history">
          <Icons.X className="w-4 h-4" />
        </button>
      </div>

      {/* Body: date-grouped rows with sticky headers + infinite scroll. */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto">
        {showInitialSkeleton ? (
          <SkeletonRows />
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-fg-muted gap-2">
            <Icons.History className="w-8 h-8 opacity-40" />
            <span className="text-[12px]">{query.trim() ? 'No matching history.' : 'No history yet.'}</span>
          </div>
        ) : (
          <div className="px-4 py-2">
            {groups.map(([label, rows]) => (
              <section key={label} className="mb-4">
                <div className="text-[10px] uppercase tracking-wide font-semibold text-fg-secondary mb-1 px-1 sticky top-0 z-10 bg-[var(--color-browser-chrome-1)] border-b border-[var(--color-browser-divider)] py-1.5">
                  {label}
                </div>
                <div className="flex flex-col">
                  {rows.map((e) => {
                    const isSelected = selected.has(e.id);
                    return (
                      <div
                        key={e.id}
                        onContextMenu={(ev) => {
                          ev.preventDefault();
                          setMenu({ entry: e, x: ev.clientX, y: ev.clientY });
                        }}
                        className={`group flex items-center gap-3 px-2 py-1.5 rounded transition-colors ${
                          isSelected ? 'bg-[var(--color-tab-hover-bg)]' : 'hover:bg-[var(--color-tab-hover-bg)]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(e.id)}
                          aria-label={`Select ${e.title || hostLabel(e.url)}`}
                          className={`shrink-0 ${isSelected ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}
                        />
                        <RowIcon entry={e} />
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
                        <span
                          className="text-[10px] text-fg-muted shrink-0 tabular-nums"
                          title={new Date(e.visitedAt).toLocaleString()}
                        >
                          {relativeTime(e.visitedAt)}
                        </span>
                        <button
                          onClick={() => onDelete(e.id)}
                          className="ui-btn ui-btn-ghost p-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          title="Remove from history"
                        >
                          <Icons.X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
            {loading && entries.length > 0 && (
              <div className="flex items-center justify-center py-3 text-fg-muted text-[11px]">
                <Icons.Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                Loading…
              </div>
            )}
          </div>
        )}
      </div>

      {/* Per-row context menu (clamped to the viewport, Esc/outside-click close). */}
      {menu && (
        <div
          role="menu"
          className="fixed z-50 min-w-[180px] rounded-md border border-[var(--color-browser-divider)] bg-[var(--color-browser-chrome-1)] shadow-lg py-1 text-[12px]"
          style={{
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 120),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => reopenInNewTab(menu.entry.url)}
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--color-tab-hover-bg)] flex items-center gap-2"
          >
            <Icons.ExternalLink className="w-3.5 h-3.5" /> Reopen in new tab
          </button>
          <button
            role="menuitem"
            onClick={() => copyUrl(menu.entry.url)}
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--color-tab-hover-bg)] flex items-center gap-2"
          >
            <Icons.Copy className="w-3.5 h-3.5" /> Copy URL
          </button>
          <button
            role="menuitem"
            onClick={() => onDelete(menu.entry.id)}
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--color-tab-hover-bg)] text-accent-red flex items-center gap-2"
          >
            <Icons.Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

export default function HistoryView() {
  const historyViewOpen = useBrowserStore((s) => s.historyViewOpen);
  if (!historyViewOpen) return null;
  return <HistoryViewInner />;
}
