// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ActivityDrawer from './ActivityDrawer';
import { useBrowserStore, type BrowserAuditEntry } from '../../stores/browser-store';
import type { BrowserTabState } from '../../stores/browser-store';

// Slice-3 acceptance: the Activity/Audit drawer filters its rows by
// All / Denied / This host. Rendered against the real store + jsdom DOM (no
// preload — getBrowserApi() is null, so useBrowserSuspension no-ops safely).

function ev(over: Partial<BrowserAuditEntry> & { url: string }): BrowserAuditEntry {
  return {
    ts: new Date().toISOString(),
    verb: 'openUrl',
    partition: 'persist:agent',
    outcome: 'ok',
    workspaceId: 'ws-A',
    ...over,
  };
}

function tab(over: Partial<BrowserTabState> & { tabId: string }): BrowserTabState {
  return {
    url: 'https://a.example/',
    title: 'A',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    partition: 'user',
    workspaceId: 'ws-A',
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(ActivityDrawer));
  });
}

/** The scroll container holds one child <div> per visible row (or the single
 *  empty-state div when none). */
function rowCount(): number {
  const scroll = container.querySelector('.overflow-y-auto');
  return scroll ? scroll.children.length : 0;
}

function clickFilter(label: string) {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim().startsWith(label),
  );
  if (!btn) throw new Error(`filter chip not found: ${label}`);
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  useBrowserStore.setState({
    selectedWorkspaceId: 'ws-A',
    auditDrawerOpen: true,
    activeTabId: 't1',
    tabs: [tab({ tabId: 't1', url: 'https://a.example/' })],
    auditEvents: [
      ev({ url: 'https://a.example/1', outcome: 'ok' }),
      ev({ url: 'https://b.example/2', outcome: 'denied:actions-disabled' }),
      ev({ url: 'https://a.example/3', outcome: 'ok' }),
    ],
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe('ActivityDrawer filtering', () => {
  it('renders nothing when the drawer is closed', () => {
    useBrowserStore.setState({ auditDrawerOpen: false });
    render();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('"All" shows every audit row for the viewed workspace (newest-first)', () => {
    render();
    expect(rowCount()).toBe(3);
  });

  it('"Denied" shows only denied rows', () => {
    render();
    clickFilter('Denied');
    expect(rowCount()).toBe(1);
    const text = container.querySelector('.overflow-y-auto')!.textContent ?? '';
    expect(text).toContain('b.example');
    expect(text).not.toContain('a.example');
  });

  it('"This host" shows only rows whose host matches the active tab', () => {
    render();
    clickFilter('This host');
    expect(rowCount()).toBe(2); // the two a.example rows
    const text = container.querySelector('.overflow-y-auto')!.textContent ?? '';
    expect(text).toContain('a.example');
    expect(text).not.toContain('b.example');
  });

  it('cross-workspace audit rows never appear in the viewed workspace', () => {
    useBrowserStore.setState({
      auditEvents: [
        ev({ url: 'https://a.example/1', outcome: 'ok' }),
        ev({ url: 'https://leak.example/x', outcome: 'ok', workspaceId: 'ws-B' }),
      ],
    });
    render();
    expect(rowCount()).toBe(1);
    const text = container.querySelector('.overflow-y-auto')!.textContent ?? '';
    expect(text).not.toContain('leak.example');
  });
});
