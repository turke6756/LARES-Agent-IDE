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
  if (suspendCount === 0) return;
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
