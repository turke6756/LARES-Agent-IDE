// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import StarMenu from './StarMenu';
import {
  suspendBrowserPane,
  resumeBrowserPane,
  __getSuspendCount,
  __resetSuspendCount,
} from './useBrowserSuspension';
import { useBrowserStore, type Bookmark, type BrowserTabState } from '../../stores/browser-store';

// Slice-5 acceptance (overlay / suspension correctness):
//   1. opening the star popover hides the pane and closing restores it,
//   2. nested history/access modals do NOT prematurely restore the pane
//      (the suspend ref-count must climb while overlays stack and reach 0 —
//       restoring visibility — only when the LAST overlay closes).
//
// We stub window.api.browser.setVisible so we can observe pane hide/show, and
// use the test-only __getSuspendCount accessor to assert ref-count balance.

const visibleCalls: boolean[] = [];

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

function bookmark(over: Partial<Bookmark> & { url: string }): Bookmark {
  return {
    id: 'bm1',
    title: 'A',
    createdAt: 0,
    sortOrder: 0,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(StarMenu));
  });
}

/** The star toggle button is the first <button> StarMenu renders. */
function clickStar() {
  const btn = container.querySelector('button');
  if (!btn) throw new Error('star button not found');
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function popoverOpen(): boolean {
  return container.querySelector('[role="dialog"]') !== null;
}

beforeEach(() => {
  __resetSuspendCount();
  visibleCalls.length = 0;
  (window as unknown as { api: unknown }).api = {
    browser: { setVisible: (v: boolean) => visibleCalls.push(v) },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  // A bookmarkable, already-bookmarked user tab: clicking the star just toggles
  // the popover open/closed (no add/remove side effects to reason about).
  useBrowserStore.setState({
    activeTabId: 't1',
    tabs: [tab({ tabId: 't1', url: 'https://a.example/' })],
    bookmarks: [bookmark({ url: 'https://a.example/', title: 'A' })],
    bookmarkTick: 0,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  delete (window as unknown as { api?: unknown }).api;
});

describe('StarMenu pane suspension (Slice 5)', () => {
  it('opening the popover hides the pane and closing restores it', () => {
    render();
    expect(popoverOpen()).toBe(false);
    expect(__getSuspendCount()).toBe(0);
    expect(visibleCalls).toEqual([]);

    // Open → pane hidden exactly once.
    clickStar();
    expect(popoverOpen()).toBe(true);
    expect(__getSuspendCount()).toBe(1);
    expect(visibleCalls).toEqual([false]);

    // Close → pane restored exactly once.
    clickStar();
    expect(popoverOpen()).toBe(false);
    expect(__getSuspendCount()).toBe(0);
    expect(visibleCalls).toEqual([false, true]);
  });

  it('nested overlays do not prematurely restore the pane (ref-count correctness)', () => {
    render();

    // Star popover up: pane hidden once.
    clickStar();
    expect(__getSuspendCount()).toBe(1);
    expect(visibleCalls).toEqual([false]);

    // A nested overlay (history/access modal) mounts → ref-count climbs, but the
    // pane was already hidden, so setVisible(false) does NOT fire again.
    act(() => suspendBrowserPane());
    expect(__getSuspendCount()).toBe(2);
    expect(visibleCalls).toEqual([false]);

    // The nested overlay closes → the pane must STAY hidden (the star popover is
    // still up). No setVisible(true) yet — this is the premature-restore guard.
    act(() => resumeBrowserPane());
    expect(__getSuspendCount()).toBe(1);
    expect(visibleCalls).toEqual([false]);

    // Only when the last overlay (the star popover) closes is the pane restored,
    // and exactly once.
    clickStar();
    expect(__getSuspendCount()).toBe(0);
    expect(visibleCalls).toEqual([false, true]);
  });
});
