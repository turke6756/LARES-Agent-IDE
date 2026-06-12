import React from 'react';
import { useBrowserStore, type BrowserTabState } from '../../stores/browser-store';
import * as Icons from 'lucide-react';

// User-partition vs agent-partition tabs are visually distinct (M9 partition
// discipline made legible): agent tabs carry an orange Bot badge, user tabs a
// blue accent. Agent-attention (plan §4 UX) pulses the tab until selected.

function tabLabel(tab: BrowserTabState): string {
  if (tab.title) return tab.title;
  if (tab.url) {
    try {
      return new URL(tab.url).host || tab.url;
    } catch {
      return tab.url;
    }
  }
  return 'New Tab';
}

export default function BrowserTabStrip() {
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const attentionTabIds = useBrowserStore((s) => s.attentionTabIds);
  const selectTab = useBrowserStore((s) => s.selectTab);
  const closeTab = useBrowserStore((s) => s.closeTab);
  const createTab = useBrowserStore((s) => s.createTab);

  return (
    <div className="flex items-center gap-0.5 px-2 pt-1.5 border-b border-gray-700/50 overflow-x-auto scrollbar-thin shrink-0">
      {tabs.map((tab) => {
        const active = tab.tabId === activeTabId;
        const isAgent = tab.partition === 'agent';
        const attention = Boolean(attentionTabIds[tab.tabId]);
        return (
          <div
            key={tab.tabId}
            onClick={() => selectTab(tab.tabId)}
            title={tab.url || 'New Tab'}
            className={`group flex items-center gap-1.5 px-2.5 py-1.5 max-w-[200px] cursor-pointer border-t-2 text-[12px] select-none ${
              active
                ? `bg-gray-800/80 text-gray-100 ${isAgent ? 'border-accent-orange' : 'border-accent-blue'}`
                : 'bg-transparent text-gray-400 border-transparent hover:bg-gray-800/40'
            } ${attention ? 'animate-pulse ring-1 ring-accent-orange' : ''}`}
          >
            {tab.loading ? (
              <Icons.Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-gray-400" />
            ) : isAgent ? (
              <Icons.Bot className="w-3.5 h-3.5 shrink-0 text-accent-orange" />
            ) : tab.favicon ? (
              <img src={tab.favicon} alt="" className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <Icons.Globe className="w-3.5 h-3.5 shrink-0 text-gray-500" />
            )}
            <span className="truncate">{tabLabel(tab)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.tabId);
              }}
              className="shrink-0 p-0.5 opacity-0 group-hover:opacity-100 hover:text-red-400"
              title="Close tab"
            >
              <Icons.X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
      <button
        onClick={() => void createTab('user')}
        className="ui-btn ui-btn-ghost p-1.5 ml-1 shrink-0"
        title="New tab (your partition — persist:user)"
      >
        <Icons.Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
