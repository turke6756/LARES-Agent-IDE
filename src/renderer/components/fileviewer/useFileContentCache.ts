import { useState, useEffect } from 'react';
import type { FileContent, FsEvent, PathType } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import { contentHash } from '../../../shared/content-hash';
import { diag, diagBasename, diagHash } from './editLossDiag';

/** Why a read pass ran (threaded through the shared read function). */
type RevalidateCause = 'watcher' | 'cached-mount' | 'initial';

// ── Generation-ordered reads (edit-loss Phase 3 §3.3) ──────────────────────
// Module-level so overlapping hook instances for the same target share one
// ordering authority: each read increments the generation for its key at
// start, and a resolution is discarded unless it is still the latest. Hook
// cleanup must NOT delete keys — an old instance's cleanup would clear a
// newer instance's in-flight generation. Entries are simply overwritten by
// the next read; an LRU cap bounds the map.
const READ_GEN_CAP = 256;
const readGen = new Map<string, number>();

function readGenKey(tabId: string, filePath: string, pathType: PathType): string {
  return `${tabId}::${normalizePath(filePath)}::${pathType}`;
}

function nextReadGeneration(key: string): number {
  const next = (readGen.get(key) ?? 0) + 1;
  // LRU touch: re-insert at the end so active keys survive the cap.
  readGen.delete(key);
  readGen.set(key, next);
  if (readGen.size > READ_GEN_CAP) {
    const oldest = readGen.keys().next().value;
    if (oldest !== undefined) readGen.delete(oldest);
  }
  return next;
}

// Module-level cache: tabId -> FileContent
const contentCache = new Map<string, FileContent>();

export function evictTabCache(tabId: string) {
  contentCache.delete(tabId);
}

export function evictAllCache() {
  contentCache.clear();
}

// ── Generation-token write ledger (edit-loss Phase 3 §3.2) ─────────────────
// Replaces the flat 10s recent-writes TTL. saveTab calls `beginWrite` with the
// hash of what it is about to write, then `commit()` on success or
// `invalidate()` on failure (R5 — a failed write must not leave a live echo
// token for bytes that never reached disk). `revalidate` consults
// `matchRecentWrite` to drop watcher echoes of our own saves, and uses the
// matched generation to supersede every older token
// (`dropWritesBelowGeneration`) — so an OLD saved hash arriving after a NEWER
// generation was disk-confirmed is a genuine regression and is NOT
// suppressed.
//
// The hash is the pure `contentHash` from markdownSplice — the app-wide
// selection primitive reuses the same function for comment doc_hash, so the
// two must never diverge.
interface WriteLedgerEntry {
  generation: number;
  hash: string;
  state: 'pending' | 'committed';
  ts: number;
}

export interface WriteToken {
  generation: number;
  commit(): void;
  invalidate(): void;
}

const WRITE_LEDGER_COMMITTED_TTL_MS = 5 * 60_000;
// A write neither committed nor invalidated after 30s is a bug — DIAG-log it.
const WRITE_LEDGER_PENDING_TTL_MS = 30_000;
const WRITE_LEDGER_MAX_COMMITTED = 8;

const writeLedger = new Map<string, WriteLedgerEntry[]>();
// Monotonic per-tab generation — never reset, even when the ledger empties.
const writeGenerations = new Map<string, number>();

function setLedgerEntries(tabId: string, entries: WriteLedgerEntry[]): void {
  if (entries.length === 0) writeLedger.delete(tabId);
  else writeLedger.set(tabId, entries);
}

/** GC one tab's ledger: pending >30s (DIAG-logged), committed >5min or >8. */
function pruneLedger(tabId: string, now: number): WriteLedgerEntry[] {
  const entries = writeLedger.get(tabId);
  if (!entries) return [];
  let live: WriteLedgerEntry[] = [];
  for (const e of entries) {
    if (e.state === 'pending' && now - e.ts >= WRITE_LEDGER_PENDING_TTL_MS) {
      // DIAG(edit-loss): a write that neither committed nor invalidated is a
      // bug in the save path — surface it, then drop the stuck token.
      diag('write-ledger-pending-expired', {
        tabId, generation: e.generation, hash: e.hash, ageMs: now - e.ts,
      });
      continue;
    }
    if (e.state === 'committed' && now - e.ts >= WRITE_LEDGER_COMMITTED_TTL_MS) {
      continue;
    }
    live.push(e);
  }
  const committed = live.filter((e) => e.state === 'committed');
  if (committed.length > WRITE_LEDGER_MAX_COMMITTED) {
    const drop = new Set(
      committed
        .slice()
        .sort((a, b) => a.generation - b.generation)
        .slice(0, committed.length - WRITE_LEDGER_MAX_COMMITTED)
        .map((e) => e.generation),
    );
    live = live.filter((e) => !drop.has(e.generation));
  }
  setLedgerEntries(tabId, live);
  return live;
}

export function beginWrite(tabId: string, hash: string): WriteToken {
  const now = Date.now();
  const generation = (writeGenerations.get(tabId) ?? 0) + 1;
  writeGenerations.set(tabId, generation);
  const live = pruneLedger(tabId, now);
  live.push({ generation, hash, state: 'pending', ts: now });
  setLedgerEntries(tabId, live);
  return {
    generation,
    commit() {
      const entry = writeLedger.get(tabId)?.find((e) => e.generation === generation);
      if (entry) {
        entry.state = 'committed';
        entry.ts = Date.now();
      }
    },
    invalidate() {
      // Removes THIS EXACT generation only — a failed later write never
      // disturbs an earlier committed token with the same hash.
      const entries = writeLedger.get(tabId);
      if (!entries) return;
      setLedgerEntries(tabId, entries.filter((e) => e.generation !== generation));
    },
  };
}

export function matchRecentWrite(
  tabId: string,
  hash: string,
): { generation: number; state: 'pending' | 'committed' } | null {
  const live = pruneLedger(tabId, Date.now());
  let best: WriteLedgerEntry | null = null;
  for (const e of live) {
    // Highest matching generation wins when several entries share a hash —
    // supersession is then deterministic.
    if (e.hash === hash && (!best || e.generation > best.generation)) best = e;
  }
  return best ? { generation: best.generation, state: best.state } : null;
}

/** Supersession (§3.2c): a disk-confirmed generation obsoletes older tokens. */
export function dropWritesBelowGeneration(tabId: string, generation: number): void {
  const entries = writeLedger.get(tabId);
  if (!entries) return;
  setLedgerEntries(tabId, entries.filter((e) => e.generation >= generation));
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
    const genKey = readGenKey(tabId, filePath, pathType);

    // ONE shared read function (edit-loss Phase 3 §3.3) for both the initial
    // uncached read and revalidate: each read takes a fresh generation for
    // this (tab, path, pathType) key, and its resolution is discarded unless
    // it is still the latest — a stale read resolving out of order (e.g. the
    // main process delivers a 50ms fs-event batch with no dedup,
    // ipc-handlers.ts:762-773) can never overwrite a newer read's content.
    const readFromDisk = (cause: RevalidateCause) => {
      const generation = nextReadGeneration(genKey);
      // DIAG(edit-loss): entry — cause + read generation.
      diag('revalidate-entry', { tabId, file: diagBasename(filePath), cause, readGen: generation });
      window.api.files.readFile(filePath, pathType).then((fresh) => {
        if (cancelled) return;
        if (readGen.get(genKey) !== generation) {
          // DIAG(edit-loss): generation guard — a newer read superseded this
          // one while it was in flight; discard the stale resolution (H2c).
          diag('read-discarded-stale', {
            tabId, cause, readGen: generation, latest: readGen.get(genKey),
          });
          return;
        }

        if (cause === 'initial') {
          // Initial uncached read: install unconditionally (including error
          // results — the viewer renders the error state).
          // DIAG(edit-loss): initial read completed and installed.
          diag('initial-read-installed', {
            tabId, readGen: generation,
            freshHash: fresh.error ? null : diagHash(fresh.content),
            error: !!fresh.error,
          });
          contentCache.set(tabId, fresh);
          setContent(fresh);
          setLoading(false);
          if (pathType === 'wsl') {
            void checkHealth();
          }
          return;
        }

        if (fresh.error) return;

        const cachedNow = contentCache.get(tabId);
        if (cachedNow && cachedNow.path === filePath && cachedNow.content === fresh.content) {
          // Cache already matches disk, but local state may lag behind the
          // shared cache (e.g., another pass updated it first) — sync it so
          // the renderer never displays older content than the cache holds.
          // DIAG(edit-loss): guard 1 terminated — cache already matches disk.
          diag('revalidate-cache-match', {
            tabId, cause, readGen: generation,
            freshHash: diagHash(fresh.content),
          });
          setContent((prev) => (prev === cachedNow ? prev : cachedNow));
          return;
        }
        // Write ledger: drop watcher echoes of our own saves before any
        // state-based checks (originalContent may not be updated yet). A
        // disk-confirmed generation supersedes every older token so a stale
        // saved hash resurfacing later is treated as a genuine regression.
        const freshHash = contentHash(fresh.content);
        const matched = matchRecentWrite(tabId, freshHash);
        if (matched) {
          // DIAG(edit-loss): guard 2 terminated — write-ledger echo token.
          diag('revalidate-write-echo', {
            tabId, cause, readGen: generation,
            freshHash,
            cachedHash: diagHash(cachedNow?.content),
            writeGeneration: matched.generation,
            writeState: matched.state,
          });
          dropWritesBelowGeneration(tabId, matched.generation);
          contentCache.set(tabId, fresh);
          return;
        }
        const store = useDashboardStore.getState();
        const editState = store.tabEditState[tabId];
        if (editState && editState.originalContent === fresh.content) {
          // Byte-identical to our disk baseline — never a conflict, dirty or
          // not (edit-loss Phase 3 §3.1: the old `!dirty` restriction was
          // H2b's leak point — a late echo while the user resumed editing).
          // DIAG(edit-loss): guard 3 terminated — bytes match originalContent.
          diag('revalidate-original-match', {
            tabId, cause, readGen: generation,
            freshHash,
            originalHash: diagHash(editState.originalContent),
            storeDirty: !!editState.dirty,
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
            tabId, cause, readGen: generation, verdict,
            freshHash,
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
          tabId, cause, readGen: generation,
          branch: editState && editState.mode !== 'view' ? 'banner' : 'content-swap',
          freshHash,
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
      readFromDisk('cached-mount');
    } else {
      setLoading(true);
      readFromDisk('initial');
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
      readFromDisk('watcher');
    };

    const unsubscribe = window.api.files.watchDirectory(parentDir, pathType, handleFsEvent);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [tabId, filePath, pathType, skip, checkHealth]);

  return { content, loading };
}
