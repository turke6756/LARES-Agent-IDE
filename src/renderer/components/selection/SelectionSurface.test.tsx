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
      {
        id: 'tab-1',
        filePath: 'C:\\ws\\docs\\plan.md',
        workspaceId: 'ws-1',
        rootDirectory: 'C:\\ws',
        pathType: 'windows',
      },
      { id: 'tab-2', filePath: 'C:\\ws\\notes.txt' },
    ],
    selectedWorkspaceId: 'ws-selected',
    agents: [],
    tabEditState: {} as Record<string, unknown>,
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
  it('builds a file context from the tab — markdown files are comment-capable (WP-P5)', () => {
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
      capabilities: { comment: true },
    });
  });

  it('falls back to the selected workspace when the tab has none; non-markdown files stay comment-incapable', () => {
    const ctx = deriveFileSelectionContext({ filePath: 'C:\\ws\\notes.txt' }, 'ws-selected');
    expect(ctx.workspaceId).toBe('ws-selected');
    expect(ctx.sourceLabel).toBe('C:\\ws\\notes.txt');
    expect(ctx.capabilities).toEqual({ comment: false });
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

  it('treats .markdown like .md', () => {
    const ctx = deriveFileSelectionContext({ filePath: '/ws/readme.MARKDOWN' }, 'ws');
    expect(ctx.capabilities.comment).toBe(true);
  });

  it('PDF files are comment-capable (plan 2.5 — the PDFium reader overlay hosts the rows)', () => {
    expect(deriveFileSelectionContext({ filePath: 'C:\\ws\\paper.pdf' }, 'ws').capabilities.comment).toBe(true);
    expect(deriveFileSelectionContext({ filePath: '/ws/PAPER.PDF' }, 'ws').capabilities.comment).toBe(true);
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

  function rightMouseDown(el: HTMLElement) {
    act(() => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }));
    });
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

  it('selection present at right mousedown is prevented and opens the menu', () => {
    const para = mount();
    selectContentsOf(para);
    rightMouseDown(para);
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

  it('selection created after right mousedown is not prevented and opens no menu', () => {
    const para = mount();
    rightMouseDown(para);
    selectContentsOf(para);

    const ev = rightClick(para);

    expect(ev.defaultPrevented).toBe(false);
    expect(menuButton('Send to agent')).toBeUndefined();
  });
});

// ── WP-P5-B: comment flows ────────────────────────────────────────────────

describe('SelectionSurface comment flows', () => {
  let host: HTMLDivElement;
  let root: Root;

  const commentsApi = {
    create: vi.fn(),
    list: vi.fn(async () => []),
    update: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
    resolve: vi.fn(async () => null),
    send: vi.fn(),
    onChanged: vi.fn(() => () => {}),
  };

  beforeEach(() => {
    sendSelectionToAgent.mockClear();
    Object.values(commentsApi).forEach((f) => f.mockClear());
    commentsApi.create.mockImplementation(async (input: Record<string, unknown>) => ({
      id: 'row-1',
      status: 'draft',
      ...input,
    }));
    commentsApi.send.mockImplementation(async () => ({
      ok: true,
      agentId: 'a1',
      launched: true,
    }));
    (window as unknown as { api: unknown }).api = { comments: commentsApi };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.getSelection()?.removeAllRanges();
    document.getElementById('selection-toast-container')?.remove();
  });

  function mountTab(tabId: string, getDocText?: () => string | null) {
    act(() => {
      root.render(
        <SelectionSurface tabId={tabId} getDocText={getDocText}>
          <p id="para">quoted file text</p>
        </SelectionSurface>,
      );
    });
    return document.getElementById('para')!;
  }

  function mountExplicit(getDocText?: () => string | null) {
    act(() => {
      root.render(
        <SelectionSurface
          file={{
            filePath: 'C:\\ws\\.lares\\proposals\\proposal.md',
            workspaceId: 'ws-1',
            rootDirectory: 'C:\\ws',
            pathType: 'windows',
          }}
          getDocText={getDocText}
        >
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
    act(() => {
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      );
    });
  }

  const button = (label: string) =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(label));

  function typeInPopover(text: string) {
    const textarea = document.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('one-shot Comment & send on a non-persisting surface rides the prompt (no DB row)', async () => {
    const para = mountTab('tab-2'); // notes.txt — comment-incapable
    selectContentsOf(para);
    rightClick(para);

    act(() => button('Comment & send')!.click());
    expect(document.querySelector('textarea')).toBeTruthy();
    typeInPopover('fact check this');
    act(() => button('Send to agent')!.click());
    await act(async () => button('New agent')!.click());

    expect(commentsApi.create).not.toHaveBeenCalled();
    expect(sendSelectionToAgent).toHaveBeenCalledTimes(1);
    const [target, , items] = sendSelectionToAgent.mock.calls[0] as unknown as [
      { kind: string },
      unknown,
      Array<{ quote: string; comment?: string }>,
    ];
    expect(target).toEqual({ kind: 'new' });
    expect(items).toEqual([{ quote: 'quoted file text', comment: 'fact check this' }]);
  });

  it('Add comment… on a markdown tab saves a draft row with anchors + doc hash', async () => {
    const docText = 'before text quoted file text after text';
    const para = mountTab('tab-1', () => docText);
    selectContentsOf(para);
    rightClick(para);

    expect(button('Add comment')).toBeTruthy();
    act(() => button('Add comment')!.click());
    typeInPopover('tighten this paragraph');
    await act(async () => button('Save comment')!.click());

    expect(commentsApi.create).toHaveBeenCalledTimes(1);
    const input = commentsApi.create.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      workspaceId: 'ws-1',
      filePath: 'C:\\ws\\docs\\plan.md',
      pathType: 'windows',
      rootDirectory: 'C:\\ws',
      quotedText: 'quoted file text',
      body: 'tighten this paragraph',
      anchorStart: docText.indexOf('quoted file text'),
      anchorEnd: docText.indexOf('quoted file text') + 'quoted file text'.length,
      lineStart: 1,
      lineEnd: 1,
    });
    expect(typeof input.docHash).toBe('string');
    expect((input.docHash as string).length).toBeGreaterThan(0);
    expect(sendSelectionToAgent).not.toHaveBeenCalled();
  });

  it('creates comments for an explicit proposal path without a file tab', async () => {
    const para = mountExplicit(() => 'before quoted file text after');
    selectContentsOf(para);
    rightClick(para);
    act(() => button('Add comment')!.click());
    typeInPopover('proposal feedback');
    await act(async () => button('Save comment')!.click());

    expect(commentsApi.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      filePath: 'C:\\ws\\.lares\\proposals\\proposal.md',
      rootDirectory: 'C:\\ws',
      pathType: 'windows',
      body: 'proposal feedback',
    }));
  });

  it('one-shot Comment & send on a markdown tab persists the row, then sends via comments:send', async () => {
    const para = mountTab('tab-1', () => 'quoted file text');
    selectContentsOf(para);
    rightClick(para);

    act(() => button('Comment & send')!.click());
    typeInPopover('do the thing');
    act(() => button('Send to agent')!.click());
    await act(async () => button('New agent')!.click());

    expect(commentsApi.create).toHaveBeenCalledTimes(1);
    expect(commentsApi.create.mock.calls[0][0]).toMatchObject({ body: 'do the thing' });
    expect(commentsApi.send).toHaveBeenCalledWith({
      commentIds: ['row-1'],
      target: { kind: 'new' },
    });
    // Persisted path — the slice-1 renderer dispatch must NOT also fire.
    expect(sendSelectionToAgent).not.toHaveBeenCalled();
  });
});
