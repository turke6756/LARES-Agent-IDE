import React from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore } from '../../stores/browser-store';

// ── Zoom control (WP5-FIND-ZOOM-UI) ──────────────────────────────────────────
// −/percent/＋ in the AddressBar's reserved ZOOM slot. The percent reflects the
// active tab's zoomFactor (echoed back via the existing onTabState payload after
// setZoom). Clicking the percent resets to 100%. Uses only the public setZoom
// action (→ wc.setZoomFactor in main) — no debugger/CDP.

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.1;

function clamp(n: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

export default function ZoomControl() {
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const tabs = useBrowserStore((s) => s.tabs);
  const setZoom = useBrowserStore((s) => s.setZoom);

  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null;

  // Nothing to zoom on the New Tab page or when there's no tab.
  if (!activeTab || activeTab.isNewTab || !activeTab.url) return null;

  const factor = activeTab.zoomFactor ?? 1;
  const percent = Math.round(factor * 100);

  // Round to the nearest step so repeated clicks land on tidy values.
  const step = (delta: number) => {
    const next = clamp(Math.round((factor + delta) * 100) / 100);
    setZoom(activeTab.tabId, next);
  };

  return (
    <div className="flex items-center gap-0.5 shrink-0">
      <button
        onClick={() => step(-ZOOM_STEP)}
        disabled={factor <= ZOOM_MIN}
        className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
        title="Zoom out"
      >
        <Icons.Minus className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => setZoom(activeTab.tabId, 1)}
        className="ui-btn ui-btn-ghost px-1.5 py-1 text-[11px] tabular-nums min-w-[44px]"
        title="Reset zoom to 100%"
      >
        {percent}%
      </button>
      <button
        onClick={() => step(ZOOM_STEP)}
        disabled={factor >= ZOOM_MAX}
        className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
        title="Zoom in"
      >
        <Icons.Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
