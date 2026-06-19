import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import {
  useBrowserStore,
  getBrowserApi,
  resolveBrowserInput,
  selectVisibleTabs,
  type Bookmark,
  type BrowserTabState,
  type HistoryEntry,
  type OmniboxSuggestion,
} from '../../stores/browser-store';

// ── New Tab page (Slice-9 — command center) ──────────────────────────────────
// This is renderer DOM ONLY — it is NEVER a navigated page. M6 denies
// chrome://, data:, and file: schemes, so the New Tab surface cannot be a real
// URL. BrowserViewHost mounts this in the host area and calls setActiveTab(null)
// so no WebContentsView paints over it.
//
// Every "open" action here routes through `onNavigate` (→ store.navigate) or
// store.createTab — both pass the existing M6 scheme/SSRF gate, which has final
// say. There is NO navigation path in this component that bypasses it (no direct
// getBrowserApi().navigate / WebContentsView load). The "needs attention" strip
// merely SELECTS an already-open tab (no navigation at all).
//
// Sections (Slice-9): omnibox (shared resolveBrowserInput + Slice-6
// omniboxSuggest), top sites (historyTopSites), recent bookmarks, a workspace
// "needs attention" strip (agent tabs flagged needsHumanAttention), and a
// reserved/empty "recent downloads" slot (populated in Slice 13).
//
// All persisted sources (top sites / bookmarks) are USER-PARTITION only by
// construction in the backend — the NTP never queries or links agent URLs. Until
// a given backend method exists the section degrades to a friendly empty state;
// a present method that THROWS degrades to an error state with a Retry.

interface Props {
  /** Wired by the host to store.navigate(activeTabId, url) (or createTab when no
   *  active tab). Both pass the M6 gate — this is the ONLY open path. */
  onNavigate: (url: string) => void;
}

const TOP_SITES_LIMIT = 8;
const RECENT_BOOKMARKS_LIMIT = 8;
const RECENT_DOWNLOADS_LIMIT = 4;
const OMNIBOX_DEBOUNCE_MS = 80;

const KIND_ICON: Record<OmniboxSuggestion['kind'], keyof typeof Icons> = {
  tab: 'AppWindow',
  bookmark: 'Bookmark',
  history: 'History',
  search: 'Search',
  url: 'Globe',
};

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function siteInitial(url: string, title: string): string {
  const source = (title.trim() || hostLabel(url)).replace(/^https?:\/\//, '').trim();
  return (source[0] ?? '?').toUpperCase();
}

// ── A remote list with three states: loading / ready / error. ────────────────
// `fetcher()` returns the in-flight promise, or `null` SYNCHRONOUSLY when the
// backend method is absent — in which case we degrade to a friendly empty
// (ready, []) rather than an error. A present method that rejects → error +
// Retry. A request token discards a stale response after a reload.
type RemoteStatus = 'loading' | 'ready' | 'error';

interface Remote<T> {
  status: RemoteStatus;
  items: T[];
  reload: () => void;
}

function useRemote<T>(fetcher: () => Promise<T[]> | null): Remote<T> {
  const [status, setStatus] = useState<RemoteStatus>('loading');
  const [items, setItems] = useState<T[]>([]);
  const tokenRef = useRef(0);
  // The fetcher is recreated each render (it closes over getBrowserApi); keep it
  // in a ref so `reload`/the mount effect have a stable identity.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(() => {
    const token = ++tokenRef.current;
    const promise = fetcherRef.current();
    if (!promise) {
      // Backend method absent → empty, not an error (degrade gracefully).
      setStatus('ready');
      setItems([]);
      return;
    }
    setStatus('loading');
    promise
      .then((rows) => {
        if (token !== tokenRef.current) return;
        setItems(Array.isArray(rows) ? rows : []);
        setStatus('ready');
      })
      .catch(() => {
        if (token !== tokenRef.current) return;
        setStatus('error');
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { status, items, reload };
}

/** A favicon with letter fallback (img errors → initial glyph), mirroring the
 *  Slice-8 HistoryView RowIcon pattern. Shared by top sites + bookmarks. */
function Favicon({
  url,
  title,
  favicon,
  className,
}: {
  url: string;
  title: string;
  favicon?: string | null;
  className: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!favicon || broken) {
    return (
      <span
        className={`${className} flex items-center justify-center font-semibold bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] text-[var(--color-fg-secondary)]`}
      >
        {siteInitial(url, title)}
      </span>
    );
  }
  return (
    <img
      src={favicon}
      alt=""
      onError={() => setBroken(true)}
      className={`${className} object-contain bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] p-0.5`}
    />
  );
}

/** A small section header. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-fg-secondary)] mb-2 px-1">
      {children}
    </div>
  );
}

/** Friendly error row with a Retry that re-runs the section fetch. */
function ErrorRetry({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-secondary)] px-1">
      <Icons.AlertTriangle className="w-3.5 h-3.5 text-accent-orange shrink-0" />
      <span>Couldn’t load {label}.</span>
      <button onClick={onRetry} className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px] text-accent-blue">
        Retry
      </button>
    </div>
  );
}

function TopSitesSkeleton() {
  return (
    <div className="grid grid-cols-4 sm:grid-cols-8 gap-3" aria-hidden="true">
      {Array.from({ length: TOP_SITES_LIMIT }).map((_, i) => (
        <div key={i} className="flex flex-col items-center gap-1.5">
          <span className="browser-skeleton w-11 h-11 rounded-full" />
          <span className="browser-skeleton h-2.5 w-12" />
        </div>
      ))}
    </div>
  );
}

function BookmarksSkeleton() {
  return (
    <div className="flex flex-wrap gap-2" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} className="browser-skeleton h-7 w-28 rounded-full" />
      ))}
    </div>
  );
}

export default function NewTabPage({ onNavigate }: Props) {
  const createTab = useBrowserStore((s) => s.createTab);
  const selectTab = useBrowserStore((s) => s.selectTab);

  // ── Omnibox (Slice-6 shared slice) ─────────────────────────────────────────
  // Reuse the store's omnibox suggestion slice (the same one the AddressBar
  // drives) so there is a single ranked-suggestion source. Only one omnibox is
  // ever editing at a time (the AddressBar carries no tab on the NTP), so sharing
  // is safe. Clear it on unmount so a stale list can't leak into the AddressBar.
  const omniboxResults = useBrowserStore((s) => s.omniboxResults);
  const activeIndex = useBrowserStore((s) => s.omniboxActiveIndex);
  const fetchOmnibox = useBrowserStore((s) => s.fetchOmnibox);
  const clearOmnibox = useBrowserStore((s) => s.clearOmnibox);
  const setActiveIndex = useBrowserStore((s) => s.setOmniboxActiveIndex);

  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dropdownOpen = editing && query.trim().length > 0 && omniboxResults.length > 0;

  useEffect(() => () => clearOmnibox(), [clearOmnibox]);

  // ── Workspace "needs attention" strip ──────────────────────────────────────
  // Agent tabs in the workspace the human is viewing that main has flagged as
  // needing attention. Selecting one just brings the existing tab forward — no
  // navigation, so no gate needed.
  const tabs = useBrowserStore((s) => s.tabs);
  const selectedWorkspaceId = useBrowserStore((s) => s.selectedWorkspaceId);
  const attentionTabs = useMemo<BrowserTabState[]>(
    () =>
      selectVisibleTabs({ tabs, selectedWorkspaceId }).filter(
        (t) => t.partition === 'agent' && Boolean(t.needsHumanAttention),
      ),
    [tabs, selectedWorkspaceId],
  );

  // ── Top sites + recent bookmarks (guarded; degrade to empty/error) ─────────
  const topSites = useRemote<HistoryEntry>(() => {
    const api = getBrowserApi();
    return api?.historyTopSites ? api.historyTopSites(TOP_SITES_LIMIT) : null;
  });
  const bookmarks = useRemote<Bookmark>(() => {
    const api = getBrowserApi();
    return api?.bookmarkList ? api.bookmarkList() : null;
  });
  // Most-recently-added bookmarks first (createdAt desc), capped.
  const recentBookmarks = useMemo(
    () => [...bookmarks.items].sort((a, b) => b.createdAt - a.createdAt).slice(0, RECENT_BOOKMARKS_LIMIT),
    [bookmarks.items],
  );

  // ── Recent downloads (Slice 13) ────────────────────────────────────────────
  // Read straight from the store's download slice (the bridge seeds + upserts
  // it). Show only the most recent COMPLETED files, capped small. Clicking a row
  // opens the saved file via the shell (store.openDownloadFile).
  const downloads = useBrowserStore((s) => s.downloads);
  const openDownloadFile = useBrowserStore((s) => s.openDownloadFile);
  const recentDownloads = useMemo(
    () => downloads.filter((d) => d.state === 'completed').slice(0, RECENT_DOWNLOADS_LIMIT),
    [downloads],
  );

  // ── Omnibox handlers ───────────────────────────────────────────────────────
  const openUrl = (url: string) => {
    onNavigate(url); // → store.navigate / createTab → M6 gate.
    setQuery('');
    setEditing(false);
    clearOmnibox();
    inputRef.current?.blur();
  };

  const submitRaw = () => {
    // Shared resolver (Slice-6): URL-shaped input → http(s) URL, free text → web
    // search. The M6 gate downstream of onNavigate has final say.
    const resolved = resolveBrowserInput(query);
    if (!resolved.display) return;
    openUrl(resolved.url);
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.currentTarget.value;
    setEditing(true);
    setQuery(next);
    fetchOmnibox(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const lastIndex = omniboxResults.length - 1;
    if (e.key === 'ArrowDown' && dropdownOpen) {
      e.preventDefault();
      setActiveIndex(activeIndex >= lastIndex ? -1 : activeIndex + 1);
    } else if (e.key === 'ArrowUp' && dropdownOpen) {
      e.preventDefault();
      setActiveIndex(activeIndex <= -1 ? lastIndex : activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && omniboxResults[activeIndex]) {
        openUrl(omniboxResults[activeIndex].url);
      } else {
        submitRaw();
      }
    } else if (e.key === 'Escape') {
      if (dropdownOpen) {
        clearOmnibox();
      } else {
        setQuery('');
        e.currentTarget.blur();
      }
    }
  };

  return (
    <div className="browser-ntp">
      <div className="w-full max-w-2xl flex flex-col items-center gap-7">
        {/* Wordmark */}
        <div className="flex items-center gap-2 text-[var(--color-fg-secondary)]">
          <Icons.Globe className="w-7 h-7" />
          <span className="text-[15px] font-semibold tracking-wide">New Tab</span>
        </div>

        {/* Omnibox — shared resolveBrowserInput + Slice-6 suggestions. */}
        <div className="relative w-full max-w-xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!(activeIndex >= 0 && omniboxResults[activeIndex])) submitRaw();
            }}
          >
            <div className="flex items-center gap-2 rounded-full px-4 py-2.5 bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] focus-within:border-accent-blue/70 transition-colors">
              <Icons.Search className="w-4 h-4 text-[var(--color-fg-secondary)] shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                autoFocus
                spellCheck={false}
                role="combobox"
                aria-expanded={dropdownOpen}
                aria-controls="ntp-omnibox-listbox"
                aria-activedescendant={
                  dropdownOpen && activeIndex >= 0 ? `ntp-omnibox-option-${activeIndex}` : undefined
                }
                placeholder="Search the web or enter a URL"
                onChange={onInputChange}
                onFocus={() => setEditing(true)}
                onBlur={() => {
                  // A row's onMouseDown preventDefaults to keep focus, so a blur
                  // here means focus genuinely left the omnibox → close it.
                  setEditing(false);
                  clearOmnibox();
                }}
                onKeyDown={onKeyDown}
                className="flex-1 min-w-0 bg-transparent text-[13px] text-[var(--color-fg-primary)] placeholder-[var(--color-fg-secondary)] focus:outline-none"
              />
              {query.trim() && (
                <button type="submit" className="ui-btn ui-btn-ghost p-1 shrink-0" title="Go">
                  <Icons.ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </form>

          {dropdownOpen && (
            <ul
              id="ntp-omnibox-listbox"
              role="listbox"
              aria-label="Address suggestions"
              className="browser-popover browser-popover-anim absolute left-0 right-0 top-full mt-1 z-20 max-h-80 overflow-y-auto py-1"
            >
              {omniboxResults.map((row, i) => {
                const Icon = Icons[KIND_ICON[row.kind]] as React.ComponentType<{ className?: string }>;
                const active = i === activeIndex;
                return (
                  <li
                    key={`${row.kind}:${row.url}:${i}`}
                    id={`ntp-omnibox-option-${i}`}
                    role="option"
                    aria-selected={active}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => openUrl(row.url)}
                    className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[12px] ${
                      active ? 'bg-accent-blue/15' : 'hover:bg-[var(--color-browser-chrome-1)]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0 text-[var(--color-fg-secondary)]" />
                    <span className="truncate text-[var(--color-fg-primary)]">{row.title}</span>
                    {row.kind !== 'search' && (
                      <span className="truncate text-[11px] text-[var(--color-fg-secondary)] ml-auto pl-2">
                        {row.display}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Partition affordance — compact badges + tooltips (replaces the old
            instructional paragraph) alongside the new-tab buttons. */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={() => void createTab('user')}
            className="ui-btn ui-btn-outline px-3 py-1.5 text-[12px]"
            title="Open a new tab in your partition (persist:user) — sign-ins persist here"
          >
            <Icons.Plus className="w-3.5 h-3.5" />
            New user tab
          </button>
          <button
            onClick={() => void createTab('agent')}
            className="ui-btn ui-btn-outline px-3 py-1.5 text-[12px]"
            title="Open a new isolated agent-partition tab (persist:agent) — no access to your sign-ins"
          >
            <Icons.Bot className="w-3.5 h-3.5" />
            New agent tab
          </button>
          <span
            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full text-accent-blue bg-accent-blue/10"
            title="Your partition (persist:user) — sign-ins persist across sessions"
          >
            <Icons.User className="w-3 h-3" />
            User · signed in
          </span>
          <span
            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full text-accent-orange bg-accent-orange/10"
            title="Agent partition (persist:agent) — isolated, with no access to your sign-ins"
          >
            <Icons.Bot className="w-3 h-3" />
            Agent · isolated
          </span>
        </div>

        {/* Needs attention — agent tabs in this workspace flagged by main. Click
            SELECTS the existing tab (no navigation). */}
        {attentionTabs.length > 0 && (
          <section className="w-full">
            <SectionLabel>
              <span className="inline-flex items-center gap-1 text-accent-orange">
                <Icons.Bell className="w-3 h-3" />
                Needs attention
              </span>
            </SectionLabel>
            <div className="flex flex-col gap-1.5">
              {attentionTabs.map((t) => (
                <button
                  key={t.tabId}
                  onClick={() => selectTab(t.tabId)}
                  title={`${t.openedByAgentTitle ? `Opened by ${t.openedByAgentTitle}\n` : ''}${t.url}`}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-left bg-accent-orange/10 border border-accent-orange/30 hover:border-accent-orange/60 transition-colors"
                >
                  <Favicon
                    url={t.url}
                    title={t.title}
                    favicon={t.favicon}
                    className="w-6 h-6 rounded-sm text-[10px] shrink-0"
                  />
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span className="text-[12px] text-[var(--color-fg-primary)] truncate">
                      {t.title || hostLabel(t.url) || 'Agent tab'}
                    </span>
                    <span className="text-[10px] text-[var(--color-fg-secondary)] truncate">
                      {t.openedByAgentTitle ? `${t.openedByAgentTitle} · ` : ''}
                      {hostLabel(t.url)}
                    </span>
                  </span>
                  <Icons.ChevronRight className="w-4 h-4 text-accent-orange shrink-0" />
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Top sites (historyTopSites, favicons with letter fallback). */}
        <section className="w-full">
          <SectionLabel>Top sites</SectionLabel>
          {topSites.status === 'loading' ? (
            <TopSitesSkeleton />
          ) : topSites.status === 'error' ? (
            <ErrorRetry label="top sites" onRetry={topSites.reload} />
          ) : topSites.items.length === 0 ? (
            <p className="text-[11px] text-[var(--color-fg-secondary)] px-1">
              Sites you visit most will show up here.
            </p>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-3">
              {topSites.items.map((site) => (
                <button
                  key={site.id}
                  onClick={() => onNavigate(site.url)}
                  title={`${site.title || hostLabel(site.url)}\n${site.url}`}
                  className="flex flex-col items-center gap-1.5 group"
                >
                  <Favicon
                    url={site.url}
                    title={site.title}
                    favicon={site.favicon}
                    className="w-11 h-11 rounded-full text-[15px] group-hover:border-accent-blue/60 transition-colors"
                  />
                  <span className="text-[10px] text-[var(--color-fg-secondary)] truncate max-w-[64px]">
                    {site.title || hostLabel(site.url)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Recent bookmarks (user-partition only; favicons with letter fallback). */}
        <section className="w-full">
          <SectionLabel>Recent bookmarks</SectionLabel>
          {bookmarks.status === 'loading' ? (
            <BookmarksSkeleton />
          ) : bookmarks.status === 'error' ? (
            <ErrorRetry label="bookmarks" onRetry={bookmarks.reload} />
          ) : recentBookmarks.length === 0 ? (
            <p className="text-[11px] text-[var(--color-fg-secondary)] px-1">
              Bookmark a page (★) and it’ll appear here.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {recentBookmarks.map((mark) => (
                <button
                  key={mark.id}
                  onClick={() => onNavigate(mark.url)}
                  title={`${mark.title || hostLabel(mark.url)}\n${mark.url}`}
                  className="flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-full text-[11px] bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] text-[var(--color-fg-primary)] hover:border-accent-blue/60 transition-colors max-w-[220px]"
                >
                  <Favicon
                    url={mark.url}
                    title={mark.title}
                    favicon={mark.favicon}
                    className="w-4 h-4 rounded-sm text-[9px] shrink-0"
                  />
                  <span className="truncate">{mark.title || hostLabel(mark.url)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Recent downloads (Slice 13) — most recent COMPLETED files from the
            store's download slice. Clicking opens the saved file via the shell. */}
        <section className="w-full">
          <SectionLabel>Recent downloads</SectionLabel>
          {recentDownloads.length === 0 ? (
            <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-secondary)] px-1">
              <Icons.Download className="w-3.5 h-3.5 opacity-50 shrink-0" />
              <span>Downloads will appear here.</span>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {recentDownloads.map((d) => (
                <button
                  key={d.id}
                  onClick={() => openDownloadFile(d.id)}
                  title={`Open ${d.filename}\n${d.origin}`}
                  className="flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-full text-[11px] bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] text-[var(--color-fg-primary)] hover:border-accent-blue/60 transition-colors max-w-[220px]"
                >
                  <Icons.FileText className="w-3.5 h-3.5 shrink-0 text-[var(--color-fg-secondary)]" />
                  <span className="truncate">{d.filename}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
