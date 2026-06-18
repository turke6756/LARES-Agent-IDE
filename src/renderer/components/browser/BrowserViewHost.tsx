import React, { useEffect, useRef } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore, getBrowserApi } from '../../stores/browser-store';
import { throttle } from './throttle';
import NewTabPage from './NewTabPage';

// The WebContentsView is a main-process surface glued onto this placeholder
// <div>: it always paints above renderer DOM, so nothing may overlap this area
// without suspending the pane first (see useBrowserSuspension.ts). Bounds
// changes stream to main throttled to ~one per frame; unmount (file-viewer
// takeover, pane close, workspace nav) detaches the active view so it can
// never float over unrelated UI.
//
// New Tab page (WP2-NTP): when the active tab is a URL-less new tab
// (`isNewTab` or `url === ''`) we render the renderer-DOM <NewTabPage> instead
// of the host div, and call setActiveTab(null) so NO WebContentsView paints
// over the DOM. M6 forbids chrome://, data:, file:, so the NTP can never be a
// navigated URL — it has to be DOM. Navigating from the NTP routes through
// store.navigate → the M6 gate, exactly like the address bar.

const BOUNDS_THROTTLE_MS = 16;

export default function BrowserViewHost() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const activeTab = useBrowserStore(
    (s) => s.tabs.find((t) => t.tabId === s.activeTabId) ?? null,
  );
  const navigate = useBrowserStore((s) => s.navigate);
  const createTab = useBrowserStore((s) => s.createTab);
  const reload = useBrowserStore((s) => s.reload);

  // A new/empty tab shows the DOM NTP; anything with a real URL paints the view.
  const showNtp = !activeTab || activeTab.isNewTab === true || activeTab.url === '';

  // Slice-1: a failed load / crash shows a trusted-chrome error panel (renderer
  // DOM — never echoes page content). It replaces the host like the NTP does, so
  // the WebContentsView is detached beneath it.
  const showError = !showNtp && !!activeTab?.lastError;

  // Slice-1: a 2px indeterminate load bar while the active tab is loading; the
  // accent matches the partition (blue = user, orange = agent).
  const showProgress = !showNtp && !showError && activeTab?.loading === true;
  const progressColor =
    activeTab?.partition === 'agent' ? 'var(--color-accent-orange)' : 'var(--color-accent-blue)';

  // Keep the main-process view attached to the active tab — but DETACH (null)
  // while the NTP or the error panel shows, so the WebContentsView stays hidden
  // beneath the DOM and never paints over them.
  const detachView = showNtp || showError;
  useEffect(() => {
    getBrowserApi()?.setActiveTab(detachView ? null : activeTabId);
  }, [activeTabId, detachView]);

  // Detach on unmount / route-away.
  useEffect(() => {
    return () => {
      getBrowserApi()?.setActiveTab(null);
    };
  }, []);

  useEffect(() => {
    // No host div is mounted while the NTP or error panel shows — nothing to
    // report bounds for.
    if (detachView) return;
    const api = getBrowserApi();
    const el = hostRef.current;
    if (!api || !el) return;

    const sendBounds = throttle(() => {
      const r = el.getBoundingClientRect();
      // The renderer fills the window content area, so viewport CSS px ==
      // window-content-relative DIP — exactly what setBounds expects.
      api.setBounds({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    }, BOUNDS_THROTTLE_MS);

    sendBounds();
    const ro = new ResizeObserver(() => sendBounds());
    ro.observe(el);
    // ResizeObserver misses position-only shifts; window resize covers the
    // common one (maximize/restore with flex re-layout).
    window.addEventListener('resize', sendBounds);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sendBounds);
      sendBounds.cancel();
    };
  }, [detachView]);

  if (showNtp) {
    return (
      <NewTabPage
        onNavigate={(url) => {
          // Route every NTP "open" through the same nav path as the address
          // bar → the M6 scheme gate has final say. With no active tab yet,
          // open a fresh user tab on the target instead.
          if (activeTabId) navigate(activeTabId, url);
          else void createTab('user', url);
        }}
      />
    );
  }

  // Slice-1 trusted-chrome error panel — renderer DOM, NEVER page content. It
  // surfaces only the shell-side error description + the chrome-rendered URL,
  // with a Retry that re-enters the normal nav path (reload → did-start-loading
  // clears lastError in main, which re-attaches the view).
  if (showError && activeTab) {
    const err = activeTab.lastError!;
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center bg-browser-chrome">
        <div className="text-center max-w-md px-6">
          <Icons.CloudOff className="w-10 h-10 mx-auto mb-4 text-fg-muted" />
          <div className="text-[15px] font-medium text-fg-primary mb-1">
            This page couldn't load
          </div>
          <div className="text-[12px] text-fg-secondary break-words">{err.description}</div>
          {err.url && (
            <div className="text-[11px] text-fg-muted mt-2 font-mono break-all">{err.url}</div>
          )}
          <button
            onClick={() => reload(activeTab.tabId)}
            className="ui-btn ui-btn-primary px-3 py-1.5 text-[13px] font-medium mt-5"
          >
            <Icons.RotateCw className="w-4 h-4" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 2px indeterminate load bar (Slice-1) — sits ABOVE the host div, so the
          WebContentsView (reported via hostRef bounds) never paints over it. */}
      {showProgress && (
        <div
          className="browser-progress"
          style={{ ['--browser-progress-color' as string]: progressColor }}
          aria-hidden="true"
        />
      )}
      <div ref={hostRef} className="flex-1 min-h-0" />
    </div>
  );
}
