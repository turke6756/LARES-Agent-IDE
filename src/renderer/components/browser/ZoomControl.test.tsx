// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ZoomControl from './ZoomControl';
import { __resetSuspendCount } from './useBrowserSuspension';
import { useBrowserStore, type BrowserTabState } from '../../stores/browser-store';

// Slice 15 acceptance (ZoomControl): the preset menu applies a factor via
// setZoom, and the "Reset" entry calls resetZoomForOrigin; the percent reflects
// the active tab's zoomFactor (from tab state).

const setZoomCalls: Array<[string, number]> = [];
const resetCalls: string[] = [];

function tab(over: Partial<BrowserTabState> & { tabId: string }): BrowserTabState {
  return {
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    partition: 'user',
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(ZoomControl));
  });
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null
  ) as HTMLButtonElement | null;
}

function click(el: Element | null) {
  if (!el) throw new Error('element not found');
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

beforeEach(() => {
  __resetSuspendCount();
  setZoomCalls.length = 0;
  resetCalls.length = 0;
  (window as unknown as { api: unknown }).api = {
    browser: {
      setVisible: () => {},
      setZoom: (tabId: string, factor: number) => setZoomCalls.push([tabId, factor]),
      resetZoomForOrigin: (tabId: string) => resetCalls.push(tabId),
    },
  };
  useBrowserStore.setState({
    tabs: [tab({ tabId: 't1', zoomFactor: 1.5 })],
    activeTabId: 't1',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ZoomControl', () => {
  it('reflects the active tab zoomFactor as a percent', () => {
    render();
    expect(buttonByText('150%')).not.toBeNull();
  });

  it('self-gates: renders nothing for a New Tab page', () => {
    useBrowserStore.setState({ tabs: [tab({ tabId: 't1', isNewTab: true, url: '' })], activeTabId: 't1' });
    render();
    expect(container.querySelector('button')).toBeNull();
  });

  it('applies a preset factor via setZoom', () => {
    render();
    click(buttonByText('150%')); // open the menu
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    click(buttonByText('200%')); // pick a preset
    expect(setZoomCalls).toEqual([['t1', 2]]);
  });

  it('Reset calls resetZoomForOrigin', () => {
    render();
    click(buttonByText('150%')); // open the menu
    click(buttonByText('Reset'));
    expect(resetCalls).toEqual(['t1']);
  });
});
