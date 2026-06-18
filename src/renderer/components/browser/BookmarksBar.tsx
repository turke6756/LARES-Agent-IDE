import React from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore } from '../../stores/browser-store';

// ── Bookmarks bar (WP3-BM-UI) ────────────────────────────────────────────────
// A strip of favicon/letter + title chips below the toolbar (.bookmark-bar).
// Click opens in the active tab via navigate; middle-click opens a new user tab
// via createTab — both route through the M6 gate. Rendered only when
// bookmarkBarVisible. Bookmarks are user-partition only by construction (the
// backend never persists agent URLs), so no partition gate is needed here.

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function chipInitial(title: string, url: string): string {
  const source = (title.trim() || hostLabel(url)).replace(/^https?:\/\//, '').trim();
  return (source[0] ?? '?').toUpperCase();
}

export default function BookmarksBar() {
  const bookmarkBarVisible = useBrowserStore((s) => s.bookmarkBarVisible);
  const bookmarks = useBrowserStore((s) => s.bookmarks);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const navigate = useBrowserStore((s) => s.navigate);
  const createTab = useBrowserStore((s) => s.createTab);

  if (!bookmarkBarVisible) return null;

  const open = (url: string) => {
    if (activeTabId) navigate(activeTabId, url);
    else void createTab('user', url);
  };

  return (
    <div className="bookmark-bar shrink-0">
      {bookmarks.length === 0 ? (
        <span className="text-[11px] text-fg-muted px-1 select-none">
          No bookmarks yet — use the star to add one.
        </span>
      ) : (
        bookmarks.map((mark) => (
          <button
            key={mark.id}
            onClick={() => open(mark.url)}
            onAuxClick={(e) => {
              // Middle-click → open in a new user tab.
              if (e.button === 1) {
                e.preventDefault();
                void createTab('user', mark.url);
              }
            }}
            title={`${mark.title || hostLabel(mark.url)}\n${mark.url}`}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] text-fg-primary hover:bg-[var(--color-tab-hover-bg)] transition-colors max-w-[180px] shrink-0"
          >
            {mark.url && mark.url.startsWith('http') ? (
              <span className="w-3.5 h-3.5 rounded-sm flex items-center justify-center text-[8px] font-bold bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] text-fg-secondary shrink-0">
                {chipInitial(mark.title, mark.url)}
              </span>
            ) : (
              <Icons.Bookmark className="w-3 h-3 text-fg-secondary shrink-0" />
            )}
            <span className="truncate">{mark.title || hostLabel(mark.url)}</span>
          </button>
        ))
      )}
    </div>
  );
}
