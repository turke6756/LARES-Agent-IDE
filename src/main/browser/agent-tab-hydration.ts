// Agent-tab hydration: the D3 restore path for a DISCARDED agent tab
// (2026-07-11 incident plan §5 D3.3). Browser tool verbs resolve a live
// `TabEntry` (mustGet → tab.view.webContents) before policy/gating runs, so a
// suspended agent tab must be restored to a live view BEFORE the verb is gated
// and executed. This module owns exactly the SERIALIZATION contract; the actual
// view rebuild + load-commit wait is injected (`restore`) because it is
// Electron-coupled and lives in browser-manager.ts.
//
// Contract (plan §5 D3.3):
//   - Concurrent verbs against the same discarded tab serialize on ONE per-tab
//     restore promise — exactly one restoration, queued callers share its result.
//   - Restoration failure returns a STRUCTURED error to the agent — never a hang
//     or a silent no-op.
//   - A successful restore carries `restored: true` so tool output can hint the
//     agent to re-read the page (URL + persist:agent storage are preserved;
//     in-page JS/form/scroll state is NOT).

/** Structured result of an ensureHydrated call. `restored` is true only when a
 *  discarded tab was actually rebuilt this call; a tab that was already live
 *  returns `restored: false` with no error. On failure `error` is populated and
 *  `restored` is false. */
export interface HydrationResult {
  tabId: string;
  /** True iff this call rebuilt a previously-discarded view (agents should
   *  re-read the page). False for an already-live tab or a failed restore. */
  restored: boolean;
  /** Present iff restoration failed — a machine-readable code + human message
   *  the verb layer turns into a structured tool error. */
  error?: { code: string; message: string };
}

export interface HydrationDeps {
  /** True iff the tab is currently a discarded/frozen agent snapshot needing a
   *  rebuild before a verb can run. */
  isDiscarded: (tabId: string) => boolean;
  /** Rebuild the view, navigate to the stored URL, and wait for the load to
   *  commit (bounded timeout). MUST resolve to a structured result — resolving
   *  with `error` for an expected failure (load error / renderer spawn failure
   *  under pressure) is preferred, but a thrown error is also caught and
   *  converted so a caller never hangs. */
  restore: (tabId: string) => Promise<HydrationResult>;
}

/**
 * Per-tab restore coordinator (plan §5 D3.3). `ensureHydrated` is the single
 * entry point the verb path calls before `mustGet`. It:
 *   - fast-returns `{ restored: false }` when the tab is already live;
 *   - otherwise starts (or joins) the ONE in-flight restore for that tab;
 *   - guarantees a structured result even if `restore` throws.
 */
export class TabHydrationCoordinator {
  private readonly inflight = new Map<string, Promise<HydrationResult>>();

  constructor(private readonly deps: HydrationDeps) {}

  /** Ensure a (possibly-discarded) agent tab is live. Concurrent callers on the
   *  same discarded tab share exactly one restoration. */
  ensureHydrated(tabId: string): Promise<HydrationResult> {
    if (!this.deps.isDiscarded(tabId)) {
      return Promise.resolve({ tabId, restored: false });
    }
    const existing = this.inflight.get(tabId);
    if (existing) return existing;

    const run = (async (): Promise<HydrationResult> => {
      try {
        return await this.deps.restore(tabId);
      } catch (err) {
        return {
          tabId,
          restored: false,
          error: {
            code: 'restore-failed',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    })().finally(() => {
      // Clear regardless of outcome so a later verb can retry a failed restore.
      this.inflight.delete(tabId);
    });

    this.inflight.set(tabId, run);
    return run;
  }

  /** True while a restoration is in flight for the tab (introspection/tests). */
  isRestoring(tabId: string): boolean {
    return this.inflight.has(tabId);
  }
}
