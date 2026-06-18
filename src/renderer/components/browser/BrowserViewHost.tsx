import React, { useEffect, useRef } from 'react';
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

  // A new/empty tab shows the DOM NTP; anything with a real URL paints the view.
  const showNtp = !activeTab || activeTab.isNewTab === true || activeTab.url === '';

  // Keep the main-process view attached to the active tab — but DETACH (null)
  // while the NTP shows, so the WebContentsView stays hidden beneath the DOM
  // and never paints over the New Tab page.
  useEffect(() => {
    getBrowserApi()?.setActiveTab(showNtp ? null : activeTabId);
  }, [activeTabId, showNtp]);

  // Detach on unmount / route-away.
  useEffect(() => {
    return () => {
      getBrowserApi()?.setActiveTab(null);
    };
  }, []);

  useEffect(() => {
    // No host div is mounted while the NTP shows — nothing to report bounds for.
    if (showNtp) return;
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
  }, [showNtp]);

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

  return <div ref={hostRef} className="flex-1 min-h-0" />;
}
