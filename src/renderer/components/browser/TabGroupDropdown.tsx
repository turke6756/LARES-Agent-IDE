import React from 'react';
import { useBrowserStore } from '../../stores/browser-store';
import { useBrowserSuspension } from './useBrowserSuspension';
import { tabLabel, prettyHost, type TabGroup, type OrderedTab } from './tab-groups';
import * as Icons from 'lucide-react';

// ── Group dropdown list (the second expand mode) ─────────────────────────────
//
// A vertical popover listing every member of a collapsed group; clicking a row
// activates that tab. This drops DOWN over the page region, so the
// WebContentsView would paint over it — useBrowserSuspension() hides the pane
// for the popover's lifetime (ref-counted, mirrors the context menu + history
// overlay). A fixed click-catcher closes it on outside-click.

interface TabGroupDropdownProps {
  group: TabGroup;
  /** Viewport coords of the chip's bottom-left. */
  x: number;
  y: number;
  onClose: () => void;
}

function MemberIcon({ tab }: { tab: OrderedTab['tab'] }) {
  if (tab.loading) return <Icons.Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-fg-muted" />;
  if (tab.partition === 'agent') return <Icons.Bot className="w-3.5 h-3.5 shrink-0 text-accent-orange" />;
  if (tab.favicon) return <img src={tab.favicon} alt="" className="w-3.5 h-3.5 shrink-0" />;
  return <Icons.Globe className="w-3.5 h-3.5 shrink-0 text-fg-muted" />;
}

export default function TabGroupDropdown({ group, x, y, onClose }: TabGroupDropdownProps) {
  // The popover overlaps the page region → hide the pane while it's up.
  useBrowserSuspension();

  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const selectTab = useBrowserStore((s) => s.selectTab);
  const closeTab = useBrowserStore((s) => s.closeTab);

  const accent = group.partition === 'agent' ? 'text-accent-orange' : 'text-accent-blue';

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="fixed z-50 w-[300px] max-w-[92vw] rounded-md border border-[var(--color-browser-divider)] bg-[var(--color-surface-0)] shadow-xl py-1 text-[12px]"
        style={{ left: x, top: y + 4 }}
      >
        {/* Header: group name + count + close-all. */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-browser-divider)]">
          {group.partition === 'agent' ? (
            <Icons.Bot className={`w-3.5 h-3.5 shrink-0 ${accent}`} />
          ) : (
            <Icons.User className={`w-3.5 h-3.5 shrink-0 ${accent}`} />
          )}
          <span className="font-semibold text-fg-primary">{group.label}</span>
          <span className="text-fg-muted">· {group.members.length}</span>
          <button
            onClick={() => {
              group.members.forEach((m) => closeTab(m.tab.tabId));
              onClose();
            }}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-fg-muted hover:text-accent-red"
            title="Close all tabs in this group"
          >
            <Icons.X className="w-3 h-3" />
            Close all
          </button>
        </div>

        {/* Member rows — scrolls past ~8. */}
        <div className="max-h-[320px] overflow-y-auto scrollbar-thin py-1">
          {group.members.map(({ tab }) => {
            const active = tab.tabId === activeTabId;
            const domain = tab.url ? prettyHost(tab.url) : null;
            return (
              <div
                key={tab.tabId}
                onClick={() => {
                  selectTab(tab.tabId);
                  onClose();
                }}
                className={`group/row flex items-center gap-2 px-3 py-1.5 cursor-pointer ${
                  active
                    ? 'bg-[var(--color-tab-active-bg)] text-fg-primary'
                    : 'text-fg-secondary hover:bg-[var(--color-tab-hover-bg)]'
                }`}
              >
                <MemberIcon tab={tab} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-fg-primary">{tabLabel(tab)}</div>
                  {domain && <div className="truncate text-[11px] text-fg-muted">{domain}</div>}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.tabId);
                  }}
                  className="shrink-0 p-0.5 opacity-0 group-hover/row:opacity-100 hover:text-accent-red"
                  title="Close tab"
                >
                  <Icons.X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
