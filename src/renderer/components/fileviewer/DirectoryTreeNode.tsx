import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { DirectoryEntry, PathType } from '../../../shared/types';
import FileContextMenu, { type TreeSortMode } from '../shared/FileContextMenu';
import * as Icons from 'lucide-react';
import FileIcon from './FileIcon';
import { treeEntryDragStart, TREE_ENTRY_MIME } from '../../utils/drag-file';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { PromptName } from '../../hooks/useNamePrompt';

/** Re-order a name-sorted listing for the tree's active sort mode.
 *  Directories always stay grouped before files. */
export function sortEntries(entries: DirectoryEntry[], mode: TreeSortMode): DirectoryEntry[] {
  if (mode === 'name') return entries; // main process already sorts dirs-first, alpha
  const sorted = [...entries];
  sorted.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    const aTime = (mode === 'modified' ? a.mtimeMs : a.birthtimeMs) ?? 0;
    const bTime = (mode === 'modified' ? b.mtimeMs : b.birthtimeMs) ?? 0;
    if (aTime !== bTime) return bTime - aTime; // newest first
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return sorted;
}

function formatCompactTime(ms: number | undefined): string | null {
  if (!ms) return null;
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

/** Debounce window for re-listing a directory after fs watch events.
 *  Events are already batched ~50ms in the main process; this coalesces
 *  bursts (e.g. an agent writing many files) into a single re-list. */
export const FS_RELIST_DEBOUNCE_MS = 150;

interface Props {
  entry: DirectoryEntry;
  depth: number;
  activeFilePath: string | null;
  pathType: PathType;
  workingDirectory: string;
  sortMode: TreeSortMode;
  onSortModeChange: (mode: TreeSortMode) => void;
  onFileSelect: (filePath: string) => void;
  loadChildren: (dirPath: string) => Promise<DirectoryEntry[]>;
  onTreeChanged: (dirPath: string) => void;
  onSiblingsChanged: () => void | Promise<void>;
  promptName: PromptName;
}

function parentPath(entryPath: string): string {
  const slash = Math.max(entryPath.lastIndexOf('/'), entryPath.lastIndexOf('\\'));
  if (slash === 0) return '/';
  if (slash > 0) return entryPath.slice(0, slash);
  return entryPath;
}

function ensureExtension(name: string, ext: string): string {
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
}

function DirectoryTreeNode({
  entry,
  depth,
  activeFilePath,
  pathType,
  workingDirectory,
  sortMode,
  onSortModeChange,
  onFileSelect,
  loadChildren,
  onTreeChanged,
  onSiblingsChanged,
  promptName,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirectoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTabsForPath = useDashboardStore((state) => state.closeTabsForPath);
  const renameTabPath = useDashboardStore((state) => state.renameTabPath);
  const hasDirtyTabForPath = useDashboardStore((state) => state.hasDirtyTabForPath);

  const isActive = activeFilePath === entry.path;

  const handleClick = useCallback(() => {
    if (entry.isDirectory) {
      // Directories: toggle immediately, no debounce
      if (!expanded) {
        if (children === null) {
          setLoading(true);
          loadChildren(entry.path).then((items) => {
            setChildren(items);
            setLoading(false);
          });
        } else {
          // Children can be stale: the watch subscription is only active
          // while expanded, so anything created while collapsed was missed.
          // Refresh in the background (old children stay visible meanwhile).
          onTreeChanged(entry.path);
          loadChildren(entry.path).then(setChildren);
        }
      }
      setExpanded(!expanded);
      return;
    }

    // Files: debounce single click for double-click detection
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      return; // double-click handler will fire
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      onFileSelect(entry.path);
    }, 250);
  }, [entry, expanded, children, onFileSelect, loadChildren, onTreeChanged]);

  const handleDoubleClick = useCallback(() => {
    if (entry.isDirectory) return;
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    window.api.system.openFileInWorkspace(entry.path, workingDirectory, pathType);
  }, [entry, workingDirectory, pathType]);

  const childrenLoaded = children !== null;
  useEffect(() => {
    if (!entry.isDirectory || !expanded || !childrenLoaded) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // Re-list on any watch event instead of patching entries in place: a
    // fresh listing carries timestamps for new files and keeps the shared
    // directory cache in DirectoryTree consistent with what is displayed.
    const unsub = window.api.files.watchDirectory(entry.path, pathType, () => {
      if (timer !== null) return;
      timer = setTimeout(async () => {
        timer = null;
        onTreeChanged(entry.path); // invalidate cache before re-listing
        const items = await loadChildren(entry.path);
        if (!cancelled) setChildren(items);
      }, FS_RELIST_DEBOUNCE_MS);
    });
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      unsub();
    };
  }, [entry.isDirectory, entry.path, pathType, expanded, childrenLoaded, loadChildren, onTreeChanged]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const reloadChildren = useCallback(async () => {
    if (!entry.isDirectory) return;
    setLoading(true);
    onTreeChanged(entry.path);
    try {
      const items = await loadChildren(entry.path);
      setChildren(items);
    } finally {
      setLoading(false);
    }
  }, [entry.isDirectory, entry.path, loadChildren, onTreeChanged]);

  const createFileInDirectory = useCallback(async (template: 'text' | 'markdown' | 'notebook', label: string, ext?: string) => {
    if (!entry.isDirectory) return;
    const rawName = await promptName({ title: label, okLabel: 'Create' });
    if (rawName === null) return;
    const name = ext ? ensureExtension(rawName.trim(), ext) : rawName.trim();
    if (!name) return;
    const result = await window.api.files.createFile(entry.path, workingDirectory, pathType, name, template);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    setExpanded(true);
    await reloadChildren();
    if (result.path) onFileSelect(result.path);
  }, [entry.isDirectory, entry.path, onFileSelect, pathType, promptName, reloadChildren, workingDirectory]);

  const createFolderInDirectory = useCallback(async () => {
    if (!entry.isDirectory) return;
    const rawName = await promptName({ title: 'New folder name', okLabel: 'Create' });
    if (rawName === null) return;
    const name = rawName.trim();
    if (!name) return;
    const result = await window.api.files.mkdir(entry.path, workingDirectory, pathType, name);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    setExpanded(true);
    await reloadChildren();
  }, [entry.isDirectory, entry.path, pathType, promptName, reloadChildren, workingDirectory]);

  const renameCurrentEntry = useCallback(async () => {
    if (hasDirtyTabForPath(entry.path)) {
      window.alert('Save or discard unsaved changes before renaming this item.');
      return;
    }
    const rawName = await promptName({
      title: `Rename "${entry.name}" to`,
      defaultValue: entry.name,
      okLabel: 'Rename',
    });
    if (rawName === null) return;
    const name = rawName.trim();
    if (!name || name === entry.name) return;
    const result = await window.api.files.rename(entry.path, workingDirectory, pathType, name);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    if (result.path) {
      renameTabPath(entry.path, result.path);
    }
    onTreeChanged(parentPath(entry.path));
    await onSiblingsChanged();
  }, [entry.name, entry.path, hasDirtyTabForPath, onSiblingsChanged, onTreeChanged, pathType, promptName, renameTabPath, workingDirectory]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!entry.isDirectory) return;
    if (!e.dataTransfer.types.includes(TREE_ENTRY_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setIsDropTarget(true);
  }, [entry.isDirectory]);

  const handleDragLeave = useCallback(() => {
    if (!entry.isDirectory) return;
    setIsDropTarget(false);
  }, [entry.isDirectory]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (!entry.isDirectory) return;
    if (!e.dataTransfer.types.includes(TREE_ENTRY_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDropTarget(false);
    const raw = e.dataTransfer.getData(TREE_ENTRY_MIME);
    if (!raw) return;
    let payload: { path: string; isDirectory: boolean };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload.path || payload.path === entry.path) return;
    if (hasDirtyTabForPath(payload.path) &&
        !window.confirm('That item has unsaved changes in an open tab. Move anyway?')) {
      return;
    }
    const result = await window.api.files.move(payload.path, workingDirectory, pathType, entry.path);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    if (result.path) renameTabPath(payload.path, result.path);
    onTreeChanged(parentPath(payload.path));
    onTreeChanged(entry.path);
    if (!expanded) {
      setExpanded(true);
      setLoading(true);
      try {
        const items = await loadChildren(entry.path);
        setChildren(items);
      } finally {
        setLoading(false);
      }
    }
    await onSiblingsChanged();
  }, [
    entry.isDirectory, entry.path, expanded, hasDirtyTabForPath, loadChildren,
    onSiblingsChanged, onTreeChanged, pathType, renameTabPath, workingDirectory,
  ]);

  const deleteCurrentEntry = useCallback(async () => {
    const confirmed = entry.isDirectory
      ? window.confirm(`Delete folder "${entry.name}" and everything inside it?`)
      : window.confirm(`Delete file "${entry.name}"?`);
    if (!confirmed) return;
    if (hasDirtyTabForPath(entry.path) && !window.confirm('This item has unsaved changes in an open tab. Delete anyway?')) {
      return;
    }
    const result = await window.api.files.deleteEntry(entry.path, workingDirectory, pathType, entry.isDirectory);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    closeTabsForPath(entry.path);
    onTreeChanged(parentPath(entry.path));
    await onSiblingsChanged();
  }, [closeTabsForPath, entry.isDirectory, entry.name, entry.path, hasDirtyTabForPath, onSiblingsChanged, onTreeChanged, pathType, workingDirectory]);

  const ChevronIcon = expanded ? Icons.ChevronDown : Icons.ChevronRight;

  const timeMs = sortMode === 'created' ? entry.birthtimeMs : entry.mtimeMs;
  const timeLabel = formatCompactTime(timeMs);

  return (
    <div>
      <button
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={(e) => treeEntryDragStart(e, entry.path, entry.isDirectory)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`w-full text-left flex items-center gap-1 py-[3px] px-2 text-[13px] font-sans transition-colors group ${
          isActive ? 'tree-row-selected' : isDropTarget ? 'bg-accent-blue/15 text-fg-primary' : 'tree-row-hover text-fg-primary'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px`, color: isActive ? undefined : 'var(--color-fg-primary)' }}
      >
        {entry.isDirectory ? (
          <>
            <span className="shrink-0 w-3.5 flex items-center justify-center" style={{ color: 'var(--color-fg-secondary)' }}>
              {loading ? (
                <Icons.Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <ChevronIcon className="w-3.5 h-3.5" />
              )}
            </span>
            <span className="shrink-0 w-4 flex items-center justify-center">
              <FileIcon name={entry.name} isDirectory isOpen={expanded} className="w-4 h-4" />
            </span>
          </>
        ) : (
          <>
            <span className="shrink-0 w-3.5" />
            <span className="shrink-0 w-4 flex items-center justify-center">
              <FileIcon name={entry.name} className="w-4 h-4" />
            </span>
          </>
        )}
        <span className="truncate">
          {entry.name}
        </span>
        {timeLabel && (
          <span
            className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums opacity-0 group-hover:opacity-100"
            style={{ color: 'var(--color-fg-secondary)', opacity: sortMode !== 'name' ? 0.8 : undefined }}
            title={new Date(timeMs!).toLocaleString()}
          >
            {timeLabel}
          </span>
        )}
      </button>
      {expanded && children && (
        <div className="border-l border-white/5 ml-[14px]">
          {sortEntries(children, sortMode).map((child) => (
            <DirectoryTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              activeFilePath={activeFilePath}
              pathType={pathType}
              workingDirectory={workingDirectory}
              sortMode={sortMode}
              onSortModeChange={onSortModeChange}
              onFileSelect={onFileSelect}
              loadChildren={loadChildren}
              onTreeChanged={onTreeChanged}
              onSiblingsChanged={reloadChildren}
              promptName={promptName}
            />
          ))}
        </div>
      )}

      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          filePath={entry.path}
          workingDirectory={workingDirectory}
          pathType={pathType}
          isDirectory={entry.isDirectory}
          showRevealInTree={false}
          onClose={() => setContextMenu(null)}
          onCreateFile={() => createFileInDirectory('text', 'New file name')}
          onCreateMarkdownFile={() => createFileInDirectory('markdown', 'New Markdown file name', '.md')}
          onCreateNotebook={() => createFileInDirectory('notebook', 'New notebook name', '.ipynb')}
          onCreateFolder={createFolderInDirectory}
          onRename={renameCurrentEntry}
          onDelete={deleteCurrentEntry}
          sortMode={sortMode}
          onSortModeChange={onSortModeChange}
        />
      )}
    </div>
  );
}

export default React.memo(DirectoryTreeNode);
