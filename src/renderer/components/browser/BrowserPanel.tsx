import React, { useEffect, useMemo } from 'react';
import { useBrowserStore, getBrowserApi, ensureBrowserBridge, selectVisibleTabs } from '../../stores/browser-store';
import BrowserTabStrip from './BrowserTabStrip';
import AddressBar from './AddressBar';
import BrowserViewHost from './BrowserViewHost';
import BookmarksBar from './BookmarksBar';
import FindBar from './FindBar';
import HistoryView from './HistoryView';
import ReadingModeView from './ReadingModeView';
import WebsiteAccessSettings from './WebsiteAccessSettings';
import SigninHandoffBanner from './SigninHandoffBanner';
import ActivityDrawer from './ActivityDrawer';
import DenialToast from './DenialToast';
import DownloadsShelf from './DownloadsShelf';
import * as Icons from 'lucide-react';

// Center-panel browser pane (WP1-B). All chrome (tab strip, address bar,
// notices) lives ABOVE the BrowserViewHost area — the WebContentsView paints
// over renderer DOM, so chrome must never overlap the host div. The URL is
// rendered here in shell chrome, which is what makes it unspoofable by page
// or model output (M9/WP2 rely on this).
//
// WP1-TABS: the chrome is wrapped in .browser-chrome (token-backed, light+dark)
// and reserves two insertion slots between the AddressBar and the host:
//   • BOOKMARKS-BAR slot — WP3 (BookmarksBar, .bookmark-bar).
//   • FIND-BAR slot      — WP5 (FindBar), a slim bar above the host.
// Both are intentionally empty placeholders now.

export default function BrowserPanel() {
  // Per-workspace isolation: only this workspace's tabs are visible here.
  // (Subscribe to the raw inputs + memo so we don't return a fresh array on
  // every unrelated store change.)
  const allTabs = useBrowserStore((s) => s.tabs);
  const selectedWorkspaceId = useBrowserStore((s) => s.selectedWorkspaceId);
  const tabs = useMemo(
    () => selectVisibleTabs({ tabs: allTabs, selectedWorkspaceId }),
    [allTabs, selectedWorkspaceId],
  );
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const pendingOpenUrl = useBrowserStore((s) => s.pendingOpenUrl);
  const acceptOpenRequest = useBrowserStore((s) => s.acceptOpenRequest);
  const dismissOpenRequest = useBrowserStore((s) => s.dismissOpenRequest);
  const createTab = useBrowserStore((s) => s.createTab);
  const selectTab = useBrowserStore((s) => s.selectTab);
  const clearPaneAttention = useBrowserStore((s) => s.clearPaneAttention);
  // Slice 10/11: a dismissible "Restored N tabs" note shown on first paint after
  // a session restore (only while restoredCount > 0).
  const restoredCount = useBrowserStore((s) => s.restoredCount);
  const dismissRestoredNote = useBrowserStore((s) => s.dismissRestoredNote);

  const apiPresent = getBrowserApi() !== null;
  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null;

  useEffect(() => {
    ensureBrowserBridge();
    clearPaneAttention();
  }, [clearPaneAttention]);

  // Ctrl/Cmd+1..9 → jump to the Nth visible tab (9 = last, Chrome semantics).
  // Renderer-scoped: this fires when focus is in the browser CHROME (address
  // bar / NTP / buttons). When the WebContentsView page itself is focused the
  // main process owns key chords (before-input-event); new-tab (Ctrl+T) and
  // close-tab (Ctrl+W) are mapped there. Tabs are matched in store order.
  const onChromeKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key < '1' || e.key > '9') return;
    const n = Number(e.key);
    const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
    if (target) {
      e.preventDefault();
      selectTab(target.tabId);
    }
  };

  return (
    <div
      className="browser-chrome relative flex-1 flex flex-col min-w-0 overflow-hidden"
      onKeyDown={onChromeKeyDown}
    >
      {!apiPresent ? (
        <div className="flex-1 flex items-center justify-center text-fg-muted">
          <div className="text-center max-w-md px-6">
            <Icons.Globe className="w-8 h-8 mx-auto mb-3 text-fg-muted" />
            <div className="text-[13px]">
              Browser backend not available — <code>window.api.browser</code> is missing.
            </div>
            <div className="text-[11px] mt-2 text-fg-muted">
              The main-process side (WP1-A) hasn't been built into this running app yet.
              Rebuild and restart once it lands.
            </div>
          </div>
        </div>
      ) : (
        <>
          <BrowserTabStrip />
          <AddressBar tab={activeTab} />

          {/* ── BOOKMARKS BAR (WP3 BookmarksBar) — between the address bar and
              the host; self-gates on bookmarkBarVisible. ── */}
          <BookmarksBar />

          {/* ── FIND BAR (WP5 FindBar) — slim bar above the host (no paint-over
              hazard); self-gates on findOpen. ── */}
          <FindBar />

          {/* ── SIGN-IN HAND-OFF banner (§15) — four-point consent, shown in the
              chrome (NOT the pane-suspending overlay) while the visible
              quarantined login tab is up. Self-gates on signinHandoff. ── */}
          <SigninHandoffBanner />

          {/* ── Slice 10/11: "Restored N tabs" note — dismissible, first paint
              only. Restored tabs are frozen snapshots until activated. ── */}
          {restoredCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-browser-divider bg-accent-blue/10 text-[12px] text-fg-primary shrink-0">
              <Icons.History className="w-3.5 h-3.5 text-accent-blue shrink-0" />
              <span className="truncate flex-1">
                Restored {restoredCount} {restoredCount === 1 ? 'tab' : 'tabs'} from your last
                session — click one to load it.
              </span>
              <button
                onClick={() => dismissRestoredNote()}
                className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px] shrink-0"
                title="Dismiss"
              >
                Dismiss
              </button>
            </div>
          )}

          {pendingOpenUrl && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-browser-divider bg-accent-orange/10 text-[12px] text-fg-primary shrink-0">
              <Icons.ExternalLink className="w-3.5 h-3.5 text-accent-orange shrink-0" />
              <span className="truncate flex-1">
                Page tried to open a new window: <span className="text-fg-secondary">{pendingOpenUrl}</span>
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
          {/* Host area is the positioning context for the HistoryView overlay,
              which paints absolute inset-0 over the page region (and suspends
              the WebContentsView via useBrowserSuspension) while open. */}
          <div className="relative flex-1 flex flex-col min-h-0">
            {tabs.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-fg-muted">
                <div className="text-center">
                  <div className="text-[13px] mb-3">No tabs open</div>
                  <button
                    onClick={() => void createTab('user')}
                    className="ui-btn ui-btn-primary px-3 py-1.5 text-[13px] font-medium"
                  >
                    <Icons.Plus className="w-4 h-4" />
                    New tab
                  </button>
                  <div className="text-[11px] mt-3 text-fg-muted">
                    sign-ins persist in your partition; agent tabs are isolated
                  </div>
                </div>
              </div>
            ) : (
              <BrowserViewHost />
            )}
            <HistoryView />
            {/* Slice 14: reader overlay — paints absolute inset-0 over the page
                region and suspends the WebContentsView (useBrowserSuspension)
                for its lifetime. Self-gates on readerArticle. */}
            <ReadingModeView />
            <WebsiteAccessSettings />
            {/* Slice-3: live Activity/Audit drawer — right slide-over that
                suspends the WebContentsView for its lifetime. Self-gates on
                auditDrawerOpen. */}
            <ActivityDrawer />
          </div>

          {/* ── Slice 13: downloads shelf — a chrome-zone strip BELOW the host
              (a flex sibling outside the WebContentsView bounds, so it never
              overlaps the live page → no pane suspension needed, mirroring the
              DenialToast occlusion rule). Self-gates: hidden when there are no
              records and no pending confirm. ── */}
          <DownloadsShelf />

          {/* Slice-3: denial toasts — pinned to the top-right chrome zone (above
              the host), so they DON'T need to suspend the pane. Self-gates on an
              empty toast stack. */}
          <DenialToast />
        </>
      )}
    </div>
  );
}
