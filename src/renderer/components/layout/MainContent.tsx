import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentGrid from '../agent/AgentGrid';
import AgentLaunchDialog from '../agent/AgentLaunchDialog';
import FileViewerPanel from '../fileviewer/FileViewerPanel';
import BrowserPanel from '../browser/BrowserPanel';
import PlansMenu from '../plan/PlansMenu';
import SaveCard from '../save/SaveCard';
import { useBrowserStore, ensureBrowserBridge } from '../../stores/browser-store';
import * as Icons from 'lucide-react';
import vscodeIcon from '../../assets/material-icons/vscode.svg';

function useSwipe(onSwipe: () => void, direction: 'left' | 'right') {
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = Math.abs(e.clientY - startRef.current.y);
    startRef.current = null;
    // 80px threshold, must be mostly horizontal
    if (Math.abs(dx) > 80 && dy < 60) {
      if (direction === 'left' && dx < 0) onSwipe();
      if (direction === 'right' && dx > 0) onSwipe();
    }
  }, [onSwipe, direction]);

  return { onPointerDown, onPointerUp };
}

// Shown in the center slot when the selected view is torn off into its own OS
// window — the view is non-activatable in the main window until that window
// closes (view-detach §5).
function DetachedViewPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-gray-500 p-6">
      <div className="max-w-sm text-center panel-shell rounded-xl p-6" style={{ borderStyle: 'dashed' }}>
        <Icons.ExternalLink className="w-6 h-6 mx-auto mb-3 opacity-60" />
        <div className="text-[13px] text-gray-300">
          The {label} is open in a separate window.
        </div>
        <div className="text-[12px] text-gray-500 mt-1">
          Close that window to bring it back here.
        </div>
      </div>
    </div>
  );
}

export default function MainContent() {
  const { workspaces, selectedWorkspaceId, fileViewerOpen, browserOpen, saveCardOpen, openTabs, detachedViews } = useDashboardStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      selectedWorkspaceId: s.selectedWorkspaceId,
      fileViewerOpen: s.fileViewerOpen,
      browserOpen: s.browserOpen,
      saveCardOpen: s.saveCardOpen,
      openTabs: s.openTabs,
      detachedViews: s.detachedViews,
    })),
  );
  const showFileViewer = useDashboardStore((s) => s.showFileViewer);
  const showBrowser = useDashboardStore((s) => s.showBrowser);
  const showDashboard = useDashboardStore((s) => s.showDashboard);
  const showSaveCard = useDashboardStore((s) => s.showSaveCard);
  const browserPaneAttention = useBrowserStore((s) => s.paneAttention);
  const [showLaunch, setShowLaunch] = useState(false);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  const swipeToFiles = useSwipe(() => showFileViewer(), 'left');

  const dashboardDetached = detachedViews.includes('dashboard');
  const filesDetached = detachedViews.includes('files');
  const browserDetached = detachedViews.includes('browser');
  const plansDetached = detachedViews.includes('plans');

  // View tear-off gesture — the HTML5-drag-out-of-window pattern copied from
  // FileTabBar.handleDragEnd. A drag that ends with no accepting drop target
  // (dropEffect 'none') spawns a detached OS window for that view at the cursor
  // and hollows out the button. screenX/Y and dropEffect are read SYNCHRONOUSLY
  // (the event is neutered after the first await). All four center views are
  // draggable: Dashboard + Files (pure renderer DOM) and Browser + Plans (their
  // main-process WebContentsView re-parents into the detached window on detach).
  type DraggableView = 'dashboard' | 'files' | 'plans' | 'browser';
  const handleViewDragStart = (e: React.DragEvent, view: DraggableView) => {
    e.dataTransfer.setData('text/plain', `view:${view}`);
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleViewDragEnd = async (e: React.DragEvent, view: DraggableView) => {
    const accepted = e.dataTransfer.dropEffect !== 'none';
    const capturedX = e.screenX;
    const capturedY = e.screenY;
    if (accepted) return; // dropped somewhere in-app — not a tear-off
    const store = useDashboardStore.getState();
    const workspaceId = store.selectedWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === workspaceId);
    if (!workspaceId || !ws) return;
    const res = await window.api.views.detach({
      view,
      workspaceId,
      label: ws.title,
      x: capturedX,
      y: capturedY,
    });
    if (res.ok && !res.focusedExisting) {
      useDashboardStore.getState().markViewDetached(view);
    }
  };

  // Subscribe the browser store to main-process tab events. MainContent is
  // always mounted, so agent-opened tabs raise attention even while the pane
  // is closed. No dep array: ensureBrowserBridge is an idempotent no-op once
  // subscribed, and retrying every render covers preload arriving late.
  useEffect(() => {
    ensureBrowserBridge();
  });

  // Header toolbar responsive collapse. The five action buttons (Dashboard,
  // Files, Browser, Open VS Code, Launch Agent) keep their labels while there
  // is room, then drop to icon-only when the header gets too narrow — instead
  // of squishing (clipped text) or bleeding past the header bounds. We measure
  // the button group's full labelled width once (captured only while expanded,
  // so it survives the collapse) and compare it against the available header
  // width, reserving a slice for the workspace title. Hysteresis on the way
  // back out avoids oscillation right at the breakpoint.
  const headerRowRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const fullToolbarWidth = useRef(0);
  const [toolbarCompact, setToolbarCompact] = useState(false);

  useLayoutEffect(() => {
    const row = headerRowRef.current;
    const toolbar = toolbarRef.current;
    if (!row || !toolbar) return;

    const TITLE_MIN = 140; // px kept for the workspace title/path column
    const HYSTERESIS = 32; // px slack before re-expanding, prevents flip-flop

    const measure = () => {
      if (!toolbarCompact) fullToolbarWidth.current = toolbar.scrollWidth;
      const needed = fullToolbarWidth.current + TITLE_MIN;
      const avail = row.clientWidth;
      setToolbarCompact((prev) => {
        if (!prev) return avail < needed;
        return avail < needed + HYSTERESIS; // stay compact until clearly roomy
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [toolbarCompact, selectedWorkspaceId]);

  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <div className="text-center">
          <div className="text-[13px]">
            Select a workspace to begin
          </div>
        </div>
      </div>
    );
  }

  const workspaceTabCount = openTabs.filter((t) => t.workspaceId === selectedWorkspaceId).length;
  const hasOpenTabs = workspaceTabCount > 0;
  // Center-view dispatch — precedence file viewer > browser > save card >
  // dashboard grid. The Save card is a read-only peer surface (SC-WP-1I).
  const dashboardActive = !fileViewerOpen && !browserOpen && !saveCardOpen;
  const saveCardActive = saveCardOpen && !fileViewerOpen && !browserOpen;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
      {/* Header — fixed h-16 to match the sidebar header thickness.
          Doubles as a window-drag surface (the native title bar is hidden). */}
      <div className="panel-header h-16 px-4 sticky top-0 z-10 flex items-center shrink-0 app-drag-region">
        <div ref={headerRowRef} className="flex items-center justify-between w-full gap-3 min-w-0">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[18px] font-bold text-gray-100 truncate">
                {workspace.title}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-4 app-no-drag shrink-0">
            {/* No workspace-supervisor singleton: a supervisor is just one of
                the agent types in the Launch Agent dialog, launchable as many
                times as wanted. Each renders as its own grid card with its
                launched agents nested beneath (buildAgentForest). */}
            <div ref={toolbarRef} className="flex gap-2">
              <button
                data-testid="view-btn-dashboard"
                draggable={!dashboardDetached}
                onDragStart={(e) => handleViewDragStart(e, 'dashboard')}
                onDragEnd={(e) => handleViewDragEnd(e, 'dashboard')}
                onClick={() => { if (!dashboardDetached) showDashboard(); }}
                aria-disabled={dashboardDetached}
                className={`ui-btn ui-btn-outline shrink-0 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium ${
                  dashboardDetached
                    ? 'opacity-40 cursor-not-allowed border-dashed'
                    : dashboardActive ? 'ui-btn-success is-active' : ''
                }`}
                style={dashboardDetached ? { borderStyle: 'dashed' } : undefined}
                title={dashboardDetached ? 'Dashboard is open in a separate window — close it to restore' : 'Agent dashboard — drag out to open in its own window'}
              >
                <Icons.LayoutGrid className="w-4 h-4 shrink-0" />
                {!toolbarCompact && 'Dashboard'}
              </button>
              <button
                data-testid="view-btn-files"
                draggable={!filesDetached}
                onDragStart={(e) => handleViewDragStart(e, 'files')}
                onDragEnd={(e) => handleViewDragEnd(e, 'files')}
                onClick={() => { if (!filesDetached) showFileViewer(); }}
                aria-disabled={filesDetached}
                className={`ui-btn ui-btn-outline shrink-0 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium ${
                  filesDetached
                    ? 'opacity-40 cursor-not-allowed'
                    : fileViewerOpen ? 'ui-btn-success is-active' : hasOpenTabs ? 'ui-btn-success' : ''
                }`}
                style={filesDetached ? { borderStyle: 'dashed' } : undefined}
                title={filesDetached ? 'Files is open in a separate window — close it to restore' : hasOpenTabs ? `Files (${workspaceTabCount} tabs open) — drag out to open in its own window` : 'Browse files — drag out to open in its own window'}
              >
                <Icons.FileText className="w-4 h-4 shrink-0" />
                {toolbarCompact ? (hasOpenTabs ? workspaceTabCount : '') : `Files${hasOpenTabs ? ` (${workspaceTabCount})` : ''}`}
              </button>
              <button
                data-testid="view-btn-browser"
                draggable={!browserDetached}
                onDragStart={(e) => handleViewDragStart(e, 'browser')}
                onDragEnd={(e) => handleViewDragEnd(e, 'browser')}
                onClick={() => { if (!browserDetached) showBrowser(); }}
                aria-disabled={browserDetached}
                className={`ui-btn ui-btn-outline shrink-0 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium ${
                  browserDetached
                    ? 'opacity-40 cursor-not-allowed'
                    : browserOpen && !fileViewerOpen ? 'ui-btn-success is-active' : browserPaneAttention ? 'ui-btn-warning animate-pulse' : ''
                }`}
                style={browserDetached ? { borderStyle: 'dashed' } : undefined}
                title={browserDetached ? 'Browser is open in a separate window — close it to restore' : browserPaneAttention ? 'Browser — an agent opened a page for you' : 'Open browser pane — drag out to open in its own window'}
              >
                <Icons.Globe className="w-4 h-4 shrink-0" />
                {!toolbarCompact && 'Browser'}
              </button>
              <PlansMenu
                compact={toolbarCompact}
                detached={plansDetached}
                onDragStart={(e) => handleViewDragStart(e, 'plans')}
                onDragEnd={(e) => handleViewDragEnd(e, 'plans')}
              />
              <button
                data-testid="view-btn-save"
                onClick={showSaveCard}
                className={`ui-btn ui-btn-outline shrink-0 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium ${
                  saveCardActive ? 'ui-btn-success is-active' : ''
                }`}
                title="Save progress — inspect uncommitted work (read-only)"
              >
                <Icons.Save className="w-4 h-4 shrink-0" />
                {!toolbarCompact && 'Save'}
              </button>
              <button
                onClick={() => window.api.workspaces.openInVSCode(workspace.id)}
                className="ui-btn ui-btn-outline shrink-0 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium"
                title="Open workspace in VS Code"
              >
                <img src={vscodeIcon} alt="" className="w-4 h-4 shrink-0" />
                {!toolbarCompact && 'Open VS Code'}
              </button>
              <button
                onClick={() => setShowLaunch(true)}
                className="ui-btn ui-btn-primary shrink-0 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium"
                title="Launch Agent"
              >
                <Icons.Plus className="w-4 h-4 shrink-0" />
                {!toolbarCompact && 'Launch Agent'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Center view — header above stays fixed across all three. A detached
          view's slot is non-activatable (view-detach §5): when the selected
          center view is torn off, its slot shows a placeholder pointing at the
          external window instead. Selection order mirrors the flags: Files >
          Browser > Dashboard(grid). */}
      {fileViewerOpen && !filesDetached ? (
        <FileViewerPanel />
      ) : browserOpen && !browserDetached ? (
        <BrowserPanel />
      ) : browserOpen && browserDetached ? (
        <DetachedViewPlaceholder label="Browser" />
      ) : fileViewerOpen && filesDetached ? (
        <DetachedViewPlaceholder label="Files" />
      ) : saveCardActive ? (
        <SaveCard />
      ) : dashboardDetached ? (
        <DetachedViewPlaceholder label="Dashboard" />
      ) : (
        /* Agent Grid — swipe left to open file viewer */
        <div
          className="flex-1 overflow-y-auto p-6 scrollbar-thin"
          {...swipeToFiles}
        >
          <AgentGrid />
        </div>
      )}

      {showLaunch && (
        <AgentLaunchDialog
          workspace={workspace}
          onClose={() => setShowLaunch(false)}
        />
      )}
    </div>
  );
}
