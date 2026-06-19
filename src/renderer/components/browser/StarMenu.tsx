import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore, type Bookmark } from '../../stores/browser-store';
import { suspendBrowserPane, resumeBrowserPane } from './useBrowserSuspension';
import { useAnchoredPlacement } from './popover-position';

// ── Star / bookmark menu (WP3-BM-UI · Slice-7 manager) ───────────────────────
// Lives in the AddressBar's reserved STAR slot. Rendered ONLY for user-partition
// tabs — agent URLs are never bookmarkable (persistence half of M9 discipline;
// the main-side store also rejects them as defense-in-depth). Bookmarks are pure
// data: opening one later routes through navigate/createTab → M6.
//
// Slice-7 adds: a folder picker on save (one level), Edit-moves-to-folder, and
// undo-after-delete (5s snackbar). Slice-5 pane-suspension is preserved — the
// open popover (and the undo snackbar) can overlap the native WebContentsView,
// so both suspend the pane while visible (ref-counted; composes with other
// overlays).
//
// Self-contained leaf — reads everything from the store, takes no props.

function findBookmark(bookmarks: Bookmark[], url: string): Bookmark | undefined {
  return bookmarks.find((b) => b.url === url);
}

/** select-value sentinel for the "create a new folder" option. */
const NEW_FOLDER = '__new__';

export default function StarMenu() {
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const tabs = useBrowserStore((s) => s.tabs);
  const bookmarks = useBrowserStore((s) => s.bookmarks);
  const addBookmark = useBrowserStore((s) => s.addBookmark);
  const removeBookmark = useBrowserStore((s) => s.removeBookmark);
  const updateBookmark = useBrowserStore((s) => s.updateBookmark);
  const bookmarkTick = useBrowserStore((s) => s.bookmarkTick);

  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null;

  const [open, setOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  // '' = top-level (no folder); a folder name; or NEW_FOLDER while typing one.
  const [draftFolder, setDraftFolder] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  // The just-added bookmark id (so a fresh save can patch its folder before the
  // onBookmarksChanged event has refreshed `existing`).
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  // A recently-deleted bookmark, snapshotted for the 5s undo snackbar.
  const [undo, setUndo] = useState<Bookmark | null>(null);
  const undoTimer = useRef<number | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const starBtnRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const prevTick = useRef(bookmarkTick);

  // Only user-partition tabs with a committed http(s) URL can be bookmarked.
  const bookmarkable =
    activeTab !== null && activeTab.partition === 'user' && !activeTab.isNewTab && Boolean(activeTab.url);
  const existing = bookmarkable ? findBookmark(bookmarks, activeTab!.url) : undefined;
  const isBookmarked = Boolean(existing);
  const currentId = existing?.id ?? justAddedId;

  // Existing one-level folders, for the picker.
  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const b of bookmarks) if (b.folder) set.add(b.folder);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [bookmarks]);

  const clearUndoTimer = () => {
    if (undoTimer.current !== null) {
      window.clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
  };

  // Ctrl+D (the 'bookmark' shortcut) bumps bookmarkTick → add (if new) + pop the editor.
  useEffect(() => {
    if (bookmarkTick === prevTick.current) return;
    prevTick.current = bookmarkTick;
    if (!bookmarkable || !activeTab) return;
    const already = findBookmark(useBrowserStore.getState().bookmarks, activeTab.url);
    if (!already) {
      void addBookmark({ title: activeTab.title || activeTab.url, url: activeTab.url }).then((b) =>
        setJustAddedId(b?.id ?? null),
      );
      setDraftFolder('');
    } else {
      setDraftFolder(already.folder ?? '');
    }
    setDraftTitle(activeTab.title || activeTab.url);
    setOpen(true);
  }, [bookmarkTick, bookmarkable, activeTab, addBookmark]);

  // Close the popover + reset transient edit state when the active tab changes.
  useEffect(() => {
    setOpen(false);
    setJustAddedId(null);
    setNewFolderName('');
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

  // Cross-cutting rule #3: the open popover AND the undo snackbar can overlap the
  // WebContentsView (both render below the address bar, into the host region),
  // and a native view always paints ABOVE renderer DOM — so suspend the pane
  // while either is visible and restore when both are gone. Ref-counted, so it
  // composes with any other overlay (history/access modals): the pane reappears
  // only when the LAST overlay closes.
  useEffect(() => {
    if (!open && !undo) return;
    suspendBrowserPane();
    return () => resumeBrowserPane();
  }, [open, undo]);

  // Clean up the undo timer on unmount.
  useEffect(() => clearUndoTimer, []);

  // Collision-aware placement for the editor popover: anchored under the star,
  // flips above / clamps horizontally near the viewport edge via the shared
  // helper (the star sits in the toolbar where the popover could overflow).
  const placement = useAnchoredPlacement(starBtnRef, editorRef, { align: 'start', gap: 6 }, [open]);

  if (!bookmarkable || !activeTab) return null;

  const onStarClick = () => {
    if (!isBookmarked) {
      void addBookmark({ title: activeTab.title || activeTab.url, url: activeTab.url }).then((b) =>
        setJustAddedId(b?.id ?? null),
      );
      setDraftTitle(activeTab.title || activeTab.url);
      setDraftFolder('');
    } else {
      setDraftTitle(existing!.title);
      setDraftFolder(existing!.folder ?? '');
    }
    setNewFolderName('');
    setOpen((v) => !v);
  };

  // Resolve the picker into a folder name or null (top-level).
  const resolveFolder = (): string | null => {
    if (draftFolder === NEW_FOLDER) return newFolderName.trim() || null;
    return draftFolder.trim() || null;
  };

  const onSave = async () => {
    const title = draftTitle.trim() || activeTab.url;
    const folder = resolveFolder();
    if (currentId) {
      await updateBookmark(currentId, { title, folder });
    } else {
      const created = await addBookmark({ title, url: activeTab.url });
      if (created && folder) await updateBookmark(created.id, { folder });
    }
    setOpen(false);
  };

  const onRemove = () => {
    const target = existing ?? (currentId ? bookmarks.find((b) => b.id === currentId) : undefined);
    if (target) {
      setUndo(target);
      removeBookmark(target.id);
      clearUndoTimer();
      undoTimer.current = window.setTimeout(() => setUndo(null), 5000);
    }
    setJustAddedId(null);
    setOpen(false);
  };

  const onUndo = async () => {
    const b = undo;
    clearUndoTimer();
    setUndo(null);
    if (!b) return;
    const created = await addBookmark({ title: b.title, url: b.url });
    if (created && b.folder) await updateBookmark(created.id, { folder: b.folder });
  };

  return (
    <div className="relative shrink-0" ref={popoverRef}>
      <button
        ref={starBtnRef}
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
          ref={editorRef}
          className="browser-popover browser-popover-anim fixed z-50 w-72 p-3 flex flex-col gap-2"
          role="dialog"
          style={{
            left: placement?.left ?? 0,
            top: placement?.top ?? 0,
            visibility: placement ? 'visible' : 'hidden',
            ['--browser-popover-origin' as string]: placement?.origin ?? 'top left',
          }}
        >
          <div className="text-[11px] font-semibold text-fg-primary">
            {isBookmarked ? 'Edit bookmark' : 'Bookmark'}
          </div>
          <label className="text-[10px] uppercase tracking-wide text-fg-muted">Name</label>
          <input
            type="text"
            value={draftTitle}
            autoFocus
            spellCheck={false}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSave();
              else if (e.key === 'Escape') setOpen(false);
            }}
            className="bg-browser-chrome-2 border border-tab-border px-2 py-1 text-[12px] text-fg-primary focus:outline-none focus:border-accent-blue/60 rounded"
          />

          <label className="text-[10px] uppercase tracking-wide text-fg-muted">Folder</label>
          <select
            value={draftFolder}
            onChange={(e) => setDraftFolder(e.target.value)}
            className="bg-browser-chrome-2 border border-tab-border px-2 py-1 text-[12px] text-fg-primary focus:outline-none focus:border-accent-blue/60 rounded"
          >
            <option value="">No folder (top level)</option>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            <option value={NEW_FOLDER}>New folder…</option>
          </select>
          {draftFolder === NEW_FOLDER && (
            <input
              type="text"
              value={newFolderName}
              placeholder="Folder name"
              spellCheck={false}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onSave();
                else if (e.key === 'Escape') setOpen(false);
              }}
              className="bg-browser-chrome-2 border border-tab-border px-2 py-1 text-[12px] text-fg-primary focus:outline-none focus:border-accent-blue/60 rounded"
            />
          )}

          <div className="text-[10px] text-fg-muted truncate" title={activeTab.url}>
            {activeTab.url}
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <button onClick={onRemove} className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] text-accent-red">
              Remove
            </button>
            <button onClick={() => void onSave()} className="ui-btn ui-btn-outline px-3 py-1 text-[11px]">
              Done
            </button>
          </div>
        </div>
      )}

      {undo && (
        <div
          className="browser-popover browser-popover-anim absolute z-50 top-full mt-1 left-0 w-72 px-3 py-2 flex items-center justify-between gap-2"
          role="status"
        >
          <span className="text-[11px] text-fg-secondary truncate">
            Removed “{undo.title || undo.url}”
          </span>
          <button onClick={() => void onUndo()} className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] text-accent-blue shrink-0">
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
