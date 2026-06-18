import React, { useEffect, useState } from 'react';
import * as Icons from 'lucide-react';
import {
  useBrowserStore,
  getBrowserApi,
  resolveBrowserInput,
  type Bookmark,
  type HistoryEntry,
} from '../../stores/browser-store';

// ── New Tab page (WP2-NTP) ───────────────────────────────────────────────────
// This is renderer DOM ONLY — it is NEVER a navigated page. M6 denies
// chrome://, data:, and file: schemes, so the New Tab surface cannot be a real
// URL. BrowserViewHost mounts this in the host area and calls setActiveTab(null)
// so no WebContentsView paints over it. Every "open" action here routes through
// onNavigate (→ store.navigate) or store.createTab, both of which pass the
// existing M6 scheme gate — there is no navigation path that bypasses it.
//
// Top-sites and bookmark shortcuts are sourced from the user-partition-only
// backend (history / bookmarks). The NTP never queries or links agent-partition
// URLs. The history/bookmark backends land in a parallel WP, so both api methods
// are guarded for absence and the page degrades to an empty/skeleton state
// rather than throwing.

interface Props {
  /** Wired by the host to store.navigate(activeTabId, url). */
  onNavigate: (url: string) => void;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function siteInitial(url: string, title: string): string {
  const source = title.trim() || hostLabel(url);
  const ch = source.replace(/^https?:\/\//, '').trim()[0];
  return (ch ?? '?').toUpperCase();
}

export default function NewTabPage({ onNavigate }: Props) {
  const createTab = useBrowserStore((s) => s.createTab);

  const [query, setQuery] = useState('');
  const [topSites, setTopSites] = useState<HistoryEntry[] | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);

  // Load top-sites + bookmark shortcuts from the user-partition backend. Both
  // calls are guarded: until the history/bookmark WP lands the methods may be
  // absent, and we degrade to empty rather than throwing.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const sites = await getBrowserApi()?.historyList?.({ limit: 8 });
        if (live) setTopSites(Array.isArray(sites) ? sites : []);
      } catch {
        if (live) setTopSites([]);
      }
    })();
    void (async () => {
      try {
        const marks = await getBrowserApi()?.bookmarkList?.();
        if (live) setBookmarks(Array.isArray(marks) ? marks : []);
      } catch {
        if (live) setBookmarks([]);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const submit = () => {
    // Shared resolver (Slice-6): URL-shaped input → http(s) URL, free text →
    // web search. The M6 gate downstream of onNavigate has final say.
    const resolved = resolveBrowserInput(query);
    if (!resolved.display) return;
    onNavigate(resolved.url);
    setQuery('');
  };

  return (
    <div className="browser-ntp">
      <div className="w-full max-w-2xl flex flex-col items-center gap-8">
        {/* Wordmark */}
        <div className="flex items-center gap-2 text-[var(--color-fg-secondary)]">
          <Icons.Globe className="w-7 h-7" />
          <span className="text-[15px] font-semibold tracking-wide">New Tab</span>
        </div>

        {/* Search / URL box — uses the shared resolveBrowserInput resolver. */}
        <form
          className="w-full max-w-xl"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex items-center gap-2 rounded-full px-4 py-2.5 bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] focus-within:border-accent-blue/70 transition-colors">
            <Icons.Search className="w-4 h-4 text-[var(--color-fg-secondary)] shrink-0" />
            <input
              type="text"
              value={query}
              autoFocus
              spellCheck={false}
              placeholder="Search the web or enter a URL"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('');
                  e.currentTarget.blur();
                }
              }}
              className="flex-1 min-w-0 bg-transparent text-[13px] text-[var(--color-fg-primary)] placeholder-[var(--color-fg-secondary)] focus:outline-none"
            />
            {query.trim() && (
              <button
                type="submit"
                className="ui-btn ui-btn-ghost p-1 shrink-0"
                title="Go"
              >
                <Icons.ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </form>

        {/* New user / agent tab affordance — both route through createTab → M6. */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => void createTab('user')}
            className="ui-btn ui-btn-outline px-3 py-1.5 text-[12px]"
            title="Open a new tab in your partition (sign-ins persist)"
          >
            <Icons.Plus className="w-3.5 h-3.5" />
            New user tab
          </button>
          <button
            onClick={() => void createTab('agent')}
            className="ui-btn ui-btn-outline px-3 py-1.5 text-[12px]"
            title="Open a new isolated agent-partition tab"
          >
            <Icons.Bot className="w-3.5 h-3.5" />
            New agent tab
          </button>
        </div>

        {/* Top sites (from user-partition history; guarded for absence). */}
        {topSites && topSites.length > 0 && (
          <section className="w-full">
            <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-fg-secondary)] mb-2 px-1">
              Top sites
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-3">
              {topSites.map((site) => (
                <button
                  key={site.id}
                  onClick={() => onNavigate(site.url)}
                  title={`${site.title || hostLabel(site.url)}\n${site.url}`}
                  className="flex flex-col items-center gap-1.5 group"
                >
                  <span className="w-11 h-11 rounded-full flex items-center justify-center text-[15px] font-semibold bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] text-[var(--color-fg-secondary)] group-hover:border-accent-blue/60 transition-colors">
                    {siteInitial(site.url, site.title)}
                  </span>
                  <span className="text-[10px] text-[var(--color-fg-secondary)] truncate max-w-[64px]">
                    {site.title || hostLabel(site.url)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Bookmark shortcuts (user-partition only; guarded for absence). */}
        {bookmarks && bookmarks.length > 0 && (
          <section className="w-full">
            <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-fg-secondary)] mb-2 px-1">
              Bookmarks
            </div>
            <div className="flex flex-wrap gap-2">
              {bookmarks.map((mark) => (
                <button
                  key={mark.id}
                  onClick={() => onNavigate(mark.url)}
                  title={`${mark.title || hostLabel(mark.url)}\n${mark.url}`}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] text-[var(--color-fg-primary)] hover:border-accent-blue/60 transition-colors max-w-[200px]"
                >
                  <Icons.Bookmark className="w-3 h-3 text-[var(--color-fg-secondary)] shrink-0" />
                  <span className="truncate">{mark.title || hostLabel(mark.url)}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Partition note. */}
        <p className="text-[11px] text-[var(--color-fg-secondary)] text-center max-w-md leading-relaxed">
          Sign-ins persist in your <span className="text-accent-blue font-medium">user</span> partition.
          {' '}
          <span className="text-accent-orange font-medium">Agent</span> tabs run in an isolated
          partition with no access to those sign-ins.
        </p>
      </div>
    </div>
  );
}
