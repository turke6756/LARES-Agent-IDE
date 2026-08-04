// @vitest-environment jsdom
/**
 * WP-P5-B: FileCommentGutter — markers from persisted rows, orphan flipping
 * when the underlying text is gone, expanded card actions (send one / send
 * all / resolve / delete) against a mocked, stateful comments API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SelectionComment } from '../../../shared/types';

const storeMock = vi.hoisted(() => {
  const state = {
    openTabs: [
      {
        id: 'tab-1',
        filePath: 'C:\\ws\\doc.md',
        workspaceId: 'ws-1',
        rootDirectory: 'C:\\ws',
        pathType: 'windows',
      },
    ],
    selectedWorkspaceId: 'ws-1',
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

import FileCommentGutter from './FileCommentGutter';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeRow(over: Partial<SelectionComment> & { id: string }): SelectionComment {
  return {
    workspaceId: 'ws-1',
    targetType: 'file',
    kind: 'comment',
    filePath: 'C:\\ws\\doc.md',
    pathType: 'windows' as SelectionComment['pathType'],
    rootDirectory: 'C:\\ws',
    docHash: null,
    anchorStart: null,
    anchorEnd: null,
    lineStart: null,
    lineEnd: null,
    prefix: null,
    suffix: null,
    quotedText: 'unset',
    body: 'a comment body',
    status: 'draft',
    sentToAgentId: null,
    createdAt: '2026-06-12T00:00:00Z',
    updatedAt: '2026-06-12T00:00:00Z',
    sentAt: null,
    resolvedAt: null,
    ...over,
  };
}

// Stateful mock: update/delete/resolve mutate `rows`, so the reload the
// gutter does after a flip sees the persisted status (matching main).
let rows: SelectionComment[] = [];
const commentsApi = {
  create: vi.fn(),
  list: vi.fn(async () => rows.map((r) => ({ ...r }))),
  update: vi.fn(async (id: string, updates: Partial<SelectionComment>) => {
    rows = rows.map((r) => (r.id === id ? { ...r, ...updates } : r));
    return rows.find((r) => r.id === id) ?? null;
  }),
  delete: vi.fn(async (id: string) => {
    rows = rows.filter((r) => r.id !== id);
  }),
  resolve: vi.fn(async (id: string) => {
    rows = rows.map((r) => (r.id === id ? { ...r, status: 'resolved' as const } : r));
    return rows.find((r) => r.id === id) ?? null;
  }),
  send: vi.fn(async (_req: { commentIds: string[]; target: unknown }) => ({
    ok: true as const,
    agentId: 'a1',
    launched: true,
  })),
  onChanged: vi.fn(() => () => {}),
};

function Host() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="relative">
      <div ref={ref}>
        <p>alpha bravo charlie</p>
        <p>delta echo foxtrot</p>
      </div>
      <FileCommentGutter tabId="tab-1" scrollRef={ref} />
    </div>
  );
}

function ExplicitHost() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="relative">
      <div ref={ref}><p>alpha bravo charlie</p></div>
      <FileCommentGutter
        filePath={'C:\\ws\\.lares\\proposals\\proposal.md'}
        workspaceId="ws-1"
        scrollRef={ref}
      />
    </div>
  );
}

describe('FileCommentGutter', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.values(commentsApi).forEach((f) => 'mockClear' in f && f.mockClear());
    (window as unknown as { api: unknown }).api = { comments: commentsApi };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.getElementById('selection-toast-container')?.remove();
  });

  async function mount() {
    await act(async () => {
      root.render(<Host />);
    });
    // flush list → setComments → measure
    await act(async () => {});
  }

  const marker = (id: string) => document.querySelector(`[data-testid="comment-marker-${id}"]`);
  const button = (label: string) =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(label));

  it('renders one marker per non-resolved comment; resolved rows are hidden', async () => {
    rows = [
      makeRow({ id: 'c1', quotedText: 'alpha bravo' }),
      makeRow({ id: 'c2', quotedText: 'echo foxtrot' }),
      makeRow({ id: 'c3', quotedText: 'alpha bravo', status: 'resolved' }),
    ];
    await mount();
    expect(marker('c1')).toBeTruthy();
    expect(marker('c2')).toBeTruthy();
    expect(marker('c3')).toBeNull();
  });

  it('loads and displays comments for an explicit proposal path without a tab', async () => {
    rows = [makeRow({
      id: 'proposal-comment',
      filePath: 'C:\\ws\\.lares\\proposals\\proposal.md',
      quotedText: 'alpha bravo',
    })];
    await act(async () => { root.render(<ExplicitHost />); });
    await act(async () => {});

    expect(commentsApi.list).toHaveBeenCalledWith('ws-1', 'C:\\ws\\.lares\\proposals\\proposal.md');
    expect(marker('proposal-comment')).toBeTruthy();
  });

  it('flips a draft whose text is gone to orphaned (and shows the orphan marker)', async () => {
    rows = [
      makeRow({ id: 'c1', quotedText: 'alpha bravo' }),
      makeRow({ id: 'gone', quotedText: 'text that was mangled away', prefix: 'x', suffix: 'y' }),
    ];
    await mount();
    await act(async () => {}); // flush the status flip + reload

    expect(commentsApi.update).toHaveBeenCalledWith('gone', { status: 'orphaned' });
    expect(rows.find((r) => r.id === 'gone')!.status).toBe('orphaned');
    const m = marker('gone');
    expect(m).toBeTruthy();
    expect(m!.getAttribute('data-status')).toBe('orphaned');
    // The attached one stayed a draft.
    expect(rows.find((r) => r.id === 'c1')!.status).toBe('draft');
  });

  it('expands to a card and sends just that comment', async () => {
    rows = [
      makeRow({ id: 'c1', quotedText: 'alpha bravo', body: 'first note' }),
      makeRow({ id: 'c2', quotedText: 'echo foxtrot', body: 'second note' }),
    ];
    await mount();

    await act(async () => (marker('c1') as HTMLButtonElement).click());
    const card = document.querySelector('[data-testid="comment-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('first note');

    await act(async () => button('Send')!.click());
    await act(async () => button('New agent')!.click());
    expect(commentsApi.send).toHaveBeenCalledWith({
      commentIds: ['c1'],
      target: { kind: 'new' },
    });
  });

  it('send all sends every draft for the file as one request', async () => {
    rows = [
      makeRow({ id: 'c1', quotedText: 'alpha bravo', createdAt: '2026-06-12T00:00:01Z' }),
      makeRow({ id: 'c2', quotedText: 'echo foxtrot', createdAt: '2026-06-12T00:00:02Z' }),
      makeRow({ id: 'c3', quotedText: 'delta echo', status: 'sent', createdAt: '2026-06-12T00:00:03Z' }),
    ];
    await mount();

    await act(async () => (marker('c1') as HTMLButtonElement).click());
    await act(async () => button('Send all (2)')!.click());
    await act(async () => button('New agent')!.click());

    const req = commentsApi.send.mock.calls[0][0] as { commentIds: string[] };
    expect(new Set(req.commentIds)).toEqual(new Set(['c1', 'c2'])); // drafts only, not the sent row
  });

  it('resolve and delete act on the expanded comment', async () => {
    rows = [
      makeRow({ id: 'c1', quotedText: 'alpha bravo' }),
      makeRow({ id: 'c2', quotedText: 'echo foxtrot' }),
    ];
    await mount();

    await act(async () => (marker('c1') as HTMLButtonElement).click());
    await act(async () => button('Resolve')!.click());
    expect(commentsApi.resolve).toHaveBeenCalledWith('c1');
    await act(async () => {}); // reload
    expect(marker('c1')).toBeNull();

    await act(async () => (marker('c2') as HTMLButtonElement).click());
    await act(async () => button('Delete')!.click());
    expect(commentsApi.delete).toHaveBeenCalledWith('c2');
    await act(async () => {});
    expect(marker('c2')).toBeNull();
  });
});
