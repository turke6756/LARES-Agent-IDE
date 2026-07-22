import { useState, useEffect } from 'react';
import type { FileContent, FsEvent, PathType } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import { contentHash } from './markdownSplice';
import { diag, diagBasename, diagHash } from './editLossDiag';

// DIAG(edit-loss): read-ordering diagnostic only — a module-level counter so
// overlapping reads can be told apart in the log (Phase 3 replaces this with a
// real generation check). Purely observational in Phase 0.
let diagReadSeq = 0;

/** Why a revalidate pass ran (DIAG threading; no behavioral use in Phase 0). */
type RevalidateCause = 'watcher' | 'cached-mount' | 'initial';

// Module-level cache: tabId -> FileContent
const contentCache = new Map<string, FileContent>();

export function evictTabCache(tabId: string) {
  contentCache.delete(tabId);
}

export function evictAllCache() {
  contentCache.clear();
}

// ── Write-generation token (WP1-A task 6, plan §5) ─────────────────────────
// saveTab records the content it is about to write here *before* invoking
// files:write; revalidate drops fs events whose fresh content matches a
// recent write. This closes the echo race where the watcher fires before
// saveTab's async originalContent update lands (the old equality check below
// could observe stale state and surface a bogus external-change banner).
//
// The hash is the pure `contentHash` from markdownSplice — the app-wide
// selection primitive reuses the same function for comment doc_hash, so the
// two must never diverge.
const RECENT_WRITE_TTL_MS = 10_000;
const recentWrites = new Map<string, Array<{ hash: string; ts: number }>>();

export function recordRecentWrite(tabId: string, content: string): void {
  const now = Date.now();
  const live = (recentWrites.get(tabId) ?? []).filter(
    (e) => now - e.ts < RECENT_WRITE_TTL_MS,
  );
  live.push({ hash: contentHash(content), ts: now });
  recentWrites.set(tabId, live);
}

export function isRecentWriteEcho(tabId: string, content: string): boolean {
  const entries = recentWrites.get(tabId);
  if (!entries) return false;
  const now = Date.now();
  const live = entries.filter((e) => now - e.ts < RECENT_WRITE_TTL_MS);
  if (live.length === 0) {
    recentWrites.delete(tabId);
    return false;
  }
  recentWrites.set(tabId, live);
  const hash = contentHash(content);
  return live.some((e) => e.hash === hash);
}

// ── Fresh-content handler seam (WP1-A task 5, plan §5) ─────────────────────
// An editor can register a per-tab handler that is consulted before the
// default setContent/markExternalChange paths when revalidate sees changed
// disk content. v1: the WYSIWYG editor returns 'conflict' when dirty (banner)
// and 'fallback' when clean (content swap + baseline refresh); 'handled'
// means the handler applied the change itself (Phase 3: ProseMirror
// transaction) and only the cache should be updated.
export type FreshContentVerdict = 'handled' | 'conflict' | 'fallback';
export type FreshContentHandler = (freshContent: string) => FreshContentVerdict;

const freshContentHandlers = new Map<string, FreshContentHandler>();

export function registerFreshContentHandler(
  tabId: string,
  handler: FreshContentHandler,
): () => void {
  freshContentHandlers.set(tabId, handler);
  return () => {
    // A stale disposer (from a previous registration) must not remove a
    // newer handler registered for the same tab.
    if (freshContentHandlers.get(tabId) === handler) {
      freshContentHandlers.delete(tabId);
    }
  };
}

export function consultFreshContentHandler(
  tabId: string,
  freshContent: string,
): FreshContentVerdict | null {
  const handler = freshContentHandlers.get(tabId);
  return handler ? handler(freshContent) : null;
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
    const revalidate = (cause: RevalidateCause) => {
      // DIAG(edit-loss): entry — cause + read ordering (overlapping reads have
      // no generation control in Phase 0; readGen just names them in the log).
      const readGen = ++diagReadSeq;
      diag('revalidate-entry', { tabId, file: diagBasename(filePath), cause, readGen });
      window.api.files.readFile(filePath, pathType).then((fresh) => {
        if (cancelled) return;
        if (fresh.error) return;

        const cachedNow = contentCache.get(tabId);
        if (cachedNow && cachedNow.path === filePath && cachedNow.content === fresh.content) {
          // Cache already matches disk, but local state may lag behind the
          // shared cache (e.g., another pass updated it first) — sync it so
          // the renderer never displays older content than the cache holds.
          // DIAG(edit-loss): guard 1 terminated — cache already matches disk.
          diag('revalidate-cache-match', {
            tabId, cause, readGen,
            freshHash: diagHash(fresh.content),
          });
          setContent((prev) => (prev === cachedNow ? prev : cachedNow));
          return;
        }
        // Write-generation token: drop watcher echoes of our own saves before
        // any state-based checks (originalContent may not be updated yet).
        if (isRecentWriteEcho(tabId, fresh.content)) {
          // DIAG(edit-loss): guard 2 terminated — recent-write echo token.
          diag('revalidate-write-echo', {
            tabId, cause, readGen,
            freshHash: diagHash(fresh.content),
            cachedHash: diagHash(cachedNow?.content),
          });
          contentCache.set(tabId, fresh);
          return;
        }
        const store = useDashboardStore.getState();
        const editState = store.tabEditState[tabId];
        if (editState && editState.originalContent === fresh.content && !editState.dirty) {
          // Echo of the content we just saved from the editor.
          // DIAG(edit-loss): guard 3 terminated — bytes match originalContent
          // while clean (note the !dirty restriction — H2b's leak point).
          diag('revalidate-original-match', {
            tabId, cause, readGen,
            freshHash: diagHash(fresh.content),
            originalHash: diagHash(editState.originalContent),
          });
          contentCache.set(tabId, fresh);
          return;
        }

        contentCache.set(tabId, fresh);

        // A registered per-tab handler (the WYSIWYG editor) gets first say.
        const verdict = consultFreshContentHandler(tabId, fresh.content);
        // DIAG(edit-loss): guard 4 — handler verdict branch taken, with the
        // fresh/cached/original hashes and read generation at completion.
        if (verdict !== null) {
          diag('revalidate-handler-verdict', {
            tabId, cause, readGen, verdict,
            freshHash: diagHash(fresh.content),
            cachedHash: diagHash(cachedNow?.content),
            originalHash: diagHash(editState?.originalContent),
            storeDirty: !!editState?.dirty,
          });
        }
        if (verdict === 'handled') {
          return;
        }
        if (verdict === 'conflict') {
          store.markExternalChange(tabId, fresh.content);
          return;
        }
        if (verdict === 'fallback') {
          // Content swap + baseline refresh (refreshOriginalContent is a
          // no-op if the tab went dirty between the handler call and here).
          setContent(fresh);
          store.refreshOriginalContent(tabId, fresh.content);
          return;
        }

        // DIAG(edit-loss): guard 5 — no handler registered.
        diag('revalidate-no-handler', {
          tabId, cause, readGen,
          branch: editState && editState.mode !== 'view' ? 'banner' : 'content-swap',
          freshHash: diagHash(fresh.content),
          cachedHash: diagHash(cachedNow?.content),
          originalHash: diagHash(editState?.originalContent),
          storeDirty: !!editState?.dirty,
        });
        if (editState && editState.mode !== 'view') {
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
      revalidate('cached-mount');
    } else {
      setLoading(true);
      // DIAG(edit-loss): initial uncached read (no guard chain — direct swap).
      const readGen = ++diagReadSeq;
      diag('revalidate-entry', { tabId, file: diagBasename(filePath), cause: 'initial', readGen });
      window.api.files.readFile(filePath, pathType).then((result) => {
        if (cancelled) return;
        // DIAG(edit-loss): initial read completed and installed unconditionally.
        diag('initial-read-installed', {
          tabId, readGen,
          freshHash: result.error ? null : diagHash(result.content),
          error: !!result.error,
        });
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
      revalidate('watcher');
    };

    const unsubscribe = window.api.files.watchDirectory(parentDir, pathType, handleFsEvent);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [tabId, filePath, pathType, skip, checkHealth]);

  return { content, loading };
}
