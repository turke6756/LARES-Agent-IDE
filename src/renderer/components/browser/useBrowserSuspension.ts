import { useEffect } from 'react';
import { getBrowserApi } from '../../stores/browser-store';

// ── Browser-pane suspension API ──────────────────────────────────────────────
//
// A WebContentsView always paints ABOVE renderer DOM, so every renderer-drawn
// overlay (dialogs, confirmations, context menus) is occluded while the pane
// is visible. The fix is main-process suspension: window.api.browser
// .setVisible(false) hides all views while an overlay is up, setVisible(true)
// restores the active tab.
//
// This module ref-counts so stacked/nested overlays compose: the pane hides
// when the first overlay mounts and reappears only when the last one unmounts.
//
// Usage — one line at the top of any modal/overlay component body:
//
//     useBrowserSuspension();
//
// Wired into AgentLaunchDialog, WorkspaceCreateDialog and QueryDialog (the
// trivially insertable full-screen overlays). NOTE for WP3-B: the native
// confirmation chrome (M15) and any new overlay MUST subscribe via this hook
// (or call suspendBrowserPane()/resumeBrowserPane() directly for non-React
// chrome) before rendering over the center panel.

let suspendCount = 0;

export function suspendBrowserPane(): void {
  suspendCount += 1;
  if (suspendCount === 1) {
    try {
      getBrowserApi()?.setVisible(false);
    } catch (err) {
      console.error('browser.setVisible(false) failed:', err);
    }
  }
}

export function resumeBrowserPane(): void {
  if (suspendCount === 0) {
    // Dev-only assertion: a resume with no matching suspend means the
    // suspend/resume calls are unbalanced (the count would go negative).
    // Surfacing it in dev catches overlays that resume twice or never
    // suspended, which would prematurely re-show the pane under a sibling
    // overlay. In production we still no-op defensively.
    if (process.env.NODE_ENV !== 'production') {
      console.error(
        'resumeBrowserPane() called while suspendCount is already 0 — ' +
          'unbalanced suspend/resume (pane visibility ref-count underflow).',
      );
    }
    return;
  }
  suspendCount -= 1;
  if (suspendCount === 0) {
    try {
      // Safe even when the pane is closed: the host detaches the active tab
      // (setActiveTab(null)) on unmount, so "visible" with no active tab
      // renders nothing.
      getBrowserApi()?.setVisible(true);
    } catch (err) {
      console.error('browser.setVisible(true) failed:', err);
    }
  }
}

/** Suspend the browser pane for this component's lifetime. */
export function useBrowserSuspension(): void {
  useEffect(() => {
    suspendBrowserPane();
    return () => resumeBrowserPane();
  }, []);
}

// ── Test-only introspection ──────────────────────────────────────────────────
// Renderer tests assert that nested overlays restore pane visibility EXACTLY
// once — i.e. the ref-count climbs while overlays stack and returns to 0 only
// when the last one unmounts. These accessors are not part of the runtime API;
// they exist so a test can observe the otherwise-private counter without
// reaching into module internals or stubbing the IPC bridge.

/** Test-only: current suspend ref-count. */
export function __getSuspendCount(): number {
  return suspendCount;
}

/** Test-only: reset the ref-count so each suite starts from a known balance. */
export function __resetSuspendCount(): void {
  suspendCount = 0;
}
