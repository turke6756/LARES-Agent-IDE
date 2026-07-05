import React, { useEffect, Component, ErrorInfo, ReactNode } from 'react';
import { useDashboardStore } from './stores/dashboard-store';
import Sidebar from './components/layout/Sidebar';
import TopBar from './components/layout/TopBar';
import MainContent from './components/layout/MainContent';
import DetailPanel from './components/layout/DetailPanel';
import TerminalPanel from './components/terminal/TerminalPanel';
import ResizeDivider from './components/layout/ResizeDivider';
import { useResize } from './hooks/useResize';
import { openExternalFileTab } from './components/fileviewer/openFileHelpers';
import DetachedFileView from './components/fileviewer/DetachedFileView';

// Error boundary to catch React render crashes and show the error instead of white screen
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Caught:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-screen bg-surface-0 text-gray-100 p-8">
          <div className="panel-shell max-w-lg rounded-xl p-6">
            <h2 className="text-accent-red font-bold text-lg mb-3">Render Error</h2>
            <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words mb-4 font-mono bg-surface-0 p-3 rounded max-h-60 overflow-auto">
              {this.state.error.message}
              {'\n\n'}
              {this.state.error.stack}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="ui-btn ui-btn-primary text-sm font-medium"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppInner() {
  const loadWorkspaces = useDashboardStore((s) => s.loadWorkspaces);
  const checkHealth = useDashboardStore((s) => s.checkHealth);
  const setPanelSize = useDashboardStore((s) => s.setPanelSize);
  const panelLayout = useDashboardStore((s) => s.panelLayout);
  const terminalAgentId = useDashboardStore((s) => s.terminalAgentId);

  useEffect(() => {
    loadWorkspaces();
    checkHealth();
    useDashboardStore.getState().loadAgentStatuses().catch(() => {
      /* best effort — subsequent status events repopulate the index */
    });

    const unsubStatus = window.api.onAgentStatusChanged(({ agent }) => {
      if (!agent) return;
      const store = useDashboardStore.getState();
      // Unguarded: keeps background-workspace heat/waiting live.
      store.updateAgentStatusSnapshot(agent);
      // Scoped upsert (selected workspace only) — existing behavior, unchanged.
      store.updateAgent(agent);
    });

    const unsubAgentDeleted = window.api.onAgentDeleted(({ agentId }) => {
      // removeAgent now clears both the scoped `agents` array and the index.
      useDashboardStore.getState().removeAgent(agentId);
    });

    const unsubContext = window.api.agents.onContextStatsChanged((stats) => {
      useDashboardStore.getState().updateContextStats(stats);
    });

    // Account-wide Claude subscription usage limits (singleton). Seed the
    // current reading on mount, then keep it in sync — the broadcast only fires
    // on change, so a fresh renderer would otherwise show nothing until the next
    // capture.
    const pollUsageLimits = () =>
      window.api.usage.getLimits()
        .then((r) => useDashboardStore.getState().updateUsageLimits(r))
        .catch(() => { /* best effort — next broadcast will populate it */ });
    pollUsageLimits();
    const unsubUsage = window.api.usage.onLimitsChanged((r) =>
      useDashboardStore.getState().updateUsageLimits(r));
    // The broadcast only fires when a NEW capture merges (an agent taking a
    // turn). Between captures `age_seconds`/`stale` are frozen at emit time, so
    // an idle dashboard's freshness cue goes silent. Re-poll on an interval —
    // getLimits() recomputes age/stale against Date.now() on the main side — so
    // the gauge keeps ticking (and flips to stale/dimmed) even when nothing runs.
    const usagePoll = window.setInterval(pollUsageLimits, 30_000);

    const unsubTeam = window.api.onTeamUpdated((team) => {
      useDashboardStore.getState().updateTeam(team);
    });

    const unsubTeamMsg = window.api.onTeamMessageCreated((message) => {
      useDashboardStore.getState().addTeamMessage(message);
    });

    // Active orchestration deliberations (groupthink). Seed the current set on
    // mount — the broadcast below only fires on change, so a renderer that
    // mounts mid-deliberation would otherwise miss the pulse — then keep it in
    // sync. Drives the owner-container border pulse through the idle gaps
    // between deliberation turns.
    window.api.listActiveOrchestrations()
      .then((ids) => useDashboardStore.getState().setDeliberatingSupervisorIds(ids))
      .catch(() => { /* best effort — next broadcast will populate it */ });
    const unsubDeliberation = window.api.onOrchestrationActiveChanged((ids) => {
      useDashboardStore.getState().setDeliberatingSupervisorIds(ids);
    });

    // Agent-initiated "open this file for the user" (open_file_in_view MCP
    // tool → main → file:open-tab). Lives here, not in FileViewerPanel,
    // because the panel unmounts whenever the viewer is closed.
    const unsubOpenFileTab = window.api.onOpenFileTab((payload) => {
      openExternalFileTab(payload);
    });

    // A detached (tear-off) window closed → re-add the file as a tab in the
    // shell strip from disk (detachable-file-tabs-plan §4 1.9). The closing
    // window saves/discards in-window before emitting `closed`, so the disk
    // content is authoritative.
    const unsubDetachedClosed = window.api.tabs.onDetachedClosed((p) => {
      openExternalFileTab(p);
    });

    return () => {
      unsubStatus();
      unsubAgentDeleted();
      unsubContext();
      unsubUsage();
      window.clearInterval(usagePoll);
      unsubTeam();
      unsubTeamMsg();
      unsubDeliberation();
      unsubOpenFileTab();
      unsubDetachedClosed();
    };
  }, []);

  const sidebarResize = useResize({
    direction: 'horizontal',
    initialSize: panelLayout.sidebarWidth,
    min: 180,
    max: 500,
    storageKey: 'panel-sidebar-width',
  });

  const detailResize = useResize({
    direction: 'horizontal',
    initialSize: panelLayout.detailPanelWidth,
    min: 280,
    max: 700,
    storageKey: 'panel-detail-width',
    invert: true,
  });

  const terminalResize = useResize({
    direction: 'vertical',
    initialSize: panelLayout.terminalHeight,
    min: 100,
    max: 600,
    storageKey: 'panel-terminal-height',
    invert: true,
  });

  // Sync resize values to store when they change
  useEffect(() => {
    setPanelSize('sidebarWidth', sidebarResize.size);
  }, [sidebarResize.size]);

  useEffect(() => {
    setPanelSize('detailPanelWidth', detailResize.size);
  }, [detailResize.size]);

  useEffect(() => {
    setPanelSize('terminalHeight', terminalResize.size);
  }, [terminalResize.size]);

  const sidebarCollapsed = panelLayout.sidebarCollapsed;
  const detailCollapsed = panelLayout.detailPanelCollapsed;

  return (
    <div className="flex flex-col h-screen bg-surface-0 text-gray-100 grid-bg relative overflow-hidden">
      <div className="scanlines pointer-events-none" />

      {/* Spanning top chrome — the "one unit" tier above the three panels.
          Hosts window drag, app menus, and the native min/max/close overlay. */}
      <TopBar />

      {/* Three-panel row */}
      <div className="flex flex-1 min-h-0 min-w-0 relative">
        {/* Sidebar */}
        <Sidebar width={sidebarCollapsed ? 40 : sidebarResize.size} />

        {/* Sidebar resize divider */}
        {!sidebarCollapsed && (
          <ResizeDivider
            direction="horizontal"
            isResizing={sidebarResize.isResizing}
            onMouseDown={sidebarResize.handleMouseDown}
          />
        )}

        {/* Center + Detail */}
        <div className="flex flex-1 min-w-0 min-h-0 z-10">
          {/* Main content column (with terminal below) */}
          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            <MainContent />

            {/* Terminal resize divider (above terminal) — hidden when collapsed */}
            {terminalAgentId !== null && !panelLayout.terminalCollapsed && (
              <ResizeDivider
                direction="vertical"
                isResizing={terminalResize.isResizing}
                onMouseDown={terminalResize.handleMouseDown}
              />
            )}

            <TerminalPanel height={terminalResize.size} />
          </div>

          {/* Detail resize divider */}
          {!detailCollapsed && (
            <ResizeDivider
              direction="horizontal"
              isResizing={detailResize.isResizing}
              onMouseDown={detailResize.handleMouseDown}
            />
          )}

          {/* Detail panel — full height, independent of terminal */}
          <DetailPanel width={detailCollapsed ? 40 : detailResize.size} />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  // Detached (tear-off) file-tab window: same renderer bundle, but a minimal
  // single-file viewer instead of the full dashboard shell (detachable-file-
  // tabs-plan §4 1.8). Branch on the `?detached=1` query main encodes at launch.
  const params = new URLSearchParams(window.location.search);
  if (params.get('detached')) {
    return (
      <ErrorBoundary>
        <DetachedFileView params={params} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
