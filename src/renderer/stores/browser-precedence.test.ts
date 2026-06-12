// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useDashboardStore } from './dashboard-store';

// WP1-B center-mode precedence: file viewer wins; opening one closes the other.

beforeEach(() => {
  useDashboardStore.setState({
    browserOpen: false,
    fileViewerOpen: false,
    openTabs: [],
    activeTabId: null,
    tabEditState: {},
    workspaces: [],
    selectedWorkspaceId: 'ws-1',
  });
});

describe('center-mode precedence', () => {
  it('showBrowser opens the pane and closes the file viewer', () => {
    useDashboardStore.setState({ fileViewerOpen: true });
    useDashboardStore.getState().showBrowser();
    const s = useDashboardStore.getState();
    expect(s.browserOpen).toBe(true);
    expect(s.fileViewerOpen).toBe(false);
  });

  it('hideBrowser closes only the pane', () => {
    useDashboardStore.getState().showBrowser();
    useDashboardStore.getState().hideBrowser();
    expect(useDashboardStore.getState().browserOpen).toBe(false);
  });

  it('openTab (file viewer) closes the browser pane', () => {
    useDashboardStore.getState().showBrowser();
    useDashboardStore.getState().openTab('C:/ws/a.ts', 'C:/ws', 'windows', undefined, 'ws-1');
    const s = useDashboardStore.getState();
    expect(s.fileViewerOpen).toBe(true);
    expect(s.browserOpen).toBe(false);
  });

  it('openDirectoryTab closes the browser pane (fresh and re-shown roots)', () => {
    useDashboardStore.getState().showBrowser();
    useDashboardStore.getState().openDirectoryTab('C:/ws', 'windows', 'ws-1');
    expect(useDashboardStore.getState().browserOpen).toBe(false);
    expect(useDashboardStore.getState().fileViewerOpen).toBe(true);

    // Re-show path (tabs for the root already exist)
    useDashboardStore.getState().showBrowser();
    useDashboardStore.getState().openDirectoryTab('C:/ws', 'windows', 'ws-1');
    expect(useDashboardStore.getState().browserOpen).toBe(false);
    expect(useDashboardStore.getState().fileViewerOpen).toBe(true);
  });

  it('showFileViewer with existing workspace tabs closes the browser pane', () => {
    useDashboardStore.getState().openTab('C:/ws/a.ts', 'C:/ws', 'windows', undefined, 'ws-1');
    useDashboardStore.getState().showBrowser();
    expect(useDashboardStore.getState().fileViewerOpen).toBe(false);
    useDashboardStore.getState().showFileViewer();
    const s = useDashboardStore.getState();
    expect(s.fileViewerOpen).toBe(true);
    expect(s.browserOpen).toBe(false);
  });

  it('both flags set resolves to the file viewer (dispatch order) — and stays consistent after hideFileViewer', () => {
    // Defensive: even if both flags somehow end up true, MainContent renders
    // the file viewer first; hiding it then reveals the browser pane.
    useDashboardStore.setState({ fileViewerOpen: true, browserOpen: true });
    useDashboardStore.getState().hideFileViewer();
    const s = useDashboardStore.getState();
    expect(s.fileViewerOpen).toBe(false);
    expect(s.browserOpen).toBe(true);
  });
});
