import { useState, useEffect } from 'react';
import type { FileContent, FsEvent, PathType } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';

// Module-level cache: tabId -> FileContent
const contentCache = new Map<string, FileContent>();

export function evictTabCache(tabId: string) {
  contentCache.delete(tabId);
}

export function evictAllCache() {
  contentCache.clear();
}

function parentDirOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (idx <= 0) return filePath;
  return filePath.substring(0, idx);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function useFileContentCache(tabId: string, filePath: string, pathType: PathType, skip = false) {
  const [content, setContent] = useState<FileContent | null>(() => skip ? null : (contentCache.get(tabId) || null));
  const [loading, setLoading] = useState(!skip && !contentCache.has(tabId));
  const checkHealth = useDashboardStore((s) => s.checkHealth);

  useEffect(() => {
    if (!filePath || skip) {
      setContent(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    // Re-read the file from disk and, if it differs from the cache, swap the
    // fresh content into both the cache and this hook's state. Shared by the
    // fs-watcher handler and the on-mount revalidation pass below.
    const revalidate = () => {
      window.api.files.readFile(filePath, pathType).then((fresh) => {
        if (cancelled) return;
        if (fresh.error) return;

        const cachedNow = contentCache.get(tabId);
        if (cachedNow && cachedNow.path === filePath && cachedNow.content === fresh.content) {
          // Cache already matches disk, but local state may lag behind the
          // shared cache (e.g., another pass updated it first) — sync it so
          // the renderer never displays older content than the cache holds.
          setContent((prev) => (prev === cachedNow ? prev : cachedNow));
          return;
        }
        const store = useDashboardStore.getState();
        const editState = store.tabEditState[tabId];
        if (editState && editState.originalContent === fresh.content && !editState.dirty) {
          // Echo of the content we just saved from the editor.
          contentCache.set(tabId, fresh);
          return;
        }

        contentCache.set(tabId, fresh);

        if (editState && editState.mode === 'edit') {
          // Don't trample the editor while the user has it open.
          // Surface a banner so they can choose to reload or keep edits.
          store.markExternalChange(tabId, fresh.content);
        } else {
          setContent(fresh);
          if (editState) {
            // View mode but a stale editState lingers from a prior edit session —
            // bring originalContent in line with disk so renderedContent reflects it.
            store.refreshOriginalContent(tabId, fresh.content);
          }
        }
      });
    };

    const cached = contentCache.get(tabId);
    if (cached && cached.path === filePath) {
      setContent(cached);
      setLoading(false);
      // The watcher below only covers changes that land while this hook is
      // mounted. An edit that arrived while another tab was active (the
      // content area is unmounted on tab switch) leaves the cache stale, so
      // switching back must revalidate against disk — otherwise the tab
      // shows old content until it's closed and reopened.
      revalidate();
    } else {
      setLoading(true);
      window.api.files.readFile(filePath, pathType).then((result) => {
        if (cancelled) return;
        contentCache.set(tabId, result);
        setContent(result);
        setLoading(false);
        if (pathType === 'wsl') {
          void checkHealth();
        }
      });
    }

    // Watch the parent directory and react to changes to this file. Lets the
    // viewer pick up external edits (e.g., an agent writing to the file)
    // without requiring the tab to be closed and reopened.
    const parentDir = parentDirOf(filePath);
    const targetKey = normalizePath(filePath);

    const handleFsEvent = (event: FsEvent) => {
      if (cancelled) return;
      if (event.type === 'unlink') return;
      if (normalizePath(event.path) !== targetKey) return;
      revalidate();
    };

    const unsubscribe = window.api.files.watchDirectory(parentDir, pathType, handleFsEvent);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [tabId, filePath, pathType, skip, checkHealth]);

  return { content, loading };
}
