// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BrowserTabStrip from './BrowserTabStrip';
import { __resetSuspendCount } from './useBrowserSuspension';
import {
  useBrowserStore,
  type AgentDrivingRevoked,
  type BrowserTabState,
} from '../../stores/browser-store';

// Slice 12: the persistent toolbar "Agent driving" chip for the ACTIVE handed
// tab (BrowserTabStrip.tsx ~line 587). It carries a one-click "Return" button —
// the per-tab handed badge has no Return button, so that button is the chip's
// discriminator. A driving-revoke delivered through the store
// (handleAgentDrivingRevoked, the renderer mirror of main's off-origin
// auto-revoke) drops handedTabIds for the tab, so the chip must disappear.

function tab(over: Partial<BrowserTabState> & { tabId: string }): BrowserTabState {
  return {
    url: 'https://mail.example/inbox',
    title: 'Inbox',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    partition: 'user',
    workspaceId: null,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(BrowserTabStrip));
  });
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null
  ) as HTMLButtonElement | null;
}

beforeEach(() => {
  __resetSuspendCount();
  container = document.createElement('div');
  document.body.appendChild(container);
  // The active tab is handed → the toolbar chip should render.
  useBrowserStore.setState({
    tabs: [tab({ tabId: 't1', handedToAgent: true })],
    activeTabId: 't1',
    selectedWorkspaceId: null,
    handedTabIds: { t1: true },
    snapshot: [],
    attentionTabIds: {},
    accessRules: [],
    drivingRevoked: [],
    groupCollapsed: { agent: true, user: false },
    openGroupId: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  delete (window as unknown as { api?: unknown }).api;
});

describe('BrowserTabStrip — "Agent driving" toolbar chip (Slice 12)', () => {
  it('renders the chip (with its Return affordance) for the active handed tab', () => {
    render();
    expect(container.textContent).toContain('Agent driving');
    // The toolbar chip is the only surface that exposes a bare "Return" button.
    expect(buttonByText('Return')).not.toBeNull();
  });

  it('a driving-revoke delivered through the store drops the chip', () => {
    render();
    expect(buttonByText('Return')).not.toBeNull();

    const payload: AgentDrivingRevoked = {
      tabId: 't1',
      url: 'https://evil.example/landing',
      hostname: 'evil.example',
    };
    act(() => useBrowserStore.getState().handleAgentDrivingRevoked(payload));

    // Main already detached the driver; the renderer mirror drops handedTabIds,
    // so the chip can't outlive the capability.
    expect(buttonByText('Return')).toBeNull();
    expect(container.textContent).not.toContain('Agent driving');
  });

  it('handleAgentDrivingRevoked clears handedTabIds and records the revoke notice', () => {
    const store = useBrowserStore.getState();
    expect(store.handedTabIds.t1).toBe(true);

    act(() =>
      store.handleAgentDrivingRevoked({
        tabId: 't1',
        url: 'https://evil.example/landing',
        hostname: 'evil.example',
      }),
    );

    const next = useBrowserStore.getState();
    expect(next.handedTabIds.t1).toBeUndefined();
    expect(next.drivingRevoked.map((r) => r.tabId)).toEqual(['t1']);
  });
});
