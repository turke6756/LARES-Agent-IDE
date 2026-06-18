import React, { useEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore, type Bookmark } from '../../stores/browser-store';

// ── Star / bookmark menu (WP3-BM-UI) ─────────────────────────────────────────
// Lives in the AddressBar's reserved STAR slot. Rendered ONLY for user-partition
// tabs — agent URLs are never bookmarkable (persistence half of M9 discipline;
// the main-side store also rejects them as defense-in-depth). Bookmarks are pure
// data: opening one later routes through navigate/createTab → M6.
//
// Self-contained leaf — reads everything from the store, takes no props. C-WIRE
// drops <StarMenu /> into the AddressBar slot.

function findBookmark(bookmarks: Bookmark[], url: string): Bookmark | undefined {
  return bookmarks.find((b) => b.url === url);
}

export default function StarMenu() {
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const tabs = useBrowserStore((s) => s.tabs);
  const bookmarks = useBrowserStore((s) => s.bookmarks);
  const addBookmark = useBrowserStore((s) => s.addBookmark);
  const removeBookmark = useBrowserStore((s) => s.removeBookmark);
  const bookmarkTick = useBrowserStore((s) => s.bookmarkTick);

  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null;

  const [open, setOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const prevTick = useRef(bookmarkTick);

  // Only user-partition tabs with a committed http(s) URL can be bookmarked.
  const bookmarkable =
    activeTab !== null && activeTab.partition === 'user' && !activeTab.isNewTab && Boolean(activeTab.url);
  const existing = bookmarkable ? findBookmark(bookmarks, activeTab!.url) : undefined;
  const isBookmarked = Boolean(existing);

  // Ctrl+D (the 'bookmark' shortcut) bumps bookmarkTick → add (if new) + pop the editor.
  useEffect(() => {
    if (bookmarkTick === prevTick.current) return;
    prevTick.current = bookmarkTick;
    if (!bookmarkable || !activeTab) return;
    if (!findBookmark(useBrowserStore.getState().bookmarks, activeTab.url)) {
      void addBookmark({ title: activeTab.title || activeTab.url, url: activeTab.url });
    }
    setDraftTitle(activeTab.title || activeTab.url);
    setOpen(true);
  }, [bookmarkTick, bookmarkable, activeTab, addBookmark]);

  // Close the popover when the active tab changes out from under it.
  useEffect(() => {
    setOpen(false);
  }, [activeTabId]);

  // Dismiss on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!bookmarkable || !activeTab) return null;

  const onStarClick = () => {
    if (!isBookmarked) {
      void addBookmark({ title: activeTab.title || activeTab.url, url: activeTab.url });
      setDraftTitle(activeTab.title || activeTab.url);
    } else {
      setDraftTitle(existing!.title);
    }
    setOpen((v) => !v);
  };

  const onSaveTitle = () => {
    // No update API — re-add with the edited title (remove keeps the same url).
    const title = draftTitle.trim() || activeTab.url;
    if (existing && title !== existing.title) {
      removeBookmark(existing.id);
      void addBookmark({ title, url: activeTab.url });
    }
    setOpen(false);
  };

  const onRemove = () => {
    if (existing) removeBookmark(existing.id);
    setOpen(false);
  };

  return (
    <div className="relative shrink-0" ref={popoverRef}>
      <button
        onClick={onStarClick}
        className="ui-btn ui-btn-ghost p-1.5"
        title={isBookmarked ? 'Edit bookmark' : 'Bookmark this page'}
        aria-pressed={isBookmarked}
      >
        <Icons.Star
          className={`w-4 h-4 ${isBookmarked ? 'text-accent-blue' : ''}`}
          fill={isBookmarked ? 'currentColor' : 'none'}
        />
      </button>

      {open && (
        <div
          className="absolute z-50 top-full mt-1 left-0 w-72 rounded-md p-3 flex flex-col gap-2 bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] shadow-lg"
          role="dialog"
        >
          <div className="text-[11px] font-semibold text-fg-primary">
            {isBookmarked ? 'Bookmark added' : 'Bookmark'}
          </div>
          <label className="text-[10px] uppercase tracking-wide text-fg-muted">Name</label>
          <input
            type="text"
            value={draftTitle}
            autoFocus
            spellCheck={false}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSaveTitle();
              else if (e.key === 'Escape') setOpen(false);
            }}
            className="bg-browser-chrome-2 border border-tab-border px-2 py-1 text-[12px] text-fg-primary focus:outline-none focus:border-accent-blue/60 rounded"
          />
          <div className="text-[10px] text-fg-muted truncate" title={activeTab.url}>
            {activeTab.url}
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <button onClick={onRemove} className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] text-accent-red">
              Remove
            </button>
            <button onClick={onSaveTitle} className="ui-btn ui-btn-outline px-3 py-1 text-[11px]">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
