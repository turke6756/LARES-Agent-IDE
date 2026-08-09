// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BrowserPanel from './BrowserPanel';
import { useBrowserStore, __resetBrowserBridgeForTests } from '../../stores/browser-store';
import { useDashboardStore } from '../../stores/dashboard-store';

// Regression: session restoration is automatic now, so BrowserPanel must not
// show the old recurring "Restored N tabs" banner.

let container: HTMLDivElement;
let root: Root;

function installApi() {
  const noop = () => undefined;
  const sub = vi.fn(() => () => undefined);
  (window as unknown as { api?: unknown }).api = {
    browser: {
      // Event subscriptions the bridge wires unconditionally.
      onTabState: sub,
      onOpenRequest: sub,
      onBookmarksChanged: sub,
      onFoundInPage: sub,
      onTabsSnapshot: sub,
      onShortcutCommand: sub,
      onContextMenuCommand: sub,
      // Imperative calls the bridge / children make on mount.
      setActiveWorkspace: noop,
      setVisible: noop,
      setActiveTab: noop,
      bookmarkList: vi.fn(async () => []),
      // sessionRestore intentionally absent → bridge skips the restore PULL.
    },
  };
}

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(BrowserPanel));
  });
}

beforeEach(() => {
  __resetBrowserBridgeForTests();
  installApi();
  container = document.createElement('div');
  document.body.appendChild(container);
  useDashboardStore.setState({ selectedWorkspaceId: null });
  useBrowserStore.setState({
    tabs: [],
    activeTabId: null,
    selectedWorkspaceId: null,
    bookmarkBarVisible: false, // skip BookmarksBar (ResizeObserver) in jsdom
    pendingOpenUrl: null,
    signinHandoff: null,
    accessRules: [],
    accessRequests: [],
    auditDrawerOpen: false,
    historyViewOpen: false,
    accessViewOpen: false,
    denialToasts: [],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('restored-tabs note', () => {
  it('does not show the old restore banner', () => {
    render();
    expect(container.textContent).not.toContain('Restored');
    expect(container.textContent).not.toContain('click one to load it');
  });
});
