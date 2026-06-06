import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Icons from 'lucide-react';
import type { DirectoryEntry, PathType } from '../../../shared/types';
import DirectoryTreeNode, { sortEntries, FS_RELIST_DEBOUNCE_MS } from './DirectoryTreeNode';
import FileContextMenu, { type TreeSortMode } from '../shared/FileContextMenu';
import { useNamePrompt } from '../../hooks/useNamePrompt';
import { useDashboardStore } from '../../stores/dashboard-store';
import { TREE_ENTRY_MIME } from '../../utils/drag-file';

function parentPathOf(entryPath: string): string {
  const slash = Math.max(entryPath.lastIndexOf('/'), entryPath.lastIndexOf('\\'));
  if (slash === 0) return '/';
  if (slash > 0) return entryPath.slice(0, slash);
  return entryPath;
}

interface Props {
  rootPath: string;
  pathType: PathType;
  activeFilePath: string | null;
  onFileSelect: (filePath: string) => void;
}

export default function DirectoryTree({ rootPath, pathType, activeFilePath, onFileSelect }: Props) {
  const [rootEntries, setRootEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const [rootContextMenu, setRootContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isRootDropTarget, setIsRootDropTarget] = useState(false);
  const [sortMode, setSortMode] = useState<TreeSortMode>('name');
  const cache = useRef(new Map<string, DirectoryEntry[]>());
  const { prompt: promptName, modal: namePromptModal } = useNamePrompt();
  const checkHealth = useDashboardStore((s) => s.checkHealth);
  const renameTabPath = useDashboardStore((s) => s.renameTabPath);
  const hasDirtyTabForPath = useDashboardStore((s) => s.hasDirtyTabForPath);

  const reloadRoot = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    cache.current.delete(rootPath);
    const entries = await window.api.files.listDirectory(rootPath, pathType);
    cache.current.set(rootPath, entries);
    setRootEntries(entries);
    setLoading(false);
    if (pathType === 'wsl') {
      void checkHealth();
    }
  }, [rootPath, pathType, checkHealth]);

  const invalidateDir = useCallback((dirPath: string) => {
    cache.current.delete(dirPath);
  }, []);

  const handleRefresh = useCallback(() => {
    cache.current.clear();
    setRefreshTick((n) => n + 1);
  }, []);

  const createFileAtRoot = useCallback(async (template: 'text' | 'markdown' | 'notebook', label: string, ext?: string) => {
    const rawName = await promptName({ title: label, okLabel: 'Create' });
    if (rawName === null) return;
    const trimmed = rawName.trim();
    if (!trimmed) return;
    const name = ext && !trimmed.toLowerCase().endsWith(ext) ? `${trimmed}${ext}` : trimmed;
    const result = await window.api.files.createFile(rootPath, rootPath, pathType, name, template);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    await reloadRoot();
    if (result.path) onFileSelect(result.path);
  }, [onFileSelect, pathType, promptName, reloadRoot, rootPath]);

  const createFolderAtRoot = useCallback(async () => {
    const rawName = await promptName({ title: 'New folder name', okLabel: 'Create' });
    if (rawName === null) return;
    const name = rawName.trim();
    if (!name) return;
    const result = await window.api.files.mkdir(rootPath, rootPath, pathType, name);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    await reloadRoot();
  }, [pathType, promptName, reloadRoot, rootPath]);

  const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setRootContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(TREE_ENTRY_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsRootDropTarget(true);
  }, []);

  const handleRootDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setIsRootDropTarget(false);
  }, []);

  const handleRootDrop = useCallback(async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(TREE_ENTRY_MIME)) return;
    e.preventDefault();
    setIsRootDropTarget(false);
    const raw = e.dataTransfer.getData(TREE_ENTRY_MIME);
    if (!raw) return;
    let payload: { path: string; isDirectory: boolean };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload.path) return;
    if (hasDirtyTabForPath(payload.path) &&
        !window.confirm('That item has unsaved changes in an open tab. Move anyway?')) {
      return;
    }
    const result = await window.api.files.move(payload.path, rootPath, pathType, rootPath);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    if (result.path) renameTabPath(payload.path, result.path);
    cache.current.delete(parentPathOf(payload.path));
    cache.current.delete(rootPath);
    await reloadRoot();
  }, [hasDirtyTabForPath, pathType, reloadRoot, renameTabPath, rootPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
        handleRefresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleRefresh]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    cache.current.clear();
    window.api.files.listDirectory(rootPath, pathType).then((entries) => {
      if (!cancelled) {
        cache.current.set(rootPath, entries);
        setRootEntries(entries);
        setLoading(false);
        if (pathType === 'wsl') {
          void checkHealth();
        }
      }
    });
    return () => { cancelled = true; };
  }, [rootPath, pathType, refreshTick, checkHealth]);

  useEffect(() => {
    if (!rootPath) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // Re-list on any watch event instead of patching entries in place: a
    // fresh listing carries timestamps for new files and keeps the cache
    // consistent. Silent (no loading spinner) so the tree doesn't flicker.
    const unsub = window.api.files.watchDirectory(rootPath, pathType, () => {
      if (timer !== null) return;
      timer = setTimeout(async () => {
        timer = null;
        cache.current.delete(rootPath);
        const entries = await window.api.files.listDirectory(rootPath, pathType);
        if (cancelled) return;
        cache.current.set(rootPath, entries);
        setRootEntries(entries);
      }, FS_RELIST_DEBOUNCE_MS);
    });
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      unsub();
    };
  }, [rootPath, pathType, refreshTick]);

  const loadChildren = useCallback(async (dirPath: string): Promise<DirectoryEntry[]> => {
    const cached = cache.current.get(dirPath);
    if (cached) return cached;
    const entries = await window.api.files.listDirectory(dirPath, pathType);
    cache.current.set(dirPath, entries);
    if (pathType === 'wsl') {
      void checkHealth();
    }
    return entries;
  }, [pathType, checkHealth]);

  // Extract the root folder name from path
  const rootName = rootPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || rootPath;

  return (
    <div
      className="h-full flex flex-col border-r dark:border-white/10 light:border-black/10 bg-surface-0/40"
      onContextMenu={handleRootContextMenu}
    >
      <div className="px-3 py-2 border-b dark:border-white/10 light:border-black/10 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-sans   text-gray-300">Explorer</div>
          <div className="text-[13px] font-sans text-accent-blue/70 truncate mt-0.5" title={rootPath}>
            {rootName}
          </div>
        </div>
        <button
          onClick={handleRefresh}
          title="Refresh (F5)"
          className="shrink-0 p-1 rounded text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <Icons.RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div
        key={refreshTick}
        className={`flex-1 overflow-y-auto overflow-x-hidden py-1 scrollbar-thin ${
          isRootDropTarget ? 'ring-1 ring-inset ring-accent-blue/40' : ''
        }`}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
      >
        {loading ? (
          <div className="px-3 py-4 text-[13px] text-gray-400 font-sans animate-pulse">Loading...</div>
        ) : rootEntries.length === 0 ? (
          <div className="px-3 py-4 text-[13px] text-gray-400 font-sans">Empty directory</div>
        ) : (
          sortEntries(rootEntries, sortMode).map((entry) => (
            <DirectoryTreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              activeFilePath={activeFilePath}
              pathType={pathType}
              workingDirectory={rootPath}
              sortMode={sortMode}
              onSortModeChange={setSortMode}
              onFileSelect={onFileSelect}
              loadChildren={loadChildren}
              onTreeChanged={invalidateDir}
              onSiblingsChanged={reloadRoot}
              promptName={promptName}
            />
          ))
        )}
      </div>
      {rootContextMenu && (
        <FileContextMenu
          x={rootContextMenu.x}
          y={rootContextMenu.y}
          filePath={rootPath}
          workingDirectory={rootPath}
          pathType={pathType}
          isDirectory
          showRevealInTree={false}
          onClose={() => setRootContextMenu(null)}
          onCreateFile={() => createFileAtRoot('text', 'New file name')}
          onCreateMarkdownFile={() => createFileAtRoot('markdown', 'New Markdown file name', '.md')}
          onCreateNotebook={() => createFileAtRoot('notebook', 'New notebook name', '.ipynb')}
          onCreateFolder={createFolderAtRoot}
          sortMode={sortMode}
          onSortModeChange={setSortMode}
        />
      )}
      {namePromptModal}
    </div>
  );
}
