/**
 * Autosave hook (edit-loss plan §4.2 + §4.4, R3/R6/R9/R10) — shared by the
 * Milkdown canvas and the CodeMirror source editor.
 *
 *   const { onEdit, rootRef } = useAutosave(tabId);
 *
 * - `onEdit()` is the editors' undebounced edit signal: it calls
 *   `noteEdit(tabId)` (B3's revision — the hook is explicitly informed of
 *   edits, never inferring them) AND re-arms the single idle timer
 *   (`AUTOSAVE_IDLE_MS`). Milkdown's per-transaction ProseMirror plugin and
 *   CodeMirror's updateListener call it.
 * - On timer fire the eligibility is re-checked AT FIRE TIME: skip when the
 *   tab is no longer dirty, a save is in flight, the external-change banner
 *   is up, or the coordinator conflict-paused the tab (§4.1). Manual saves
 *   are never gated here — only autosave consults the pause.
 * - Flush triggers (immediate save while dirty): true editor exit — a
 *   `focusout` on `rootRef` whose relatedTarget is OUTSIDE the root
 *   (intra-editor focus moves never save); `visibilitychange → hidden`;
 *   component unmount. The unmount flush rides the module-level
 *   coordinator's store adapter: the editor's own cleanup has already
 *   flushed the final draft into the store and unregistered its adapter
 *   (layout cleanup runs before this hook's passive cleanup), so
 *   `requestSave` writes the preserved draft with no live editor at all.
 * - Failure policy (§4.4, R10): a failed autosave retains draft/dirty/
 *   revision (the store already guarantees that) and retries 5s → 15s →
 *   stop; writer-classified 'too-large'/'permission' failures stop
 *   immediately. Any new edit re-arms the ladder. Errors surface as the
 *   non-blocking chip in FileContentArea's stable wrapper — never
 *   window.alert.
 *
 * Fidelity (R8): autosave has NO write path of its own — it calls the same
 * `requestSave` every manual gesture uses, so the snapshot/splice/CAS
 * discipline is byte-identical to a manual save.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import { isConflictPaused, noteEdit, requestSave } from './saveCoordinator';
import { diag } from './editLossDiag';

export const AUTOSAVE_IDLE_MS = 2000; // product decision (plan §4.2)
/** §4.4: retry 5s → 15s → stop until the next edit re-arms. */
export const AUTOSAVE_RETRY_DELAYS_MS = [5_000, 15_000] as const;

/** Error codes that stop the retry ladder immediately (§4.4). */
const TERMINAL_CODES = new Set(['too-large', 'permission']);

interface AutosaveHandle {
  /** Undebounced edit signal — bumps the revision and re-arms the idle timer. */
  onEdit: () => void;
  /** Attach to the editor's root element for the focusout flush trigger. */
  rootRef: React.MutableRefObject<HTMLDivElement | null>;
}

function eligible(tabId: string, opts?: { ignoreSaving?: boolean }): true | string {
  const es = useDashboardStore.getState().tabEditState[tabId];
  if (!es?.dirty) return 'not-dirty';
  if (es.saving && !opts?.ignoreSaving) return 'saving';
  if (es.externalChange) return 'external-change';
  if (isConflictPaused(tabId)) return 'conflict-paused';
  return true;
}

export function useAutosave(tabId?: string): AutosaveHandle {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);

  const clearIdle = () => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };
  const clearRetry = () => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  };

  /** One autosave attempt for `tab` + the §4.4 failure policy on its result. */
  const attempt = useCallback((tab: string, trigger: string) => {
    const verdict = eligible(tab, { ignoreSaving: trigger !== 'idle' });
    if (verdict !== true) {
      // DIAG(edit-loss): autosave declined at fire time.
      diag('autosave-skip', { tabId: tab, trigger, reason: verdict });
      return;
    }
    // DIAG(edit-loss): autosave entering the coordinator.
    diag('autosave-fire', { tabId: tab, trigger });
    void requestSave(tab)
      .then((ok) => {
        if (ok) {
          retryAttemptRef.current = 0;
          return;
        }
        // Conflict refusals pause autosave via the coordinator flag — the
        // banner owns resolution; retrying the same hash can only lose again.
        if (isConflictPaused(tab) || useDashboardStore.getState().tabEditState[tab]?.externalChange) {
          diag('autosave-skip', { tabId: tab, trigger: 'retry-policy', reason: 'conflict' });
          return;
        }
        const code = useDashboardStore.getState().tabEditState[tab]?.errorCode;
        if (code && TERMINAL_CODES.has(code)) {
          // 'too-large'/'permission': retrying cannot help — stop until the
          // next edit (which may shrink the doc / follow a permission fix).
          diag('autosave-retry-stopped', { tabId: tab, code });
          return;
        }
        const attemptIndex = retryAttemptRef.current;
        if (attemptIndex >= AUTOSAVE_RETRY_DELAYS_MS.length) {
          diag('autosave-retry-stopped', { tabId: tab, code: code ?? 'io', exhausted: true });
          return;
        }
        retryAttemptRef.current = attemptIndex + 1;
        clearRetry();
        diag('autosave-retry-scheduled', {
          tabId: tab,
          attempt: attemptIndex + 1,
          delayMs: AUTOSAVE_RETRY_DELAYS_MS[attemptIndex],
        });
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          attempt(tab, 'retry');
        }, AUTOSAVE_RETRY_DELAYS_MS[attemptIndex]);
      })
      .catch(() => {
        /* requestSave never rejects; belt-and-braces for a dead bridge */
      });
  }, []);

  /** Stable edit signal: bump the revision, re-arm the single idle timer,
   * reset the retry ladder (a new edit is new information). */
  const onEdit = useCallback(() => {
    const tab = tabIdRef.current;
    if (!tab) return;
    noteEdit(tab);
    retryAttemptRef.current = 0;
    clearRetry();
    clearIdle();
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      attempt(tab, 'idle');
    }, AUTOSAVE_IDLE_MS);
  }, [attempt]);

  useEffect(() => {
    if (!tabId) return;
    const root = rootRef.current;

    const onFocusOut = (e: FocusEvent) => {
      // Intra-editor focus moves never save; leaving the editor entirely
      // (relatedTarget outside the root, or nowhere) flushes immediately.
      const next = e.relatedTarget;
      if (root && next instanceof Node && root.contains(next)) return;
      attempt(tabId, 'focusout');
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') attempt(tabId, 'visibility-hidden');
    };

    root?.addEventListener('focusout', onFocusOut);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      root?.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', onVisibility);
      clearIdle();
      clearRetry();
      retryAttemptRef.current = 0;
      // Unmount flush (R2-safe): the editor's own layout cleanup already ran
      // — final draft flushed into the store, adapter unregistered — so this
      // requestSave rides the coordinator's store adapter post-disposal. The
      // eligibility check keeps it a no-op for pristine/reloaded/discarded
      // tabs (their reset left dirty=false) and conflicted tabs.
      attempt(tabId, 'unmount');
    };
  }, [tabId, attempt]);

  return { onEdit, rootRef };
}
