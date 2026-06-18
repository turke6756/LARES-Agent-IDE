// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import HistoryView from './HistoryView';
import { __resetSuspendCount } from './useBrowserSuspension';
import { useBrowserStore, type HistoryEntry } from '../../stores/browser-store';

// Slice-8 acceptance (history upgrade):
//   REQUIRED: clear-all CONFIRMS — the first "Clear all" click must NOT wipe
//   history; only an explicit "Confirm" calls through to historyClear. We also
//   smoke-test that pagination requests pages from the backend and that the
//   view never surfaces an (impossible) agent URL — history is user-partition
//   only by construction, so a well-behaved backend returns user rows only.

interface ListArgs { query?: string; limit?: number; offset?: number }
const listCalls: ListArgs[] = [];
let clearCount = 0;
let historyRows: HistoryEntry[] = [];

function hist(over: Partial<HistoryEntry> & { id: string }): HistoryEntry {
  return {
    url: 'https://example.com/',
    title: 'Example',
    visitedAt: Date.now(),
    visitCount: 1,
    favicon: null,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(HistoryView));
  });
}

/** Flush the 150ms query debounce + the async loadPage microtasks. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
}

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim().toLowerCase().includes(text.toLowerCase()),
  ) as HTMLButtonElement | undefined;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  __resetSuspendCount();
  listCalls.length = 0;
  clearCount = 0;
  historyRows = [
    hist({ id: 'h1', url: 'https://user-a.example/', title: 'User A' }),
    hist({ id: 'h2', url: 'https://user-b.example/', title: 'User B' }),
  ];
  (window as unknown as { api: unknown }).api = {
    browser: {
      setVisible: () => {},
      historyList: async (q?: ListArgs) => {
        listCalls.push(q ?? {});
        // Only the first page returns rows; later offsets are empty (end of list).
        return (q?.offset ?? 0) === 0 ? historyRows : [];
      },
      historyDelete: () => {},
      historyClear: () => {
        clearCount += 1;
        historyRows = [];
      },
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  useBrowserStore.setState({ historyViewOpen: true, activeTabId: 't1' });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  delete (window as unknown as { api?: unknown }).api;
  useBrowserStore.setState({ historyViewOpen: false });
});

describe('HistoryView clear-all confirmation (Slice 8)', () => {
  it('REQUIRED: the first Clear all click does NOT clear — only Confirm does', async () => {
    render();
    await flush();

    // Rows are present.
    expect(container.textContent).toContain('User A');

    // First click arms the confirm state but must NOT call historyClear.
    const clearBtn = button('Clear all');
    expect(clearBtn).toBeTruthy();
    click(clearBtn!);
    expect(clearCount).toBe(0);
    expect(container.textContent).toContain('Clear all history?');

    // Cancel backs out without clearing.
    const cancelBtn = button('Cancel');
    expect(cancelBtn).toBeTruthy();
    click(cancelBtn!);
    expect(clearCount).toBe(0);

    // Re-arm and Confirm → exactly one historyClear.
    click(button('Clear all')!);
    const confirmBtn = button('Confirm');
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(clearCount).toBe(1);
  });

  it('requests an offset-paginated page (not a hard 100-row fetch) and shows user rows only', async () => {
    render();
    await flush();

    // The view paginates with an explicit limit/offset (Slice-8 contract).
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls[0].limit).toBe(100);
    expect(listCalls[0].offset).toBe(0);

    // History is user-partition only by construction — no agent URL can appear.
    expect(container.textContent).toContain('user-a.example');
    expect(container.textContent).not.toContain('agent');
  });
});
