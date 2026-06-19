// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import NewTabPage from './NewTabPage';
import {
  useBrowserStore,
  type Bookmark,
  type BrowserDownload,
  type HistoryEntry,
} from '../../stores/browser-store';

// Slice-9 acceptance (New-tab command center):
//   REQUIRED (a) clean empty state renders with NO backend methods available —
//     the page must not throw and must degrade to friendly empty sections (not
//     an error state) when window.api.browser is absent.
//   REQUIRED (b) ALL opens pass the M6 gate — every "open" surface (top site,
//     recent bookmark, omnibox raw submit, omnibox suggestion pick) routes
//     through the onNavigate prop (host → store.navigate/createTab → M6). There
//     is no direct-load path in the component that bypasses it.

let container: HTMLDivElement;
let root: Root;

function render(onNavigate: (url: string) => void) {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(NewTabPage, { onNavigate }));
  });
}

/** Flush the useRemote fetch microtasks + the ~80ms omnibox debounce. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').toLowerCase().includes(text.toLowerCase()),
  ) as HTMLButtonElement | undefined;
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  // Reset the shared omnibox slice so a prior test's state can't bleed in.
  useBrowserStore.setState({ omniboxResults: [], omniboxActiveIndex: -1, tabs: [], selectedWorkspaceId: null, downloads: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  delete (window as unknown as { api?: unknown }).api;
});

describe('NewTabPage — clean empty state (Slice 9, REQUIRED a)', () => {
  it('renders with NO backend methods available without throwing, degrading to empty (not error)', async () => {
    // No window.api at all → getBrowserApi() returns null → every section fetcher
    // returns null synchronously → ready/empty, never error.
    render(() => {});
    await flush();

    // Page shell + section headers all present.
    expect(container.textContent).toContain('New Tab');
    expect(container.textContent).toContain('Top sites');
    expect(container.textContent).toContain('Recent bookmarks');
    expect(container.textContent).toContain('Recent downloads');

    // Friendly empty copy, NOT the error/retry copy.
    expect(container.textContent).toContain('Sites you visit most will show up here.');
    expect(container.textContent).toContain('Bookmark a page');
    expect(container.textContent).toContain('Downloads will appear here.');
    expect(container.textContent).not.toContain('Couldn’t load');
    expect(buttonByText('Retry')).toBeUndefined();
  });
});

describe('NewTabPage — all opens route through the M6 gate (Slice 9, REQUIRED b)', () => {
  const topSite: HistoryEntry = {
    id: 'h1',
    url: 'https://news.example/',
    title: 'Example News',
    visitedAt: Date.now(),
    visitCount: 9,
    favicon: null,
  };
  const bookmark: Bookmark = {
    id: 'b1',
    url: 'https://docs.example/',
    title: 'Example Docs',
    createdAt: Date.now(),
    sortOrder: 0,
    favicon: null,
  };

  beforeEach(() => {
    (window as unknown as { api: unknown }).api = {
      browser: {
        historyTopSites: async () => [topSite],
        bookmarkList: async () => [bookmark],
        omniboxSuggest: async () => [
          { kind: 'history', title: 'Example News', url: 'https://news.example/', display: 'news.example', score: 400 },
        ],
      },
    };
  });

  it('top-site and recent-bookmark clicks call onNavigate (the gated open path) with the target URL', async () => {
    const onNavigate = vi.fn();
    render(onNavigate);
    await flush();

    const siteBtn = buttonByText('Example News');
    expect(siteBtn).toBeTruthy();
    click(siteBtn!);
    expect(onNavigate).toHaveBeenCalledWith('https://news.example/');

    const markBtn = buttonByText('Example Docs');
    expect(markBtn).toBeTruthy();
    click(markBtn!);
    expect(onNavigate).toHaveBeenCalledWith('https://docs.example/');
  });

  it('omnibox raw submit resolves via resolveBrowserInput and opens through onNavigate', async () => {
    const onNavigate = vi.fn();
    render(onNavigate);
    await flush();

    const input = container.querySelector('input[role="combobox"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    setInputValue(input, 'github.com');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // URL-shaped input is normalized to https and handed to the gated open path —
    // never loaded directly.
    expect(onNavigate).toHaveBeenCalledWith('https://github.com');
  });

  it('picking an omnibox suggestion opens its URL through onNavigate', async () => {
    const onNavigate = vi.fn();
    render(onNavigate);
    await flush();

    const input = container.querySelector('input[role="combobox"]') as HTMLInputElement;
    setInputValue(input, 'news');
    await flush(); // let the debounced omniboxSuggest populate the dropdown.

    const option = container.querySelector('[role="option"]') as HTMLElement | null;
    expect(option).toBeTruthy();
    click(option!);
    expect(onNavigate).toHaveBeenCalledWith('https://news.example/');
  });
});

describe('NewTabPage — recent downloads slot (Slice 13)', () => {
  function dl(over: Partial<BrowserDownload> & { id: string }): BrowserDownload {
    return {
      url: 'https://files.example/x',
      filename: 'x',
      savePath: '/dl/x',
      partition: 'user',
      workspaceId: null,
      origin: 'https://files.example',
      bytesReceived: 1,
      totalBytes: 1,
      state: 'completed',
      startedAt: 1,
      endedAt: 2,
      ...over,
    };
  }

  it('lists the most recent COMPLETED downloads and clicking opens the file', async () => {
    const downloadOpenFile = vi.fn();
    (window as unknown as { api: unknown }).api = { browser: { downloadOpenFile } };
    useBrowserStore.setState({
      downloads: [
        dl({ id: 'd1', filename: 'report.pdf', state: 'completed' }),
        dl({ id: 'd2', filename: 'pending.zip', state: 'in-progress', endedAt: null }),
      ],
    });

    render(() => {});
    await flush();

    // Completed file shown; an in-progress one is NOT in the recent-completed list.
    expect(container.textContent).toContain('report.pdf');
    expect(container.textContent).not.toContain('pending.zip');
    expect(container.textContent).not.toContain('Downloads will appear here.');

    const fileBtn = buttonByText('report.pdf');
    expect(fileBtn).toBeTruthy();
    click(fileBtn!);
    expect(downloadOpenFile).toHaveBeenCalledWith('d1');
  });

  it('falls back to the empty copy when there are no completed downloads', async () => {
    render(() => {});
    await flush();
    expect(container.textContent).toContain('Downloads will appear here.');
  });
});
