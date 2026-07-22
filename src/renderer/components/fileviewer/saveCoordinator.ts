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
import { contentHash } from './markdownSplice';
import { diag } from './editLossDiag';

export interface SaveSnapshot {
  draft: string;
  revision: number;
  /** Exact live serialization captured with the draft (Milkdown only). */
  editorSerialized?: string;
  /**
   * Phase 2: derived as contentHash(editState.originalContent); captured and
   * threaded but UNENFORCED (the writer ignores it) until Phase 4 adds the
   * conditional-write IPC. Phase 4 migrates to the explicit store field with
   * null = "expect the file absent".
   */
  expectedDiskHash: string | null;
}

export interface SaveAdapter {
  /** Synchronous live snapshot; null = pristine (nothing to write). */
  snapshot(): SaveSnapshot | null;
  /** Editor-side B1/B2 install after a fully-gated completed write. */
  rebaseline?(written: SaveSnapshot): void;
}

/** Phase 4 fills the payload (plan §4.3); stub shape only in Phase 2. */
export interface FlushResult {
  tabId: string;
  fileName: string;
  outcome: 'saved' | 'pristine' | 'conflict' | 'error' | 'timeout';
  error?: string;
}

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
    expectedDiskHash: contentHash(es.originalContent),
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
 * `force` = unconditional write — used ONLY by Phase 4's close-dialog
 * "Overwrite anyway" (inert in Phase 2: the writer ignores expectedDiskHash).
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

/** Phase 4 payload (plan §4.3): flush every dirty tab against a deadline for
 * the app-close handshake. Stub in Phase 2 — signature only. */
export async function flushAll(_deadlineMs: number): Promise<FlushResult[]> {
  return [];
}

async function drain(tabId: string, st: TabSaveState): Promise<void> {
  st.inFlight = true;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const snap = captureSnapshot(tabId);
      if (snap === null) {
        // Genuinely pristine — nothing to write; every caller succeeds.
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
      if (!ok) {
        // Terminal failure: the store surfaced editState.error; draft/dirty/
        // revision retained. Every pending caller learns of the failure.
        diag('coordinator-write-failed', { tabId, revision: snap.revision });
        resolveWaiters(st, Infinity, false);
        break;
      }

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
