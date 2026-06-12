import React, { useEffect } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useBrowserStore, getBrowserApi, ensureBrowserBridge } from '../../stores/browser-store';
import BrowserTabStrip from './BrowserTabStrip';
import AddressBar from './AddressBar';
import BrowserViewHost from './BrowserViewHost';
import * as Icons from 'lucide-react';

// Center-panel browser pane (WP1-B). All chrome (tab strip, address bar,
// notices) lives ABOVE the BrowserViewHost area — the WebContentsView paints
// over renderer DOM, so chrome must never overlap the host div. The URL is
// rendered here in shell chrome, which is what makes it unspoofable by page
// or model output (M9/WP2 rely on this).

export default function BrowserPanel() {
  const hideBrowser = useDashboardStore((s) => s.hideBrowser);
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const pendingOpenUrl = useBrowserStore((s) => s.pendingOpenUrl);
  const acceptOpenRequest = useBrowserStore((s) => s.acceptOpenRequest);
  const dismissOpenRequest = useBrowserStore((s) => s.dismissOpenRequest);
  const createTab = useBrowserStore((s) => s.createTab);
  const clearPaneAttention = useBrowserStore((s) => s.clearPaneAttention);

  const apiPresent = getBrowserApi() !== null;
  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null;

  useEffect(() => {
    ensureBrowserBridge();
    clearPaneAttention();
  }, [clearPaneAttention]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="panel-header h-16 px-4 sticky top-0 z-10 flex items-center shrink-0 app-drag-region">
        <div className="flex items-center gap-3 w-full">
          <button
            onClick={() => hideBrowser()}
            className="ui-btn ui-btn-ghost p-1.5 app-no-drag"
            title="Back to agents"
          >
            <Icons.ArrowLeft className="w-4 h-4" />
          </button>
          <Icons.Globe className="w-4 h-4 text-gray-400" />
          <h2 className="text-[14px] font-semibold text-gray-100">Browser</h2>
          <span className="text-[11px] text-gray-500 truncate">
            sign-ins persist in your partition; agent tabs are isolated
          </span>
        </div>
      </div>

      {!apiPresent ? (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          <div className="text-center max-w-md px-6">
            <Icons.Globe className="w-8 h-8 mx-auto mb-3 text-gray-600" />
            <div className="text-[13px]">
              Browser backend not available — <code>window.api.browser</code> is missing.
            </div>
            <div className="text-[11px] mt-2 text-gray-600">
              The main-process side (WP1-A) hasn't been built into this running app yet.
              Rebuild and restart once it lands.
            </div>
          </div>
        </div>
      ) : (
        <>
          <BrowserTabStrip />
          <AddressBar tab={activeTab} />
          {pendingOpenUrl && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700/50 bg-accent-orange/10 text-[12px] text-gray-200 shrink-0">
              <Icons.ExternalLink className="w-3.5 h-3.5 text-accent-orange shrink-0" />
              <span className="truncate flex-1">
                Page tried to open a new window: <span className="text-gray-400">{pendingOpenUrl}</span>
              </span>
              <button
                onClick={() => void acceptOpenRequest()}
                className="ui-btn ui-btn-outline px-2 py-0.5 text-[11px] shrink-0"
              >
                Open in new tab
              </button>
              <button
                onClick={() => dismissOpenRequest()}
                className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px] shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}
          {tabs.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              <div className="text-center">
                <div className="text-[13px] mb-3">No tabs open</div>
                <button
                  onClick={() => void createTab('user')}
                  className="ui-btn ui-btn-primary px-3 py-1.5 text-[13px] font-medium"
                >
                  <Icons.Plus className="w-4 h-4" />
                  New tab
                </button>
              </div>
            </div>
          ) : (
            <BrowserViewHost />
          )}
        </>
      )}
    </div>
  );
}
