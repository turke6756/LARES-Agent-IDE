import React, { useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore } from '../../stores/browser-store';
import { useBrowserSuspension } from './useBrowserSuspension';

// ── Zoom control (Slice 15 — per-site zoom) ──────────────────────────────────
// −/percent/＋ in the AddressBar's reserved ZOOM slot. The percent reflects the
// active tab's zoomFactor (echoed back via the existing onTabState payload after
// setZoom). Clicking the percent opens a PRESET MENU (80–200%) plus a "Reset"
// entry that clears the persisted per-origin row (resetZoomForOrigin). For USER
// tabs main persists the chosen factor by origin; agent zoom stays per-tab. Uses
// only the public setZoom / resetZoom actions (→ wc.setZoomFactor in main).

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.1;

/** Preset factors offered in the menu (80 → 200%). */
const PRESETS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

function clamp(n: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

// ── Preset menu ──────────────────────────────────────────────────────────────
// Drops DOWN over the page region, which a WebContentsView would paint over, so
// useBrowserSuspension() hides the pane for the menu's lifetime (ref-counted,
// mirrors TabGroupDropdown / the context menu). A fixed click-catcher closes it.
function ZoomMenu({
  tabId,
  factor,
  x,
  y,
  onClose,
}: {
  tabId: string;
  factor: number;
  x: number;
  y: number;
  onClose: () => void;
}) {
  useBrowserSuspension();
  const setZoom = useBrowserStore((s) => s.setZoom);
  const resetZoom = useBrowserStore((s) => s.resetZoom);
  const currentPercent = Math.round(factor * 100);

  return (
    <>
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        role="menu"
        aria-label="Zoom level"
        className="browser-popover browser-popover-anim fixed z-50 w-[140px] py-1 text-[12px]"
        style={{ left: x, top: y + 4 }}
      >
        {PRESETS.map((p) => {
          const percent = Math.round(p * 100);
          const active = percent === currentPercent;
          return (
            <button
              key={p}
              role="menuitemradio"
              aria-checked={active}
              onClick={() => {
                setZoom(tabId, p);
                onClose();
              }}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left tabular-nums ${
                active
                  ? 'bg-[var(--color-tab-active-bg)] text-fg-primary'
                  : 'text-fg-secondary hover:bg-[var(--color-tab-hover-bg)]'
              }`}
            >
              <span>{percent}%</span>
              {active && <Icons.Check className="w-3.5 h-3.5 shrink-0" />}
            </button>
          );
        })}
        <div className="my-1 border-t border-[var(--color-browser-divider)]" />
        <button
          role="menuitem"
          onClick={() => {
            resetZoom(tabId);
            onClose();
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-secondary hover:bg-[var(--color-tab-hover-bg)]"
        >
          <Icons.RotateCcw className="w-3.5 h-3.5 shrink-0" />
          Reset
        </button>
      </div>
    </>
  );
}

export default function ZoomControl() {
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const tabs = useBrowserStore((s) => s.tabs);
  const setZoom = useBrowserStore((s) => s.setZoom);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const percentRef = useRef<HTMLButtonElement | null>(null);

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

  const openMenu = () => {
    const rect = percentRef.current?.getBoundingClientRect();
    setMenu(rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 });
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
        ref={percentRef}
        onClick={() => (menu ? setMenu(null) : openMenu())}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        className="ui-btn ui-btn-ghost px-1.5 py-1 text-[11px] tabular-nums min-w-[44px]"
        title="Zoom level"
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
      {menu && (
        <ZoomMenu
          tabId={activeTab.tabId}
          factor={factor}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
