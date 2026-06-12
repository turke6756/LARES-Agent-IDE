// @vitest-environment jsdom
/**
 * WP-NAV dashboard-landing semantics: showDashboard() returns to the
 * agent-card grid, and selectWorkspace() always lands on the dashboard view
 * while preserving open tabs (re-pointing activeTabId to the new workspace).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useDashboardStore } from './dashboard-store';

beforeEach(() => {
  // selectWorkspace fires loadAgents/loadTeams; stub the preload bridge.
  (window as unknown as { api: unknown }).api = {
    agents: { list: vi.fn().mockResolvedValue([]) },
    teams: { list: vi.fn().mockResolvedValue([]) },
  };
  useDashboardStore.setState({
    browserOpen: false,
    fileViewerOpen: false,
    openTabs: [],
    activeTabId: null,
    tabEditState: {},
    workspaces: [],
    selectedWorkspaceId: 'ws-1',
    selectedAgentId: null,
    terminalAgentId: null,
    terminalPinned: false,
  });
});

describe('showDashboard', () => {
  it('clears the file viewer flag', () => {
    useDashboardStore.setState({ fileViewerOpen: true });
    useDashboardStore.getState().showDashboard();
    const s = useDashboardStore.getState();
    expect(s.fileViewerOpen).toBe(false);
    expect(s.browserOpen).toBe(false);
  });

  it('clears the browser flag', () => {
    useDashboardStore.setState({ browserOpen: true });
    useDashboardStore.getState().showDashboard();
    const s = useDashboardStore.getState();
    expect(s.fileViewerOpen).toBe(false);
    expect(s.browserOpen).toBe(false);
  });

  it('preserves open tabs and the active tab — only the view resets', () => {
    useDashboardStore.getState().openTab('C:/ws/a.ts', 'C:/ws', 'windows', undefined, 'ws-1');
    const { openTabs, activeTabId } = useDashboardStore.getState();
    useDashboardStore.getState().showDashboard();
    const s = useDashboardStore.getState();
    expect(s.fileViewerOpen).toBe(false);
    expect(s.openTabs).toEqual(openTabs);
    expect(s.activeTabId).toBe(activeTabId);
  });
});

describe('selectWorkspace lands on the dashboard view', () => {
  it('resets the file viewer when switching workspaces from the file view', () => {
    useDashboardStore.getState().openTab('C:/ws1/a.ts', 'C:/ws1', 'windows', undefined, 'ws-1');
    useDashboardStore.getState().openTab('C:/ws2/b.ts', 'C:/ws2', 'windows', undefined, 'ws-2');
    expect(useDashboardStore.getState().fileViewerOpen).toBe(true);

    useDashboardStore.getState().selectWorkspace('ws-1');
    const s = useDashboardStore.getState();
    expect(s.fileViewerOpen).toBe(false);
    expect(s.browserOpen).toBe(false);
    expect(s.selectedWorkspaceId).toBe('ws-1');
  });

  it('resets the browser pane when switching workspaces from the browser view', () => {
    useDashboardStore.getState().showBrowser();
    expect(useDashboardStore.getState().browserOpen).toBe(true);

    useDashboardStore.getState().selectWorkspace('ws-2');
    const s = useDashboardStore.getState();
    expect(s.browserOpen).toBe(false);
    expect(s.fileViewerOpen).toBe(false);
  });

  it('preserves openTabs and re-points activeTabId to a tab of the new workspace', () => {
    useDashboardStore.getState().openTab('C:/ws2/b.ts', 'C:/ws2', 'windows', undefined, 'ws-2');
    const ws2TabId = useDashboardStore.getState().activeTabId;
    useDashboardStore.getState().openTab('C:/ws1/a.ts', 'C:/ws1', 'windows', undefined, 'ws-1');
    expect(useDashboardStore.getState().activeTabId).not.toBe(ws2TabId);

    useDashboardStore.getState().selectWorkspace('ws-2');
    const s = useDashboardStore.getState();
    expect(s.openTabs).toHaveLength(2);
    expect(s.activeTabId).toBe(ws2TabId);
    expect(s.fileViewerOpen).toBe(false);
  });

  it('keeps activeTabId when it already belongs to the new workspace', () => {
    useDashboardStore.getState().openTab('C:/ws1/a.ts', 'C:/ws1', 'windows', undefined, 'ws-1');
    const tabId = useDashboardStore.getState().activeTabId;

    useDashboardStore.getState().selectWorkspace('ws-1');
    expect(useDashboardStore.getState().activeTabId).toBe(tabId);
  });

  it('nulls activeTabId when the new workspace has no tabs, keeping other tabs alive', () => {
    useDashboardStore.getState().openTab('C:/ws1/a.ts', 'C:/ws1', 'windows', undefined, 'ws-1');

    useDashboardStore.getState().selectWorkspace('ws-3');
    const s = useDashboardStore.getState();
    expect(s.activeTabId).toBeNull();
    expect(s.openTabs).toHaveLength(1);
    expect(s.fileViewerOpen).toBe(false);
  });

  it('resets the view regardless of terminal pinning', () => {
    useDashboardStore.setState({ terminalPinned: true, fileViewerOpen: true, browserOpen: false });
    useDashboardStore.getState().selectWorkspace('ws-2');
    const s = useDashboardStore.getState();
    expect(s.fileViewerOpen).toBe(false);
    expect(s.browserOpen).toBe(false);
  });
});
