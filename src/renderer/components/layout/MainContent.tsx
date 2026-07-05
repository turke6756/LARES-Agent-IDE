import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentGrid from '../agent/AgentGrid';
import AgentLaunchDialog from '../agent/AgentLaunchDialog';
import FileViewerPanel from '../fileviewer/FileViewerPanel';
import BrowserPanel from '../browser/BrowserPanel';
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

export default function MainContent() {
  const { workspaces, selectedWorkspaceId, fileViewerOpen, browserOpen, openTabs } = useDashboardStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      selectedWorkspaceId: s.selectedWorkspaceId,
      fileViewerOpen: s.fileViewerOpen,
      browserOpen: s.browserOpen,
      openTabs: s.openTabs,
    })),
  );
  const showFileViewer = useDashboardStore((s) => s.showFileViewer);
  const showBrowser = useDashboardStore((s) => s.showBrowser);
  const showDashboard = useDashboardStore((s) => s.showDashboard);
  const browserPaneAttention = useBrowserStore((s) => s.paneAttention);
  const [showLaunch, setShowLaunch] = useState(false);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  const swipeToFiles = useSwipe(() => showFileViewer(), 'left');

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
  // Center-view dispatch — file viewer wins over the browser pane.
  const dashboardActive = !fileViewerOpen && !browserOpen;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
      {/* Header — fixed h-16 to match the sidebar header thickness.
          Doubles as a window-drag surface (the native title bar is hidden). */}
      <div className="panel-header h-16 px-4 sticky top-0 z-10 flex items-center shrink-0 app-drag-region">
        <div ref={headerRowRef} className="flex items-center justify-between w-full gap-3 min-w-0">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[14px] font-semibold text-gray-100 truncate">
                {workspace.title}
              </h2>
            </div>

            <div className="flex items-center gap-3 mt-0.5">
              <span className="text-[11px] text-gray-500">
                {workspace.path}
              </span>
              <span
                className={`text-[11px] px-1.5 py-0.5 font-semibold ${
                  workspace.pathType === 'wsl'
                    ? 'text-accent-orange bg-accent-orange/10'
                    : 'text-accent-blue bg-accent-blue/10'
                }`}
              >
                {workspace.pathType === 'wsl' ? 'WSL' : 'Windows'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4 app-no-drag shrink-0">
            {/* No workspace-supervisor singleton: a supervisor is just one of
                the agent types in the Launch Agent dialog, launchable as many
                times as wanted. Each renders as its own grid card with its
                launched agents nested beneath (buildAgentForest). */}
            <div ref={toolbarRef} className="flex gap-2">
              <button
                onClick={() => showDashboard()}
                className={`ui-btn ui-btn-outline shrink-0 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium ${
                  dashboardActive ? 'ui-btn-success is-active' : ''
                }`}
                title="Agent dashboard"
              >
                <Icons.LayoutGrid className="w-4 h-4 shrink-0" />
                {!toolbarCompact && 'Dashboard'}
              </button>
              <button
                onClick={() => showFileViewer()}
                className={`ui-btn ui-btn-outline shrink-0 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium ${
                  fileViewerOpen ? 'ui-btn-success is-active' : hasOpenTabs ? 'ui-btn-success' : ''
                }`}
                title={hasOpenTabs ? `Files (${workspaceTabCount} tabs open)` : 'Browse files'}
              >
                <Icons.FileText className="w-4 h-4 shrink-0" />
                {toolbarCompact ? (hasOpenTabs ? workspaceTabCount : '') : `Files${hasOpenTabs ? ` (${workspaceTabCount})` : ''}`}
              </button>
              <button
                onClick={() => showBrowser()}
                className={`ui-btn ui-btn-outline shrink-0 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium ${
                  browserOpen && !fileViewerOpen ? 'ui-btn-success is-active' : browserPaneAttention ? 'ui-btn-warning animate-pulse' : ''
                }`}
                title={browserPaneAttention ? 'Browser — an agent opened a page for you' : 'Open browser pane'}
              >
                <Icons.Globe className="w-4 h-4 shrink-0" />
                {!toolbarCompact && 'Browser'}
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

      {/* Center view — header above stays fixed across all three. */}
      {fileViewerOpen ? (
        <FileViewerPanel />
      ) : browserOpen ? (
        <BrowserPanel />
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
