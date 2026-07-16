// @vitest-environment jsdom
/**
 * Navigation contract:
 *  - showDashboard() returns to the agent-card grid (view reset, tabs preserved).
 *  - selectWorkspace() now PERSISTS per-workspace view state: it snapshots the
 *    outgoing workspace's view (attached agent chat, terminal, open file/browser
 *    view, active tab, detail pane) and restores the incoming workspace's
 *    snapshot — so a workspace comes back exactly as it was left. A workspace
 *    visited fresh falls back to the dashboard grid.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useDashboardStore } from './dashboard-store';

// Per-workspace agent rosters returned by the stubbed preload bridge. Tests can
// mutate this to simulate an agent being stopped/removed while the user is away.
let agentsByWorkspace: Record<string, Array<{ id: string; workspaceId: string; status: string }>>;

// Flush the async loadAgents()/loadTeams() + stale-agent reconcile chain that
// selectWorkspace() fires after it sets state.
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  agentsByWorkspace = {};
  // selectWorkspace fires loadAgents/loadTeams; stub the preload bridge.
  (window as unknown as { api: unknown }).api = {
    agents: {
      list: vi.fn((workspaceId: string) => Promise.resolve(agentsByWorkspace[workspaceId] ?? [])),
    },
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
    detailPane: 2,
    agents: [],
    agentStatuses: {},
    workspaceViewState: {},
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

describe('selectWorkspace fresh-workspace defaults', () => {
  it('lands a never-visited workspace on the dashboard grid', () => {
    useDashboardStore.setState({ fileViewerOpen: true, browserOpen: false, selectedAgentId: 'a1' });
    useDashboardStore.getState().selectWorkspace('ws-2');
    const s = useDashboardStore.getState();
    expect(s.selectedWorkspaceId).toBe('ws-2');
    expect(s.fileViewerOpen).toBe(false);
    expect(s.browserOpen).toBe(false);
    expect(s.selectedAgentId).toBeNull();
  });

  it('re-points activeTabId to a tab of the fresh workspace, keeping other tabs', () => {
    useDashboardStore.getState().openTab('C:/ws1/a.ts', 'C:/ws1', 'windows', undefined, 'ws-1');
    // ws-3 has no tabs → activeTabId nulls, tabs survive.
    useDashboardStore.getState().selectWorkspace('ws-3');
    const s = useDashboardStore.getState();
    expect(s.activeTabId).toBeNull();
    expect(s.openTabs).toHaveLength(1);
    expect(s.fileViewerOpen).toBe(false);
  });
});

describe('selectWorkspace snapshot + restore', () => {
  it('restores the attached agent + detail pane on switch-back', async () => {
    agentsByWorkspace = {
      'ws-1': [{ id: 'a1', workspaceId: 'ws-1', status: 'working' }],
      'ws-2': [{ id: 'b1', workspaceId: 'ws-2', status: 'working' }],
    };
    useDashboardStore.setState({ agents: agentsByWorkspace['ws-1'] });
    // In ws-1: attach to agent a1, on the Context pane (0).
    useDashboardStore.setState({ selectedAgentId: 'a1', detailPane: 0 });

    // Leave to ws-2 (fresh) → snapshots ws-1's view, lands on dashboard.
    useDashboardStore.getState().selectWorkspace('ws-2');
    await flush();
    expect(useDashboardStore.getState().selectedAgentId).toBeNull();

    // Return to ws-1 → restores agent a1 and detail pane 0.
    useDashboardStore.getState().selectWorkspace('ws-1');
    const s = useDashboardStore.getState();
    expect(s.selectedAgentId).toBe('a1');
    expect(s.detailPane).toBe(0);
    await flush();
    // Still there after loadAgents reconcile confirms a1 exists.
    expect(useDashboardStore.getState().selectedAgentId).toBe('a1');
  });

  it('restores the open file view on switch-back', async () => {
    useDashboardStore.getState().openTab('C:/ws1/a.ts', 'C:/ws1', 'windows', undefined, 'ws-1');
    const ws1TabId = useDashboardStore.getState().activeTabId;
    expect(useDashboardStore.getState().fileViewerOpen).toBe(true);

    useDashboardStore.getState().selectWorkspace('ws-2');
    await flush();
    expect(useDashboardStore.getState().fileViewerOpen).toBe(false);

    useDashboardStore.getState().selectWorkspace('ws-1');
    const s = useDashboardStore.getState();
    expect(s.fileViewerOpen).toBe(true);
    expect(s.activeTabId).toBe(ws1TabId);
  });

  it('restores the browser view on switch-back', async () => {
    useDashboardStore.getState().showBrowser();
    expect(useDashboardStore.getState().browserOpen).toBe(true);

    useDashboardStore.getState().selectWorkspace('ws-2');
    await flush();
    expect(useDashboardStore.getState().browserOpen).toBe(false);

    useDashboardStore.getState().selectWorkspace('ws-1');
    expect(useDashboardStore.getState().browserOpen).toBe(true);
  });

  it('preserves openTabs and keeps each workspace on its own remembered tab', async () => {
    useDashboardStore.getState().openTab('C:/ws2/b.ts', 'C:/ws2', 'windows', undefined, 'ws-2');
    const ws2TabId = useDashboardStore.getState().activeTabId;
    useDashboardStore.getState().openTab('C:/ws1/a.ts', 'C:/ws1', 'windows', undefined, 'ws-1');
    const ws1TabId = useDashboardStore.getState().activeTabId;
    expect(ws1TabId).not.toBe(ws2TabId);

    useDashboardStore.getState().selectWorkspace('ws-2');
    await flush();
    let s = useDashboardStore.getState();
    expect(s.openTabs).toHaveLength(2);
    expect(s.activeTabId).toBe(ws2TabId);

    useDashboardStore.getState().selectWorkspace('ws-1');
    s = useDashboardStore.getState();
    expect(s.activeTabId).toBe(ws1TabId);
  });
});

describe('selectWorkspace stale-agent reconciliation', () => {
  it('drops a restored agent that no longer exists after loadAgents returns', async () => {
    agentsByWorkspace = {
      'ws-1': [{ id: 'a1', workspaceId: 'ws-1', status: 'working' }],
    };
    useDashboardStore.setState({ agents: agentsByWorkspace['ws-1'], selectedAgentId: 'a1' });

    // Leave to ws-2, snapshotting a1 as ws-1's attached agent.
    useDashboardStore.getState().selectWorkspace('ws-2');
    await flush();

    // While away, a1 is stopped/removed — ws-1 now comes back empty.
    agentsByWorkspace['ws-1'] = [];

    useDashboardStore.getState().selectWorkspace('ws-1');
    // Restored optimistically...
    expect(useDashboardStore.getState().selectedAgentId).toBe('a1');
    // ...then reconciled away once the (now-empty) roster loads.
    await flush();
    expect(useDashboardStore.getState().selectedAgentId).toBeNull();
  });

  it('keeps a restored agent that still exists', async () => {
    agentsByWorkspace = {
      'ws-1': [{ id: 'a1', workspaceId: 'ws-1', status: 'working' }],
    };
    useDashboardStore.setState({ agents: agentsByWorkspace['ws-1'], selectedAgentId: 'a1' });

    useDashboardStore.getState().selectWorkspace('ws-2');
    await flush();
    useDashboardStore.getState().selectWorkspace('ws-1');
    await flush();
    expect(useDashboardStore.getState().selectedAgentId).toBe('a1');
  });
});

describe('selectWorkspace terminal pinning', () => {
  it('keeps the pinned terminal attached across workspace switches', async () => {
    useDashboardStore.setState({ terminalPinned: true, terminalAgentId: 'term-1' });
    useDashboardStore.getState().selectWorkspace('ws-2');
    await flush();
    expect(useDashboardStore.getState().terminalAgentId).toBe('term-1');
  });

  it('clears the terminal for a fresh workspace when not pinned', async () => {
    useDashboardStore.setState({ terminalPinned: false, terminalAgentId: 'term-1' });
    useDashboardStore.getState().selectWorkspace('ws-2');
    const s = useDashboardStore.getState();
    expect(s.terminalAgentId).toBeNull();
  });
});

describe('selectWorkspace re-selecting the current workspace', () => {
  it('does not disturb the current view', () => {
    useDashboardStore.setState({ selectedAgentId: 'a1', fileViewerOpen: true, detailPane: 1 });
    useDashboardStore.getState().selectWorkspace('ws-1'); // already selected
    const s = useDashboardStore.getState();
    expect(s.selectedAgentId).toBe('a1');
    expect(s.fileViewerOpen).toBe(true);
    expect(s.detailPane).toBe(1);
  });
});
