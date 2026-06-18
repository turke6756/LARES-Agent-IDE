// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BrowserPanel from './BrowserPanel';
import { useBrowserStore, __resetBrowserBridgeForTests } from '../../stores/browser-store';
import { useDashboardStore } from '../../stores/dashboard-store';

// Slice 10/11 acceptance: BrowserPanel shows a dismissible "Restored N tabs"
// note when restoredCount > 0, and hides it once dismissed. Rendered with a
// no-op api stub so apiPresent is true (the note lives inside that branch). The
// stub deliberately OMITS sessionRestore so the bridge's restore PULL is skipped
// and our seeded restoredCount survives the mount.

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

function dismissBtn(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => (b.textContent ?? '').trim() === 'Dismiss',
  );
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
    restoredCount: 0,
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
  it('shows the count and pluralizes', () => {
    useBrowserStore.setState({ restoredCount: 3 });
    render();
    expect(container.textContent).toContain('Restored 3 tabs');
  });

  it('uses the singular for one tab', () => {
    useBrowserStore.setState({ restoredCount: 1 });
    render();
    expect(container.textContent).toContain('Restored 1 tab');
    expect(container.textContent).not.toContain('Restored 1 tabs');
  });

  it('is absent when nothing was restored', () => {
    useBrowserStore.setState({ restoredCount: 0 });
    render();
    expect(container.textContent).not.toContain('Restored');
    expect(dismissBtn()).toBeUndefined();
  });

  it('Dismiss clears the note', () => {
    useBrowserStore.setState({ restoredCount: 2 });
    render();
    expect(container.textContent).toContain('Restored 2 tabs');
    const btn = dismissBtn();
    expect(btn).toBeTruthy();
    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useBrowserStore.getState().restoredCount).toBe(0);
    expect(container.textContent).not.toContain('Restored 2 tabs');
  });
});
