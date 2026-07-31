// @vitest-environment jsdom
/**
 * SC-WP-1I — Save-card center-surface store contract:
 *  - showSaveCard() opens the read-only Save surface;
 *  - the four center-surface show* actions are MUTUALLY EXCLUSIVE — each opens
 *    its own surface and closes the other three;
 *  - saveCardOpen participates in per-workspace view-state capture/restore, so a
 *    workspace switched away and back lands on the Save card exactly as it was
 *    left, and a fresh workspace never inherits another's Save-card state.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useDashboardStore } from './dashboard-store';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  (window as unknown as { api: unknown }).api = {
    agents: { list: vi.fn().mockResolvedValue([]) },
    teams: { list: vi.fn().mockResolvedValue([]) },
  };
  useDashboardStore.setState({
    browserOpen: false,
    fileViewerOpen: false,
    saveCardOpen: false,
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
    detachedViews: [],
  });
});

describe('showSaveCard', () => {
  it('opens the Save surface', () => {
    useDashboardStore.getState().showSaveCard();
    expect(useDashboardStore.getState().saveCardOpen).toBe(true);
  });

  it('closes the file viewer and browser when opening', () => {
    useDashboardStore.setState({ fileViewerOpen: true, browserOpen: true });
    useDashboardStore.getState().showSaveCard();
    const s = useDashboardStore.getState();
    expect(s.saveCardOpen).toBe(true);
    expect(s.fileViewerOpen).toBe(false);
    expect(s.browserOpen).toBe(false);
  });
});

describe('center-surface mutual exclusion', () => {
  it('showFileViewer closes the Save card', () => {
    useDashboardStore.getState().openTab('C:/ws/a.ts', 'C:/ws', 'windows', undefined, 'ws-1');
    useDashboardStore.getState().showSaveCard();
    expect(useDashboardStore.getState().saveCardOpen).toBe(true);
    useDashboardStore.getState().showFileViewer();
    const s = useDashboardStore.getState();
    expect(s.fileViewerOpen).toBe(true);
    expect(s.saveCardOpen).toBe(false);
  });

  it('showBrowser closes the Save card', () => {
    useDashboardStore.getState().showSaveCard();
    useDashboardStore.getState().showBrowser();
    const s = useDashboardStore.getState();
    expect(s.browserOpen).toBe(true);
    expect(s.saveCardOpen).toBe(false);
  });

  it('showDashboard closes the Save card', () => {
    useDashboardStore.getState().showSaveCard();
    useDashboardStore.getState().showDashboard();
    const s = useDashboardStore.getState();
    expect(s.saveCardOpen).toBe(false);
    expect(s.fileViewerOpen).toBe(false);
    expect(s.browserOpen).toBe(false);
  });

  it('never leaves two center surfaces open at once', () => {
    const { showSaveCard, showBrowser, showDashboard } = useDashboardStore.getState();
    showSaveCard();
    showBrowser();
    showSaveCard();
    showDashboard();
    showSaveCard();
    const s = useDashboardStore.getState();
    const open = [s.fileViewerOpen, s.browserOpen, s.saveCardOpen].filter(Boolean);
    expect(open).toHaveLength(1);
    expect(s.saveCardOpen).toBe(true);
  });
});

describe('saveCardOpen view-state capture/restore', () => {
  it('restores the Save card on switch-back', async () => {
    useDashboardStore.getState().showSaveCard();
    expect(useDashboardStore.getState().saveCardOpen).toBe(true);

    // Leave to ws-2 (fresh) → snapshots ws-1's Save-card view, lands on grid.
    useDashboardStore.getState().selectWorkspace('ws-2');
    await flush();
    expect(useDashboardStore.getState().saveCardOpen).toBe(false);

    // Return to ws-1 → restores the Save card.
    useDashboardStore.getState().selectWorkspace('ws-1');
    expect(useDashboardStore.getState().saveCardOpen).toBe(true);
  });

  it('does not leak Save-card state into a never-visited workspace', () => {
    useDashboardStore.getState().showSaveCard();
    useDashboardStore.getState().selectWorkspace('ws-3');
    expect(useDashboardStore.getState().saveCardOpen).toBe(false);
  });

  it('keeps each workspace on its own remembered surface', async () => {
    // ws-1 → Save card.
    useDashboardStore.getState().showSaveCard();
    // Leave to ws-2, then open the browser there.
    useDashboardStore.getState().selectWorkspace('ws-2');
    await flush();
    useDashboardStore.getState().showBrowser();
    expect(useDashboardStore.getState().saveCardOpen).toBe(false);

    // Back to ws-1 → Save card, not the browser.
    useDashboardStore.getState().selectWorkspace('ws-1');
    let s = useDashboardStore.getState();
    expect(s.saveCardOpen).toBe(true);
    expect(s.browserOpen).toBe(false);

    // Back to ws-2 → browser, not the Save card.
    useDashboardStore.getState().selectWorkspace('ws-2');
    await flush();
    s = useDashboardStore.getState();
    expect(s.browserOpen).toBe(true);
    expect(s.saveCardOpen).toBe(false);
  });
});
