// @vitest-environment jsdom
/**
 * WP-P4: SelectionSurface context derivation + wiring. The dashboard store
 * and the dispatch layer are mocked; the contextmenu → menu → picker chain
 * runs against real DOM selection in jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SelectionSurface, { deriveFileSelectionContext } from './SelectionSurface';

const storeMock = vi.hoisted(() => {
  const state = {
    openTabs: [
      { id: 'tab-1', filePath: 'C:\\ws\\docs\\plan.md', workspaceId: 'ws-1' },
      { id: 'tab-2', filePath: 'C:\\ws\\notes.txt' },
    ],
    selectedWorkspaceId: 'ws-selected',
    agents: [],
  };
  const useDashboardStore = (selector: (s: typeof state) => unknown) => selector(state);
  useDashboardStore.getState = () => state;
  return { state, useDashboardStore };
});

vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: storeMock.useDashboardStore,
}));

const sendSelectionToAgent = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../lib/selection/selection-dispatch', () => ({ sendSelectionToAgent }));

describe('deriveFileSelectionContext', () => {
  it('builds a file context from the tab', () => {
    expect(
      deriveFileSelectionContext(
        { filePath: 'C:\\ws\\docs\\plan.md', workspaceId: 'ws-1' },
        'ws-selected',
      ),
    ).toEqual({
      targetType: 'file',
      workspaceId: 'ws-1',
      sourceLabel: 'C:\\ws\\docs\\plan.md',
      file: { filePath: 'C:\\ws\\docs\\plan.md' },
      capabilities: { comment: false },
    });
  });

  it('falls back to the selected workspace when the tab has none', () => {
    const ctx = deriveFileSelectionContext({ filePath: 'C:\\ws\\notes.txt' }, 'ws-selected');
    expect(ctx.workspaceId).toBe('ws-selected');
    expect(ctx.sourceLabel).toBe('C:\\ws\\notes.txt');
  });

  it('degrades safely with no tab at all', () => {
    expect(deriveFileSelectionContext(undefined, null)).toEqual({
      targetType: 'file',
      workspaceId: '',
      sourceLabel: '',
      file: { filePath: '' },
      capabilities: { comment: false },
    });
  });
});

describe('SelectionSurface wiring', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sendSelectionToAgent.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.getSelection()?.removeAllRanges();
  });

  function mount() {
    act(() => {
      root.render(
        <SelectionSurface tabId="tab-1">
          <p id="para">quoted file text</p>
        </SelectionSurface>,
      );
    });
    return document.getElementById('para')!;
  }

  function selectContentsOf(el: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function rightClick(el: HTMLElement) {
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    act(() => {
      el.dispatchEvent(ev);
    });
    return ev;
  }

  const menuButton = (label: string) =>
    Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(label),
    );

  it('right-click without a selection leaves the event alone', () => {
    const para = mount();
    const ev = rightClick(para);
    expect(ev.defaultPrevented).toBe(false);
    expect(menuButton('Send to agent')).toBeUndefined();
  });

  it('right-click on a selection opens the menu; picking "New agent" dispatches the tab-derived file context', () => {
    const para = mount();
    selectContentsOf(para);
    const ev = rightClick(para);
    expect(ev.defaultPrevented).toBe(true);

    act(() => menuButton('Send to agent')!.click());
    act(() => menuButton('New agent')!.click());

    expect(sendSelectionToAgent).toHaveBeenCalledTimes(1);
    const [target, ctx, items] = sendSelectionToAgent.mock.calls[0] as unknown as [
      { kind: string },
      Record<string, unknown>,
      Array<{ quote: string }>,
    ];
    expect(target).toEqual({ kind: 'new' });
    expect(ctx).toMatchObject({
      targetType: 'file',
      workspaceId: 'ws-1',
      sourceLabel: 'C:\\ws\\docs\\plan.md',
      file: { filePath: 'C:\\ws\\docs\\plan.md' },
      quotedText: 'quoted file text',
    });
    expect(items).toEqual([{ quote: 'quoted file text' }]);
  });
});
