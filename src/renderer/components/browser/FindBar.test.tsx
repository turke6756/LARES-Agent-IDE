// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FindBar from './FindBar';
import { useBrowserStore, type BrowserFindOptions, type BrowserTabState } from '../../stores/browser-store';

// Slice 15 acceptance (FindBar): per-tab query restores on tab switch; the
// counter reflects the per-tab onFoundInPage event; next/prev call the immediate
// methods; the case-sensitive toggle re-issues find with matchCase; the
// "no results" state shows when matches === 0 and the query is non-empty.

const findCalls: Array<[string, string, BrowserFindOptions | undefined]> = [];
const nextCalls: string[] = [];
const prevCalls: string[] = [];
const stopCalls: string[] = [];

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
    root.render(React.createElement(FindBar));
  });
}

function input(): HTMLInputElement {
  const el = container.querySelector('input');
  if (!el) throw new Error('find input not found');
  return el as HTMLInputElement;
}

function byTitle(title: string): HTMLButtonElement {
  const el = container.querySelector(`button[title="${title}"]`);
  if (!el) throw new Error(`button "${title}" not found`);
  return el as HTMLButtonElement;
}

function click(el: Element) {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

/** Drive a controlled React input the way a user keystroke would. */
function type(value: string) {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function counterText(): string {
  return container.querySelector('[aria-live="polite"]')?.textContent?.trim() ?? '';
}

beforeEach(() => {
  findCalls.length = 0;
  nextCalls.length = 0;
  prevCalls.length = 0;
  stopCalls.length = 0;
  (window as unknown as { api: unknown }).api = {
    browser: {
      setVisible: () => {},
      find: (tabId: string, query: string, opts?: BrowserFindOptions) =>
        findCalls.push([tabId, query, opts]),
      findNext: (tabId: string) => nextCalls.push(tabId),
      findPrev: (tabId: string) => prevCalls.push(tabId),
      stopFind: (tabId: string) => stopCalls.push(tabId),
    },
  };
  useBrowserStore.setState({
    tabs: [tab({ tabId: 't1' }), tab({ tabId: 't2' })],
    activeTabId: 't1',
    findOpen: true,
    findQueries: {},
    findMatchCase: {},
    findStates: {},
  });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('FindBar', () => {
  it('hides when findOpen is false', () => {
    useBrowserStore.setState({ findOpen: false });
    render();
    expect(container.querySelector('input')).toBeNull();
  });

  it('typing mirrors the query into the active tab and runs find', () => {
    render();
    type('hello');
    expect(useBrowserStore.getState().findQueries.t1).toBe('hello');
    expect(input().value).toBe('hello');
  });

  it('restores each tab\'s query on tab switch', () => {
    useBrowserStore.setState({ findQueries: { t1: 'foo', t2: 'bar' } });
    render();
    expect(input().value).toBe('foo');
    act(() => useBrowserStore.setState({ activeTabId: 't2' }));
    expect(input().value).toBe('bar');
  });

  it('shows the "{ordinal} of {total}" counter from the onFoundInPage event', () => {
    useBrowserStore.setState({ findQueries: { t1: 'foo' } });
    render();
    act(() =>
      useBrowserStore
        .getState()
        .handleFoundInPage({ tabId: 't1', activeMatchOrdinal: 2, matches: 5, finalUpdate: true }),
    );
    expect(counterText()).toBe('2 of 5');
  });

  it('shows a "no results" state when matches === 0 and the query is non-empty', () => {
    useBrowserStore.setState({
      findQueries: { t1: 'zzz' },
      findStates: { t1: { activeMatchOrdinal: 0, matches: 0 } },
    });
    render();
    expect(counterText()).toBe('No results');
  });

  it('next/prev call the immediate findNext/findPrev methods', () => {
    useBrowserStore.setState({
      findQueries: { t1: 'foo' },
      findStates: { t1: { activeMatchOrdinal: 1, matches: 3 } },
    });
    render();
    click(byTitle('Next match (Enter)'));
    click(byTitle('Previous match (Shift+Enter)'));
    expect(nextCalls).toEqual(['t1']);
    expect(prevCalls).toEqual(['t1']);
  });

  it('Enter = next, Shift+Enter = prev', () => {
    useBrowserStore.setState({ findQueries: { t1: 'foo' } });
    render();
    act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    act(() =>
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })),
    );
    expect(nextCalls).toEqual(['t1']);
    expect(prevCalls).toEqual(['t1']);
  });

  it('the case-sensitive toggle re-issues find with matchCase', () => {
    useBrowserStore.setState({ findQueries: { t1: 'foo' } });
    render();
    click(byTitle('Match case'));
    expect(useBrowserStore.getState().findMatchCase.t1).toBe(true);
    expect(findCalls).toEqual([['t1', 'foo', { matchCase: true }]]);
  });

  it('Esc / close calls stopFind for the active tab and hides', () => {
    useBrowserStore.setState({ findQueries: { t1: 'foo' } });
    render();
    click(byTitle('Close (Esc)'));
    expect(stopCalls).toEqual(['t1']);
    expect(useBrowserStore.getState().findOpen).toBe(false);
  });
});
