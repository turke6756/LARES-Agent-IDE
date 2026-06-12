import React, { useEffect, useRef } from 'react';
import { useBrowserStore, getBrowserApi } from '../../stores/browser-store';
import { throttle } from './throttle';

// The WebContentsView is a main-process surface glued onto this placeholder
// <div>: it always paints above renderer DOM, so nothing may overlap this area
// without suspending the pane first (see useBrowserSuspension.ts). Bounds
// changes stream to main throttled to ~one per frame; unmount (file-viewer
// takeover, pane close, workspace nav) detaches the active view so it can
// never float over unrelated UI.

const BOUNDS_THROTTLE_MS = 16;

export default function BrowserViewHost() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const activeTabId = useBrowserStore((s) => s.activeTabId);

  // Keep the main-process view attached to whatever tab is active.
  useEffect(() => {
    getBrowserApi()?.setActiveTab(activeTabId);
  }, [activeTabId]);

  // Detach on unmount / route-away.
  useEffect(() => {
    return () => {
      getBrowserApi()?.setActiveTab(null);
    };
  }, []);

  useEffect(() => {
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
  }, []);

  return <div ref={hostRef} className="flex-1 min-h-0" />;
}
