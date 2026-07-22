/**
 * Save coordinator — the ONE save authority (edit-loss plan Phase 2, R2+R3).
 *
 * Every user save gesture (header Save, window/canvas/detached Ctrl+S,
 * CodeMirror onSave, save-and-close, save-before-detach) routes through
 * `requestSave`. The coordinator snapshots the live document synchronously at
 * gesture time (closing the ~200ms markdownUpdated debounce bypass, H4),
 * serializes writes per tab with latest-revision coalescing, and gates every
 * completion (mark-clean / B1+B2 rebaseline) on the captured revision AND the
 * captured serialization — a write that raced a newer edit installs disk
 * truth (B1) only and the newer state is written next.
 *
 * Import discipline: dashboard-store, shared types, contentHash, diag ONLY —
 * never components. Editors reach the coordinator the other way around, by
 * registering a SaveAdapter.
 *
 * Write execution stays in the store: `saveTab(tabId, opts)` remains the
 * single write executor (echo token + evictTabCache + saving/error state);
 * this module is the only caller passing `opts`.
 */
import { useDashboardStore } from '../../stores/dashboard-store';
import { contentHash } from '../../../shared/content-hash';
import type { FlushResult } from '../../../shared/types';
import { diag } from './editLossDiag';

export interface SaveSnapshot {
  draft: string;
  revision: number;
  /** Exact live serialization captured with the draft (Milkdown only). */
  editorSerialized?: string;
  /**
   * The CAS guard for this snapshot's write (edit-loss §4.1, ENFORCED): the
   * store's explicit `expectedDiskHash` field (null = "expect the file
   * absent"), falling back to contentHash(originalContent) for pre-4.1
   * session state. Captured via storeExpectedDiskHash().
   */
  expectedDiskHash: string | null;
}

export interface SaveAdapter {
  /** Synchronous live snapshot; null = pristine (nothing to write). */
  snapshot(): SaveSnapshot | null;
  /** Editor-side B1/B2 install after a fully-gated completed write. */
  rebaseline?(written: SaveSnapshot): void;
}

// Close-flush payload (plan §4.3) — shape lives in shared/types so main's
// close handshake and this renderer side can never drift.
export type { FlushResult } from '../../../shared/types';

interface Waiter {
  revision: number;
  resolve: (ok: boolean) => void;
}

interface TabSaveState {
  inFlight: boolean;
  latestWanted: number;
  waiters: Waiter[];
  force: boolean;
}

const adapters = new Map<string, SaveAdapter>();
const revisions = new Map<string, number>();
const tabStates = new Map<string, TabSaveState>();

// Tabs whose last write was refused by the CAS check (edit-loss §4.1): the
// banner is up and queued/idle AUTOSAVES must not retry into the same
// conflict — Phase 4B's useAutosave consults isConflictPaused() at timer-fire
// time. Manual requestSave is deliberately NOT gated here: after
// dismissExternalChange advances the store's expectedDiskHash, a manual save
// legitimately overwrites the acknowledged bytes. Cleared on any subsequent
// successful (or pristine) drain, or explicitly via clearConflictPause()
// (4B's dismiss/reload paths).
const conflictPaused = new Set<string>();

/** Is this tab's autosave paused on an unresolved CAS conflict? (4B) */
export function isConflictPaused(tabId: string): boolean {
  return conflictPaused.has(tabId);
}

/** Explicitly lift the conflict pause (4B: dismiss/reload/close paths). */
export function clearConflictPause(tabId: string): void {
  conflictPaused.delete(tabId);
}

/** The CAS guard for a tab (edit-loss §4.1): the store's explicit
 *  expectedDiskHash when present (null = expect absent), else — pre-4.1
 *  session state — derived from originalContent. Shared by every snapshot
 *  producer (store adapter here, Milkdown adapter) so they can never
 *  disagree. */
export function storeExpectedDiskHash(
  es: { expectedDiskHash?: string | null; originalContent: string } | undefined,
): string | null {
  if (!es) return null;
  return es.expectedDiskHash !== undefined ? es.expectedDiskHash : contentHash(es.originalContent);
}

/** Identity-guarded unregister (mirrors registerFreshContentHandler). */
export function registerSaveAdapter(tabId: string, adapter: SaveAdapter): () => void {
  adapters.set(tabId, adapter);
  return () => {
    if (adapters.get(tabId) === adapter) {
      adapters.delete(tabId);
    }
  };
}

/**
 * Undebounced edit signal (B3's revision): Milkdown calls this from a
 * per-transaction ProseMirror plugin; CodeMirror from onChange. The revision
 * therefore LEADS the ~200ms markdownUpdated debounce.
 *
 * (The plan named Crepe's `listener.updated` as the source, but in this
 * @milkdown/plugin-listener version `updated` fires inside the SAME 200ms
 * debounce as `markdownUpdated` — a listener-based revision would lag exactly
 * like the draft does, so gate (a) could never see a mid-write edit. The
 * ProseMirror plugin fires synchronously with every dispatched transaction.)
 */
export function noteEdit(tabId: string): number {
  const next = (revisions.get(tabId) ?? 0) + 1;
  revisions.set(tabId, next);
  return next;
}

export function currentRevision(tabId: string): number {
  return revisions.get(tabId) ?? 0;
}

/**
 * Live dirty probe for close/detach gates (DetachedFileView close-query,
 * FileTabBar save-before-detach). Snapshots — and thereby synchronously
 * flushes — the registered adapter, so a live edit still inside the debounce
 * window counts as unsaved work AND lands in the store draft before any
 * dialog renders. Falls back to store dirty when no adapter is registered.
 */
export function hasUnsavedWork(tabId: string): boolean {
  const adapter = adapters.get(tabId);
  if (adapter) return adapter.snapshot() !== null;
  return !!useDashboardStore.getState().tabEditState[tabId]?.dirty;
}

/** Snapshot at call time: registered adapter first (synchronous live flush),
 * else the store adapter (draftContent + currentRevision, no serialization —
 * source mode / post-unmount). */
function captureSnapshot(tabId: string): SaveSnapshot | null {
  const adapter = adapters.get(tabId);
  if (adapter) return adapter.snapshot();
  const es = useDashboardStore.getState().tabEditState[tabId];
  if (!es?.dirty) return null;
  return {
    draft: es.draftContent,
    revision: currentRevision(tabId),
    expectedDiskHash: storeExpectedDiskHash(es),
  };
}

function tabState(tabId: string): TabSaveState {
  let st = tabStates.get(tabId);
  if (!st) {
    st = { inFlight: false, latestWanted: 0, waiters: [], force: false };
    tabStates.set(tabId, st);
  }
  return st;
}

/** Resolve every caller whose captured revision is covered by a settled write
 * (revision ≤ upTo). Infinity = everyone (pristine drain / terminal failure). */
function resolveWaiters(st: TabSaveState, upTo: number, ok: boolean): void {
  const remaining: Waiter[] = [];
  for (const w of st.waiters) {
    if (w.revision <= upTo) w.resolve(ok);
    else remaining.push(w);
  }
  st.waiters = remaining;
}

/**
 * Request a save for a tab. Single-flight per tab: if a write is in flight,
 * this records the latest wanted revision and returns a promise that resolves
 * only once a write with revision ≥ the caller's captured revision succeeds
 * (or fails terminally). Same-revision requests coalesce into one write.
 *
 * `force` = unconditional write (expectedHash omitted at the writer) — used
 * ONLY by Phase 4B's close-dialog "Overwrite anyway" and tests; no UI in 4A
 * calls it.
 */
export function requestSave(tabId: string, opts?: { force?: boolean }): Promise<boolean> {
  const st = tabState(tabId);
  const revision = currentRevision(tabId);
  st.latestWanted = Math.max(st.latestWanted, revision);
  if (opts?.force) st.force = true;
  const promise = new Promise<boolean>((resolve) => {
    st.waiters.push({ revision, resolve });
  });
  // DIAG(edit-loss): save gesture entering the coordinator.
  diag('coordinator-request', { tabId, revision, inFlight: st.inFlight });
  if (!st.inFlight) void drain(tabId, st);
  return promise;
}

/** A tab whose next conditional save is known-doomed (or already refused):
 * the banner is up, or the coordinator paused it on a CAS refusal. */
function inConflict(tabId: string): boolean {
  return (
    isConflictPaused(tabId) ||
    !!useDashboardStore.getState().tabEditState[tabId]?.externalChange
  );
}

/**
 * App-close flush (plan §4.3): drive every editing tab to disk against a
 * deadline and report a per-tab outcome for main's close dialog.
 *
 * - `action: 'flush'` (default) targets every open tab with an edit session;
 * - `'retry'` re-saves the listed tabs (error/timeout survivors);
 * - `'force'` re-saves ONLY conflict tabs, unconditionally — the dialog's
 *   explicitly labeled "Overwrite anyway".
 *
 * A bannered/conflict-paused tab is reported 'conflict' WITHOUT re-attempting
 * the doomed conditional write (unless forced); a tab whose save doesn't
 * settle inside the deadline reports 'timeout' (the write itself is not
 * cancelled — a late success is still a success).
 */
export async function flushAll(
  deadlineMs: number,
  opts?: { action?: 'flush' | 'retry' | 'force'; tabIds?: string[] },
): Promise<FlushResult[]> {
  const action = opts?.action ?? 'flush';
  const { openTabs, tabEditState } = useDashboardStore.getState();
  let targets = openTabs.filter((t) => t.filePath && tabEditState[t.id]);
  if (opts?.tabIds) targets = targets.filter((t) => opts.tabIds!.includes(t.id));
  if (action === 'force') targets = targets.filter((t) => inConflict(t.id));

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    deadlineTimer = setTimeout(() => resolve('timeout'), deadlineMs);
  });

  const results = await Promise.all(
    targets.map(async (t): Promise<FlushResult> => {
      const fileName = t.filePath.split(/[\\/]/).pop() ?? t.filePath;
      if (action !== 'force') {
        if (!hasUnsavedWork(t.id)) return { tabId: t.id, fileName, outcome: 'pristine' };
        if (inConflict(t.id)) return { tabId: t.id, fileName, outcome: 'conflict' };
      }
      const settled = await Promise.race([
        requestSave(t.id, action === 'force' ? { force: true } : undefined).then(
          (ok): 'saved' | 'failed' => (ok ? 'saved' : 'failed'),
        ),
        deadline,
      ]);
      if (settled === 'timeout') return { tabId: t.id, fileName, outcome: 'timeout' };
      if (settled === 'saved') return { tabId: t.id, fileName, outcome: 'saved' };
      if (inConflict(t.id)) return { tabId: t.id, fileName, outcome: 'conflict' };
      return {
        tabId: t.id,
        fileName,
        outcome: 'error',
        error: useDashboardStore.getState().tabEditState[t.id]?.error ?? 'save failed',
      };
    }),
  );
  clearTimeout(deadlineTimer);
  // DIAG(edit-loss): close-flush round summary — which tabs the app-close
  // handshake drove to disk, and any it had to abandon to the dialog.
  diag('close-flush', {
    action,
    results: results.map((r) => `${r.fileName}:${r.outcome}`),
  });
  return results;
}

async function drain(tabId: string, st: TabSaveState): Promise<void> {
  st.inFlight = true;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const snap = captureSnapshot(tabId);
      if (snap === null) {
        // Genuinely pristine — nothing to write; every caller succeeds.
        conflictPaused.delete(tabId);
        diag('coordinator-pristine', { tabId });
        resolveWaiters(st, Infinity, true);
        break;
      }
      st.latestWanted = Math.max(st.latestWanted, snap.revision);
      const force = st.force;
      st.force = false;
      const ok = await useDashboardStore.getState().saveTab(tabId, {
        content: snap.draft,
        revision: snap.revision,
        expectedDiskHash: snap.expectedDiskHash,
        force,
      });
      if (ok === 'conflict') {
        // CAS refusal (§4.1): the store already raised the banner with the
        // fresh disk bytes; draft/dirty/revision preserved. Pause this tab's
        // autosaves (4B consults the flag) — retrying the same expected hash
        // can only conflict again until the user resolves the banner (dismiss
        // advances the store hash; reload drops the draft).
        conflictPaused.add(tabId);
        diag('coordinator-conflict', { tabId, revision: snap.revision });
        resolveWaiters(st, Infinity, false);
        break;
      }
      if (!ok) {
        // Terminal failure: the store surfaced editState.error; draft/dirty/
        // revision retained. Every pending caller learns of the failure.
        diag('coordinator-write-failed', { tabId, revision: snap.revision });
        resolveWaiters(st, Infinity, false);
        break;
      }
      // A completed write is disk truth at our expected hash — any prior
      // conflict pause is stale.
      conflictPaused.delete(tabId);

      // ── Completion gating (plan §2.1, normative) ──────────────────────────
      // A fresh adapter snapshot FIRST: it synchronously flushes the live doc,
      // so a mid-write edit is in the store draft (dirty coherent) before any
      // gate verdict — and it carries the live serialization for gate (b).
      const adapter = adapters.get(tabId);
      const post = adapter ? adapter.snapshot() : null;

      // Gate (a): revision unchanged since the snapshot?
      const revNow = currentRevision(tabId);
      if (revNow !== snap.revision) {
        // An edit landed while the write was in flight: install B1 only
        // (saveTab already set originalContent = written bytes — disk truth);
        // dirty stays true (the post-snapshot flush pushed the newer draft);
        // NO B2 rebaseline. The newer state is enqueued unconditionally
        // (plan §2.4 debounce-window race: "B enqueued") — the user's gesture
        // meant "save my document", and the document moved mid-write.
        st.latestWanted = Math.max(st.latestWanted, revNow);
        diag('coordinator-gate-a-failed', {
          tabId,
          written: snap.revision,
          current: revNow,
        });
        resolveWaiters(st, snap.revision, true);
        continue;
      }

      // Gate (b) — defense in depth for Milkdown: the live serialization at
      // completion must equal the captured one. A mismatch means an edit
      // landed WITHOUT noteEdit firing; the snapshot above already flushed it
      // (dirty preserved) — advance the revision and enqueue the latest.
      if (
        snap.editorSerialized !== undefined &&
        post !== null &&
        post.editorSerialized !== undefined &&
        post.editorSerialized !== snap.editorSerialized
      ) {
        const bumped = noteEdit(tabId);
        st.latestWanted = Math.max(st.latestWanted, bumped);
        diag('coordinator-gate-b-failed', { tabId, written: snap.revision, bumped });
        resolveWaiters(st, snap.revision, true);
        continue;
      }

      // Fully-gated completion: settle store dirty against the fresh B1
      // (saveTab's opts path leaves `dirty` untouched so the store can never
      // blip clean under an in-flight edit — the recompute happens here,
      // after the gates), then install the editor-side baselines (B2).
      const store = useDashboardStore.getState();
      const es = store.tabEditState[tabId];
      if (es) store.setDraftContent(tabId, es.draftContent);
      adapter?.rebaseline?.(snap);
      diag('coordinator-complete', { tabId, revision: snap.revision });
      resolveWaiters(st, snap.revision, true);
      if (st.latestWanted <= snap.revision) break;
      // A newer revision was requested while writing — capture ONE fresh
      // snapshot (the latest) on the next iteration.
    }
  } finally {
    st.inFlight = false;
    // Requests that raced the final settle re-enter via requestSave (which
    // sees inFlight === false and starts a new drain).
    if (st.waiters.length > 0) void drain(tabId, st);
  }
}
