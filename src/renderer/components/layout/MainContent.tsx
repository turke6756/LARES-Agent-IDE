import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentGrid from '../agent/AgentGrid';
import AgentLaunchDialog from '../agent/AgentLaunchDialog';
import FileViewerPanel from '../fileviewer/FileViewerPanel';
import BrowserPanel from '../browser/BrowserPanel';
import { useBrowserStore, ensureBrowserBridge } from '../../stores/browser-store';
import type { AgentStatus } from '../../../shared/types';
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

const SUPERVISOR_STATUS_COLORS: Record<AgentStatus, { dot: string; border: string; bg: string }> = {
  launching: { dot: 'bg-yellow-400', border: 'border-yellow-500/50', bg: 'hover:bg-yellow-500/10' },
  working:   { dot: 'bg-green-400 animate-pulse', border: 'border-green-500/50', bg: 'hover:bg-green-500/10' },
  receiving: { dot: 'bg-purple-400 animate-pulse', border: 'border-purple-500/50', bg: 'hover:bg-purple-500/10' },
  idle:      { dot: 'bg-blue-400', border: 'border-blue-500/50', bg: 'hover:bg-blue-500/10' },
  waiting:   { dot: 'bg-orange-400 animate-pulse', border: 'border-orange-500/50', bg: 'hover:bg-orange-500/10' },
  done:      { dot: 'bg-gray-400', border: 'border-gray-500/50', bg: 'hover:bg-gray-500/10' },
  crashed:   { dot: 'bg-red-400', border: 'border-red-500/50', bg: 'hover:bg-red-500/10' },
  restarting:{ dot: 'bg-yellow-400 animate-pulse', border: 'border-yellow-500/50', bg: 'hover:bg-yellow-500/10' },
};

export default function MainContent() {
  const { workspaces, selectedWorkspaceId, supervisorAgent, fileViewerOpen, browserOpen, openTabs, contextStats } = useDashboardStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      selectedWorkspaceId: s.selectedWorkspaceId,
      supervisorAgent: s.supervisorAgent,
      fileViewerOpen: s.fileViewerOpen,
      browserOpen: s.browserOpen,
      openTabs: s.openTabs,
      contextStats: s.contextStats,
    })),
  );
  const showFileViewer = useDashboardStore((s) => s.showFileViewer);
  const showBrowser = useDashboardStore((s) => s.showBrowser);
  const browserPaneAttention = useBrowserStore((s) => s.paneAttention);
  const loadSupervisor = useDashboardStore((s) => s.loadSupervisor);
  const launchSupervisor = useDashboardStore((s) => s.launchSupervisor);
  const setTerminalAgent = useDashboardStore((s) => s.setTerminalAgent);
  const selectAgent = useDashboardStore((s) => s.selectAgent);
  const [showLaunch, setShowLaunch] = useState(false);
  const [supervisorLoading, setSupervisorLoading] = useState(false);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  // Load supervisor status when workspace changes
  useEffect(() => {
    if (workspace) {
      loadSupervisor(workspace.id);
    }
  }, [workspace?.id, loadSupervisor]);

  const swipeToFiles = useSwipe(() => showFileViewer(), 'left');

  // Subscribe the browser store to main-process tab events. MainContent is
  // always mounted, so agent-opened tabs raise attention even while the pane
  // is closed. No dep array: ensureBrowserBridge is an idempotent no-op once
  // subscribed, and retrying every render covers preload arriving late.
  useEffect(() => {
    ensureBrowserBridge();
  });

  // Center-mode dispatch — file viewer wins over the browser pane.
  if (fileViewerOpen) {
    return <FileViewerPanel />;
  }
  if (browserOpen) {
    return <BrowserPanel />;
  }

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
  const supStats = supervisorAgent ? contextStats[supervisorAgent.id] : null;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
      {/* Header — fixed h-16 to match the sidebar header thickness.
          Doubles as a window-drag surface (the native title bar is hidden). */}
      <div className="panel-header h-16 px-4 sticky top-0 z-10 flex items-center shrink-0 app-drag-region">
        <div className="flex items-center justify-between w-full">
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

          <div className="flex items-center gap-4 app-no-drag">
            {/* Supervisor Card */}
            {supervisorAgent && !['done', 'crashed'].includes(supervisorAgent.status) ? (
              <div className={`hidden md:flex items-center overflow-hidden border ${SUPERVISOR_STATUS_COLORS[supervisorAgent.status].border}`}>
                <button
                  onClick={() => {
                    selectAgent(supervisorAgent.id);
                    setTerminalAgent(supervisorAgent.id);
                  }}
                  className={`flex items-center gap-3 px-3 py-1.5 transition-colors ${SUPERVISOR_STATUS_COLORS[supervisorAgent.status].bg}`}
                  title="Click to attach terminal"
                >
                  <div className="flex flex-col items-start gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${SUPERVISOR_STATUS_COLORS[supervisorAgent.status].dot}`} />
                      <span className="text-[13px] font-semibold text-gray-100">Supervisor</span>
                    </div>
                    <span className="text-[11px] text-gray-400 ml-[16px] capitalize">{supervisorAgent.status}</span>
                  </div>

                  {supStats && (
                    <div className="flex flex-col items-end gap-0.5 ml-3">
                      <span className="text-[11px] font-sans text-gray-400">
                        {Math.round(supStats.contextPercentage)}% ctx
                      </span>
                      <div className="w-20 h-1 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            supStats.contextPercentage > 80 ? 'bg-red-400' :
                            supStats.contextPercentage > 50 ? 'bg-yellow-400' : 'bg-accent-green'
                          }`}
                          style={{ width: `${Math.min(supStats.contextPercentage, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </button>
                <div className={`w-px self-stretch ${SUPERVISOR_STATUS_COLORS[supervisorAgent.status].bg} opacity-40`} />
                <button
                  onClick={async () => {
                    await window.api.agents.delete(supervisorAgent.id);
                    loadSupervisor(workspace.id);
                  }}
                  className={`flex items-center justify-center w-10 self-stretch transition-colors hover:bg-red-500/20 ${SUPERVISOR_STATUS_COLORS[supervisorAgent.status].bg}`}
                  title="Reset Supervisor (stops and clears session)"
                >
                  <Icons.X className="w-4 h-4 text-gray-400 hover:text-red-400" />
                </button>
              </div>
            ) : (
              <button
                onClick={async () => {
                  setSupervisorLoading(true);
                  await launchSupervisor(workspace.id);
                  setSupervisorLoading(false);
                }}
                disabled={supervisorLoading}
                className="ui-btn ui-btn-outline ui-btn-purple hidden md:flex items-center gap-2 px-3 py-1.5"
                title="Launch Supervisor Agent"
              >
                <Icons.Bot className="w-4 h-4" />
                <span className="text-[13px] font-semibold">
                  {supervisorLoading ? 'Launching...' : 'Supervisor'}
                </span>
              </button>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => showFileViewer()}
                className={`ui-btn ui-btn-outline px-3 py-1.5 text-[13px] font-medium ${
                  hasOpenTabs ? 'ui-btn-success' : ''
                }`}
                title={hasOpenTabs ? `Files (${workspaceTabCount} tabs open)` : 'Browse files'}
              >
                <Icons.FileText className="w-4 h-4" />
                Files{hasOpenTabs ? ` (${workspaceTabCount})` : ''}
              </button>
              <button
                onClick={() => showBrowser()}
                className={`ui-btn ui-btn-outline px-3 py-1.5 text-[13px] font-medium ${
                  browserPaneAttention ? 'ui-btn-warning animate-pulse' : ''
                }`}
                title={browserPaneAttention ? 'Browser — an agent opened a page for you' : 'Open browser pane'}
              >
                <Icons.Globe className="w-4 h-4" />
                Browser
              </button>
              <button
                onClick={() => window.api.workspaces.openInVSCode(workspace.id)}
                className="ui-btn ui-btn-outline px-3 py-1.5 text-[13px] font-medium"
                title="Open workspace in VS Code"
              >
                <img src={vscodeIcon} alt="" className="w-4 h-4" />
                Open VS Code
              </button>
              <button
                onClick={() => setShowLaunch(true)}
                className="ui-btn ui-btn-primary px-3 py-1.5 text-[13px] font-medium"
              >
                <Icons.Plus className="w-4 h-4" />
                Launch Agent
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Agent Grid — swipe left to open file viewer */}
      <div
        className="flex-1 overflow-y-auto p-6 scrollbar-thin"
        {...swipeToFiles}
      >
        <AgentGrid />
      </div>

      {showLaunch && (
        <AgentLaunchDialog
          workspace={workspace}
          onClose={() => setShowLaunch(false)}
        />
      )}
    </div>
  );
}
