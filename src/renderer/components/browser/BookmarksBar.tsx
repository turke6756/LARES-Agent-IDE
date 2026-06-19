import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore, type Bookmark } from '../../stores/browser-store';
import { suspendBrowserPane, resumeBrowserPane } from './useBrowserSuspension';

// ── Bookmarks bar (WP3-BM-UI · Slice-7 manager) ──────────────────────────────
// A strip of favicon/letter + title chips below the toolbar (.bookmark-bar).
// Click opens in the active tab via navigate; middle-click opens a new user tab
// via createTab — both route through the M6 gate. Rendered only when
// bookmarkBarVisible. Bookmarks are user-partition only by construction (the
// backend never persists agent URLs), so no partition gate is needed here.
//
// Slice-7 adds: HTML5 drag reorder (mirrors the tab-strip pattern), an overflow
// `»` chevron menu when chips exceed the bar width, one-level folder chips that
// open a child popover, and a right-click context menu (Edit / Open in new tab /
// Copy URL / Remove). Any overlay that can overlap the native WebContentsView
// (folder popover, context menu, edit popover) suspends the pane (rule #3).

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

/** A favicon image (if cached) falling back to a letter glyph. */
function ChipIcon({ mark }: { mark: Bookmark }) {
  const [broken, setBroken] = useState(false);
  if (mark.favicon && !broken) {
    return (
      <img
        src={mark.favicon}
        alt=""
        className="w-3.5 h-3.5 rounded-sm shrink-0"
        onError={() => setBroken(true)}
      />
    );
  }
  if (mark.url && mark.url.startsWith('http')) {
    return (
      <span className="w-3.5 h-3.5 rounded-sm flex items-center justify-center text-[8px] font-bold bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] text-fg-secondary shrink-0">
        {chipInitial(mark.title, mark.url)}
      </span>
    );
  }
  return <Icons.Bookmark className="w-3 h-3 text-fg-secondary shrink-0" />;
}

type Entry =
  | { kind: 'bookmark'; bookmark: Bookmark }
  | { kind: 'folder'; name: string; items: Bookmark[] };

const entryKey = (e: Entry): string => (e.kind === 'bookmark' ? e.bookmark.id : `folder:${e.name}`);

interface MenuState {
  mark: Bookmark;
  x: number;
  y: number;
}

export default function BookmarksBar() {
  const bookmarkBarVisible = useBrowserStore((s) => s.bookmarkBarVisible);
  const bookmarks = useBrowserStore((s) => s.bookmarks);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const navigate = useBrowserStore((s) => s.navigate);
  const createTab = useBrowserStore((s) => s.createTab);
  const reorderBookmark = useBrowserStore((s) => s.reorderBookmark);
  const removeBookmark = useBrowserStore((s) => s.removeBookmark);
  const updateBookmark = useBrowserStore((s) => s.updateBookmark);

  // Build the ordered bar entries: top-level bookmarks interleaved with folder
  // chips (a folder appears at the position of its first member, sortOrder ASC).
  const entries = useMemo<Entry[]>(() => {
    const sorted = [...bookmarks].sort((a, b) => a.sortOrder - b.sortOrder);
    const out: Entry[] = [];
    const folderAt = new Map<string, number>();
    for (const b of sorted) {
      if (b.folder) {
        const at = folderAt.get(b.folder);
        if (at === undefined) {
          folderAt.set(b.folder, out.length);
          out.push({ kind: 'folder', name: b.folder, items: [b] });
        } else {
          (out[at] as { items: Bookmark[] }).items.push(b);
        }
      } else {
        out.push({ kind: 'bookmark', bookmark: b });
      }
    }
    return out;
  }, [bookmarks]);

  const folderNames = useMemo(() => {
    const set = new Set<string>();
    for (const b of bookmarks) if (b.folder) set.add(b.folder);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [bookmarks]);

  // ── Overflow measurement (offscreen row → how many entries fit) ─────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(entries.length);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;
    const compute = () => {
      const avail = container.clientWidth;
      const kids = Array.from(measure.children) as HTMLElement[];
      const CHEVRON = 30;
      const GAP = 4;
      let used = 0;
      let count = 0;
      for (let i = 0; i < kids.length; i++) {
        const w = kids[i].offsetWidth + (i ? GAP : 0);
        const needChevron = i < kids.length - 1;
        if (used + w + (needChevron ? CHEVRON : 0) > avail) break;
        used += w;
        count++;
      }
      setVisibleCount(count);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [entries]);

  // ── Overlay state (folder popover / context menu / edit popover) ────────────
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [edit, setEdit] = useState<Bookmark | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  const anyOverlay = openFolder !== null || overflowOpen || menu !== null || edit !== null;

  // Rule #3 — suspend the native view while any overlay is up (ref-counted).
  useEffect(() => {
    if (!anyOverlay) return;
    suspendBrowserPane();
    return () => resumeBrowserPane();
  }, [anyOverlay]);

  // Esc closes the topmost overlay.
  useEffect(() => {
    if (!anyOverlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (edit) setEdit(null);
      else if (menu) setMenu(null);
      else if (openFolder) setOpenFolder(null);
      else if (overflowOpen) setOverflowOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [anyOverlay, edit, menu, openFolder, overflowOpen]);

  if (!bookmarkBarVisible) return null;

  const open = (url: string) => {
    if (activeTabId) navigate(activeTabId, url);
    else void createTab('user', url);
  };
  const openInNewTab = (url: string) => void createTab('user', url);
  const copyUrl = (url: string) => void navigator.clipboard?.writeText(url);

  // Entry-level drag reorder (mirrors the tab strip: dragStart marks the source,
  // dragOver previews, drop reorders). Folders move as a unit; the flattened id
  // list (folder → its members) is persisted so sort_order stays contiguous.
  const onDropEntry = (targetIdx: number) => {
    const src = draggingKey;
    setDraggingKey(null);
    if (!src) return;
    const from = entries.findIndex((e) => entryKey(e) === src);
    if (from < 0 || from === targetIdx) return;
    const reordered = [...entries];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(targetIdx, 0, moved);
    const flatIds = reordered.flatMap((e) =>
      e.kind === 'bookmark' ? [e.bookmark.id] : e.items.map((b) => b.id),
    );
    reorderBookmark(flatIds);
  };

  const draggable = entries.length > 1;

  // Shared chip renderer (used by both the visible bar and the offscreen measurer).
  const renderEntry = (entry: Entry, idx: number, live: boolean) => {
    const dragProps = live
      ? {
          draggable,
          onDragStart: () => setDraggingKey(entryKey(entry)),
          onDragEnd: () => setDraggingKey(null),
          onDragOver: (e: React.DragEvent) => {
            if (draggable) e.preventDefault();
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            onDropEntry(idx);
          },
        }
      : {};
    const dim = live && draggingKey === entryKey(entry) ? 'opacity-50' : '';

    if (entry.kind === 'folder') {
      return (
        <button
          key={`f:${entry.name}`}
          data-bm-item
          {...dragProps}
          onClick={() => live && setOpenFolder((v) => (v === entry.name ? null : entry.name))}
          title={`${entry.name} (${entry.items.length})`}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] text-fg-primary hover:bg-[var(--color-tab-hover-bg)] transition-colors max-w-[180px] shrink-0 ${dim}`}
        >
          <Icons.Folder className="w-3.5 h-3.5 text-fg-secondary shrink-0" />
          <span className="truncate">{entry.name}</span>
          <Icons.ChevronDown className="w-3 h-3 text-fg-muted shrink-0" />
        </button>
      );
    }

    const mark = entry.bookmark;
    return (
      <button
        key={mark.id}
        data-bm-item
        {...dragProps}
        onClick={() => live && open(mark.url)}
        onAuxClick={(e) => {
          if (live && e.button === 1) {
            e.preventDefault();
            openInNewTab(mark.url);
          }
        }}
        onContextMenu={(e) => {
          if (!live) return;
          e.preventDefault();
          setMenu({ mark, x: e.clientX, y: e.clientY });
        }}
        title={`${mark.title || hostLabel(mark.url)}\n${mark.url}`}
        className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] text-fg-primary hover:bg-[var(--color-tab-hover-bg)] transition-colors max-w-[180px] shrink-0 ${dim}`}
      >
        <ChipIcon mark={mark} />
        <span className="truncate">{mark.title || hostLabel(mark.url)}</span>
      </button>
    );
  };

  const visible = entries.slice(0, visibleCount);
  const overflow = entries.slice(visibleCount);
  const openFolderEntry = entries.find((e) => e.kind === 'folder' && e.name === openFolder) as
    | Extract<Entry, { kind: 'folder' }>
    | undefined;

  return (
    <div className="bookmark-bar shrink-0 relative">
      {bookmarks.length === 0 ? (
        <span className="text-[11px] text-fg-muted px-1 select-none">
          No bookmarks yet — use the star to add one.
        </span>
      ) : (
        <div ref={containerRef} className="flex items-center gap-1 overflow-hidden flex-1 min-w-0">
          {visible.map((entry, i) => renderEntry(entry, i, true))}
          {overflow.length > 0 && (
            <button
              onClick={() => setOverflowOpen((v) => !v)}
              title={`${overflow.length} more`}
              aria-label={`${overflow.length} more bookmarks`}
              className="flex items-center px-1.5 py-0.5 rounded text-[12px] text-fg-secondary hover:bg-[var(--color-tab-hover-bg)] shrink-0"
            >
              <Icons.ChevronsRight className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* Offscreen measurement row — every entry rendered to capture widths. */}
      <div
        ref={measureRef}
        aria-hidden
        className="absolute invisible pointer-events-none flex items-center gap-1 left-0 top-0"
      >
        {entries.map((entry, i) => renderEntry(entry, i, false))}
      </div>

      {/* Overflow chevron menu — entries that didn't fit. */}
      {overflowOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOverflowOpen(false)} />
          <div
            role="menu"
            className="absolute right-1 top-full mt-1 z-50 min-w-[200px] max-h-[60vh] overflow-auto rounded-md border border-[var(--color-browser-divider)] bg-[var(--color-surface-0)] shadow-lg py-1"
          >
            {overflow.map((entry) =>
              entry.kind === 'folder' ? (
                <button
                  key={`of:${entry.name}`}
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    setOpenFolder(entry.name);
                  }}
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px] text-fg-primary hover:bg-[var(--color-tab-hover-bg)]"
                >
                  <Icons.Folder className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ) : (
                <button
                  key={`ob:${entry.bookmark.id}`}
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    open(entry.bookmark.url);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setOverflowOpen(false);
                    setMenu({ mark: entry.bookmark, x: e.clientX, y: e.clientY });
                  }}
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px] text-fg-primary hover:bg-[var(--color-tab-hover-bg)]"
                >
                  <ChipIcon mark={entry.bookmark} />
                  <span className="truncate">
                    {entry.bookmark.title || hostLabel(entry.bookmark.url)}
                  </span>
                </button>
              ),
            )}
          </div>
        </>
      )}

      {/* Folder child popover. */}
      {openFolderEntry && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpenFolder(null)} />
          <div
            role="menu"
            aria-label={`${openFolderEntry.name} bookmarks`}
            className="absolute left-1 top-full mt-1 z-50 min-w-[220px] max-h-[60vh] overflow-auto rounded-md border border-[var(--color-browser-divider)] bg-[var(--color-surface-0)] shadow-lg py-1"
          >
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-fg-muted">
              {openFolderEntry.name}
            </div>
            {openFolderEntry.items.map((mark) => (
              <button
                key={mark.id}
                role="menuitem"
                onClick={() => {
                  setOpenFolder(null);
                  open(mark.url);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    setOpenFolder(null);
                    openInNewTab(mark.url);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ mark, x: e.clientX, y: e.clientY });
                }}
                title={`${mark.title || hostLabel(mark.url)}\n${mark.url}`}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px] text-fg-primary hover:bg-[var(--color-tab-hover-bg)]"
              >
                <ChipIcon mark={mark} />
                <span className="truncate">{mark.title || hostLabel(mark.url)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Right-click context menu. */}
      {menu && (
        <>
          <div
            className="fixed inset-0 z-50"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            role="menu"
            aria-label="Bookmark actions"
            className="fixed z-50 min-w-[200px] rounded-md border border-[var(--color-browser-divider)] bg-[var(--color-surface-0)] shadow-lg py-1 text-[12px]"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              role="menuitem"
              onClick={() => {
                setEdit(menu.mark);
                setMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-fg-primary hover:bg-[var(--color-tab-hover-bg)]"
            >
              <Icons.Pencil className="w-3.5 h-3.5 shrink-0" /> Edit…
            </button>
            <button
              role="menuitem"
              onClick={() => {
                openInNewTab(menu.mark.url);
                setMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-fg-primary hover:bg-[var(--color-tab-hover-bg)]"
            >
              <Icons.ExternalLink className="w-3.5 h-3.5 shrink-0" /> Open in new tab
            </button>
            <button
              role="menuitem"
              onClick={() => {
                copyUrl(menu.mark.url);
                setMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-fg-primary hover:bg-[var(--color-tab-hover-bg)]"
            >
              <Icons.Copy className="w-3.5 h-3.5 shrink-0" /> Copy URL
            </button>
            <button
              role="menuitem"
              onClick={() => {
                removeBookmark(menu.mark.id);
                setMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-accent-red hover:bg-[var(--color-tab-hover-bg)]"
            >
              <Icons.Trash2 className="w-3.5 h-3.5 shrink-0" /> Remove
            </button>
          </div>
        </>
      )}

      {/* Edit popover (rename + move folder) — context-menu "Edit…". */}
      {edit && (
        <EditPopover
          mark={edit}
          folders={folderNames}
          onClose={() => setEdit(null)}
          onSave={async (patch) => {
            await updateBookmark(edit.id, patch);
            setEdit(null);
          }}
        />
      )}
    </div>
  );
}

const NEW_FOLDER = '__new__';

function EditPopover({
  mark,
  folders,
  onClose,
  onSave,
}: {
  mark: Bookmark;
  folders: string[];
  onClose: () => void;
  onSave: (patch: { title?: string; folder?: string | null }) => void | Promise<void>;
}) {
  const [title, setTitle] = useState(mark.title);
  const [folder, setFolder] = useState(mark.folder ?? '');
  const [newFolder, setNewFolder] = useState('');

  const save = () => {
    const resolved = folder === NEW_FOLDER ? newFolder.trim() || null : folder.trim() || null;
    void onSave({ title: title.trim() || mark.url, folder: resolved });
  };

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Edit bookmark"
        className="browser-popover browser-popover-anim absolute left-1 top-full mt-1 z-50 w-72 p-3 flex flex-col gap-2"
      >
        <div className="text-[11px] font-semibold text-fg-primary">Edit bookmark</div>
        <label className="text-[10px] uppercase tracking-wide text-fg-muted">Name</label>
        <input
          type="text"
          value={title}
          autoFocus
          spellCheck={false}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            else if (e.key === 'Escape') onClose();
          }}
          className="bg-browser-chrome-2 border border-tab-border px-2 py-1 text-[12px] text-fg-primary focus:outline-none focus:border-accent-blue/60 rounded"
        />
        <label className="text-[10px] uppercase tracking-wide text-fg-muted">Folder</label>
        <select
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
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
        {folder === NEW_FOLDER && (
          <input
            type="text"
            value={newFolder}
            placeholder="Folder name"
            spellCheck={false}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              else if (e.key === 'Escape') onClose();
            }}
            className="bg-browser-chrome-2 border border-tab-border px-2 py-1 text-[12px] text-fg-primary focus:outline-none focus:border-accent-blue/60 rounded"
          />
        )}
        <div className="text-[10px] text-fg-muted truncate" title={mark.url}>
          {mark.url}
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="ui-btn ui-btn-ghost px-2 py-1 text-[11px]">
            Cancel
          </button>
          <button onClick={save} className="ui-btn ui-btn-outline px-3 py-1 text-[11px]">
            Save
          </button>
        </div>
      </div>
    </>
  );
}
