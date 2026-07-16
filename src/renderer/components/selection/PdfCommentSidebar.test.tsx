// @vitest-environment jsdom
/**
 * PdfCommentSidebar (plan §1.10) — loads pdf-anchored rows, positions pins from
 * the injected PDF runtime (not DOM measurement), navigates + flashes on click,
 * and drives the SAME send/resolve/delete dispatch as the markdown gutter via
 * the shared CommentCard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SelectionComment } from '../../../shared/types';
import type { PdfSelectionAnchorV1 } from '../../../shared/pdf-annotations';

const storeMock = vi.hoisted(() => {
  const state = { agents: [] as unknown[] };
  const useDashboardStore = (selector: (s: typeof state) => unknown) => selector(state);
  useDashboardStore.getState = () => state;
  return { useDashboardStore };
});
vi.mock('../../stores/dashboard-store', () => ({ useDashboardStore: storeMock.useDashboardStore }));

import PdfCommentSidebar, { type PdfSidebarRuntime } from './PdfCommentSidebar';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function pdfAnchor(pageIndex: number): PdfSelectionAnchorV1 {
  return {
    version: 1,
    fingerprint: 'fp-1',
    pages: [{ pageIndex, start: { itemIndex: 0, charOffset: 0 }, end: { itemIndex: 1, charOffset: 3 }, rects: [] }],
    prefix: '',
    suffix: '',
  };
}

function makeRow(over: Partial<SelectionComment> & { id: string }): SelectionComment {
  return {
    workspaceId: 'ws-1',
    targetType: 'file',
    kind: 'comment',
    anchorType: 'pdf',
    pdfAnchor: pdfAnchor(2),
    filePath: 'C:\\ws\\paper.pdf',
    pathType: 'windows' as SelectionComment['pathType'],
    rootDirectory: 'C:\\ws',
    docHash: 'fp-1',
    anchorStart: null,
    anchorEnd: null,
    lineStart: null,
    lineEnd: null,
    prefix: null,
    suffix: null,
    quotedText: 'quoted pdf text',
    body: 'a pdf comment body',
    status: 'draft',
    sentToAgentId: null,
    createdAt: '2026-06-12T00:00:00Z',
    updatedAt: '2026-06-12T00:00:00Z',
    sentAt: null,
    resolvedAt: null,
    ...over,
  };
}

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

const navigated: string[] = [];
const runtime: PdfSidebarRuntime = {
  locationFor: (c) => ({ pageIndex: c.pdfAnchor?.pages[0]?.pageIndex ?? 0, top: 40 }),
  navigateToComment: (c) => navigated.push(c.id),
};

describe('PdfCommentSidebar', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.values(commentsApi).forEach((f) => 'mockClear' in f && f.mockClear());
    navigated.length = 0;
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
      root.render(
        <PdfCommentSidebar workspaceId="ws-1" filePath="C:\\ws\\paper.pdf" runtime={runtime} />,
      );
    });
    await act(async () => {});
  }

  const pin = (id: string) => host.querySelector(`[data-testid="pdf-comment-pin-${id}"]`) as HTMLButtonElement | null;
  const button = (text: string): HTMLButtonElement | null =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | null;

  it('renders a pin per pdf comment and ignores text rows', async () => {
    rows = [makeRow({ id: 'p1' }), makeRow({ id: 'p2', anchorType: 'text', pdfAnchor: null })];
    await mount();
    expect(pin('p1')).toBeTruthy();
    expect(pin('p2')).toBeNull(); // text row not shown by the PDF sidebar
  });

  it('clicking a pin navigates the viewer and opens the card with page context', async () => {
    rows = [makeRow({ id: 'p1', pdfAnchor: pdfAnchor(2) })];
    await mount();
    await act(async () => pin('p1')!.click());
    expect(navigated).toEqual(['p1']);
    const card = host.querySelector('[data-testid="pdf-comment-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('a pdf comment body');
    expect(card!.textContent).toContain('Page 3'); // pageIndex 2 → 1-based page 3
  });

  it('send / resolve / delete drive the shared dispatch', async () => {
    rows = [makeRow({ id: 'p1' })];
    await mount();
    await act(async () => pin('p1')!.click());

    await act(async () => button('Send')!.click());
    // picker opens; pick is exercised by the gutter test — here confirm the
    // control is present and resolve/delete reach the API.
    await act(async () => button('Resolve')!.click());
    expect(commentsApi.resolve).toHaveBeenCalledWith('p1');
  });

  it('delete removes the comment', async () => {
    rows = [makeRow({ id: 'p1' })];
    await mount();
    await act(async () => pin('p1')!.click());
    await act(async () => button('Delete')!.click());
    expect(commentsApi.delete).toHaveBeenCalledWith('p1');
  });

  // An open card used to be escapable ONLY via the ✕ glyph in its header, so it
  // read as stuck — the reported symptom was "I couldn't close the note unless I
  // left the tab and came back". Each gesture below is one of the exits a reader
  // actually tries.
  describe('dismissing an open card', () => {
    const card = () => host.querySelector('[data-testid="pdf-comment-card"]');

    async function openCard() {
      rows = [makeRow({ id: 'p1' })];
      await mount();
      await act(async () => pin('p1')!.click());
      expect(card()).toBeTruthy(); // precondition, not the assertion
    }

    it('closes on Escape', async () => {
      await openCard();
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(card()).toBeNull();
    });

    it('closes on a click away from the card', async () => {
      await openCard();
      await act(async () => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(card()).toBeNull();
    });

    it('stays open when the click lands inside the card', async () => {
      await openCard();
      await act(async () => {
        card()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(card()).toBeTruthy();
    });

    it('toggles shut when the same pin is clicked again', async () => {
      await openCard();
      await act(async () => pin('p1')!.click());
      expect(card()).toBeNull();
    });

    it('a pin mousedown does not close-then-reopen the card', async () => {
      // The pin toggles on click. If click-away ALSO closed on the pin's own
      // mousedown, the toggle would immediately re-open it and the dot would
      // look dead — so pins are exempt from click-away.
      await openCard();
      await act(async () => {
        pin('p1')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(card()).toBeTruthy();
    });
  });
});
