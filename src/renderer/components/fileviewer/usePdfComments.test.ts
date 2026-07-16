// @vitest-environment jsdom
//
// Phase 3.4 — the reader's comment pipeline, IO half.
//
// The ladder POLICY is tested in `lib/pdf/pdf-comment-placement.test.ts`; this
// file pins the parts that only exist once the hook composes that policy with
// real IO — the warm set, the durable writeback, the stale-load guard, and the
// two live subscriptions. The acceptance bar these serve is "a modified PDF
// yields needs-review/orphaned, never a silent wrong attach": that guarantee is
// only true end-to-end if the hook warms every page the ladder intends to read,
// so a page-warming regression is what would silently orphan a good comment.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SelectionComment, SelectionCommentStatus } from '../../../shared/types';
import type { PdfSelectionAnchorV1 } from '../../../shared/pdf-annotations';
import type { PdfTextModel } from '../../lib/pdf/pdf-text-model';
import { normalizePageTextContent } from '../../lib/pdf/pdf-text-geometry';
import type { NormalizedPageText } from '../../lib/pdf/pdf-text-geometry';
import { capturePdfAnchor, captureCoordinateOnlyAnchor } from '../../lib/pdf/pdf-comment-anchors';
import { notifyCommentsChanged } from '../../lib/selection/comment-events';

const updateMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/selection/comment-actions', () => ({
  updatePdfAnchor: updateMock,
}));

import { usePdfComments } from './usePdfComments';
import type { UsePdfCommentsResult } from './usePdfComments';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const FP = 'fp-original';
const FILE = 'C:\\ws\\paper.pdf';

function page(pageIndex: number, strs: string[]): NormalizedPageText {
  return normalizePageTextContent(
    pageIndex,
    strs.map((str, i) => ({
      str,
      transform: [10, 0, 0, 10, 20, 700 - i * 14],
      width: str.length * 5,
      height: 10,
      dir: 'ltr',
      hasEOL: true,
    })),
    612,
    792,
  );
}

function row(
  overrides: Partial<SelectionComment> & { pdfAnchor: PdfSelectionAnchorV1; quotedText: string },
): SelectionComment {
  return {
    id: 'c1',
    workspaceId: 'ws-1',
    filePath: FILE,
    kind: 'comment',
    body: 'a note',
    status: 'draft' as SelectionCommentStatus,
    createdAt: '2026-01-01T00:00:00Z',
    anchorType: 'pdf',
    ...overrides,
  } as SelectionComment;
}

function anchorOver(pageText: NormalizedPageText, from: number, to: number) {
  return capturePdfAnchor({
    fingerprint: FP,
    start: { pageIndex: pageText.pageIndex, itemIndex: 0, charOffset: from },
    end: { pageIndex: pageText.pageIndex, itemIndex: 0, charOffset: to },
    pages: [pageText],
  });
}

/** A structural stand-in for PdfTextModel — the hook only reads these two. */
function textModel(pages: NormalizedPageText[], fingerprint = FP) {
  const byIndex = new Map(pages.map((p) => [p.pageIndex, p]));
  const getPageText = vi.fn(async (pageIndex: number) => {
    const hit = byIndex.get(pageIndex);
    if (!hit) throw new Error(`no text for page ${pageIndex}`);
    return hit;
  });
  return { fingerprint, getPageText } as unknown as PdfTextModel & {
    getPageText: ReturnType<typeof vi.fn>;
  };
}

const list = vi.fn();
const onChanged = vi.fn();
let mainListeners: Array<(p: { comments: SelectionComment[] }) => void> = [];

let container: HTMLDivElement;
let root: Root;
let latest: UsePdfCommentsResult;

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

function Probe(props: { filePath: string; model: PdfTextModel | null; pageCount?: number }) {
  latest = usePdfComments({
    workspaceId: 'ws-1',
    filePath: props.filePath,
    textModel: props.model,
    pageCount: props.pageCount ?? 10,
  });
  return null;
}

async function render(props: { filePath?: string; model: PdfTextModel | null; pageCount?: number }) {
  await act(async () => {
    root.render(React.createElement(Probe, { filePath: props.filePath ?? FILE, ...props }));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  mainListeners = [];
  onChanged.mockImplementation((cb: (p: { comments: SelectionComment[] }) => void) => {
    mainListeners.push(cb);
    return () => {
      mainListeners = mainListeners.filter((l) => l !== cb);
    };
  });
  list.mockResolvedValue([]);
  updateMock.mockResolvedValue(undefined);
  (window as unknown as { api: unknown }).api = { comments: { list, onChanged } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('usePdfComments — loading', () => {
  it('idles until the document opens — no IPC, nothing to paint', async () => {
    await render({ model: null });
    expect(list).not.toHaveBeenCalled();
    expect(latest.commentsByPage.size).toBe(0);
  });

  it('turns persisted rows into per-page paint geometry', async () => {
    const p = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(p, 4, 15);
    list.mockResolvedValue([row({ pdfAnchor: anchor, quotedText: quote })]);

    await render({ model: textModel([p]) });

    expect(list).toHaveBeenCalledWith('ws-1', FILE);
    expect(latest.commentsByPage.get(3)!.map((c) => c.id)).toEqual(['c1']);
    expect(latest.placements[0].status).toBe('reopened');
  });

  it('drops markdown rows — they stay the gutter’s business', async () => {
    const p = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(p, 4, 15);
    list.mockResolvedValue([
      row({ id: 'pdf', pdfAnchor: anchor, quotedText: quote }),
      row({ id: 'md', pdfAnchor: anchor, quotedText: quote, anchorType: 'text' }),
    ]);

    await render({ model: textModel([p]) });
    expect(latest.placements.map((pl) => pl.row.id)).toEqual(['pdf']);
  });

  it('never calls the text model when no PDF rows exist', async () => {
    const p = page(3, ['The quick brown fox jumps']);
    const model = textModel([p]);
    list.mockResolvedValue([]);
    await render({ model });
    expect(model.getPageText).not.toHaveBeenCalled();
  });
});

describe('usePdfComments — the warm set', () => {
  it('warms only the anchored page when the document is unchanged', async () => {
    const p = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(p, 4, 15);
    list.mockResolvedValue([row({ pdfAnchor: anchor, quotedText: quote })]);
    const model = textModel([p]);

    await render({ model });
    expect(model.getPageText.mock.calls.map((c) => c[0])).toEqual([3]);
  });

  it('warms the ±2 relocation sweep when the fingerprint changed, so the ladder can never miss a page it meant to read', async () => {
    const original = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(original, 4, 15);
    list.mockResolvedValue([row({ pdfAnchor: anchor, quotedText: quote })]);
    // Document re-saved: same text, new fingerprint.
    const model = textModel([original], 'fp-v2');

    await render({ model });
    expect(model.getPageText.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('tolerates a page whose text cannot be extracted — a coordinate-only pin still paints', async () => {
    const captured = captureCoordinateOnlyAnchor({
      fingerprint: FP,
      pageIndex: 2,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.25 }],
    });
    list.mockResolvedValue([row({ pdfAnchor: captured.anchor, quotedText: captured.quote })]);

    // A scanned page: getPageText rejects for every page.
    await render({ model: textModel([]) });

    expect(latest.placements[0].status).toBe('coordinate-only');
    expect(latest.commentsByPage.get(2)).toHaveLength(1);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('usePdfComments — durable writeback', () => {
  it('a plain reopen writes NOTHING (plan §1.9: zoom/scroll never mutate an anchor)', async () => {
    const p = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(p, 4, 15);
    list.mockResolvedValue([row({ pdfAnchor: anchor, quotedText: quote })]);

    await render({ model: textModel([p]) });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('a modified PDF persists the orphaned verdict rather than attaching somewhere wrong', async () => {
    const original = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(original, 4, 15);
    list.mockResolvedValue([row({ pdfAnchor: anchor, quotedText: quote })]);

    await render({ model: textModel([page(3, ['entirely different content now'])], 'fp-v2') });

    expect(latest.placements[0].status).toBe('orphaned');
    expect(updateMock).toHaveBeenCalledWith('c1', anchor, 'orphaned', FILE);
  });

  it('repoints onto the new fingerprint when the quote is still there', async () => {
    const original = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(original, 4, 15);
    list.mockResolvedValue([row({ pdfAnchor: anchor, quotedText: quote })]);

    await render({ model: textModel([original], 'fp-v2') });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const [id, nextAnchor, status] = updateMock.mock.calls[0];
    expect(id).toBe('c1');
    expect(nextAnchor.fingerprint).toBe('fp-v2');
    expect(status).toBe('draft'); // geometry repointed; status preserved
  });

  it('a failed writeback is logged, never thrown at the reader', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    updateMock.mockRejectedValue(new Error('db is locked'));
    const original = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(original, 4, 15);
    list.mockResolvedValue([row({ pdfAnchor: anchor, quotedText: quote })]);

    await render({ model: textModel([page(3, ['entirely different content now'])], 'fp-v2') });

    // The verdict still reaches the overlay even though the write failed.
    expect(latest.placements[0].status).toBe('orphaned');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('usePdfComments — staying live', () => {
  it('reloads when a local mutation announces on this file', async () => {
    const p = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(p, 4, 15);
    list.mockResolvedValue([row({ pdfAnchor: anchor, quotedText: quote })]);
    await render({ model: textModel([p]) });
    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => notifyCommentsChanged(FILE));
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('reloads on a main-side status transition for this file, and ignores other files', async () => {
    const p = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(p, 4, 15);
    const r = row({ pdfAnchor: anchor, quotedText: quote });
    list.mockResolvedValue([r]);
    await render({ model: textModel([p]) });
    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => {
      mainListeners.forEach((l) => l({ comments: [{ ...r, status: 'sent' } as SelectionComment] }));
    });
    await flush();
    expect(list).toHaveBeenCalledTimes(2);

    // A change on an unrelated file must not re-run this file's ladder.
    await act(async () => {
      mainListeners.forEach((l) =>
        l({ comments: [{ ...r, filePath: 'C:\\ws\\other.pdf' } as SelectionComment] }),
      );
    });
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes on unmount', async () => {
    const p = page(3, ['The quick brown fox jumps']);
    await render({ model: textModel([p]) });
    expect(mainListeners).toHaveLength(1);
    await act(async () => root.unmount());
    expect(mainListeners).toHaveLength(0);
    // Re-created so afterEach's unmount stays valid.
    root = createRoot(container);
  });
});

describe('usePdfComments — the stale-load guard', () => {
  it('a slow load for the previous file never paints over the current one', async () => {
    const pA = page(3, ['The quick brown fox jumps']);
    const pB = page(6, ['Another line entirely here']);
    const a = anchorOver(pA, 4, 15);
    const b = anchorOver(pB, 0, 7);

    // File A's list hangs; file B's resolves immediately.
    let releaseA: (rows: SelectionComment[]) => void = () => {};
    list.mockImplementationOnce(
      () => new Promise<SelectionComment[]>((resolve) => { releaseA = resolve; }),
    );
    await render({ filePath: FILE, model: textModel([pA]) });
    expect(latest.commentsByPage.size).toBe(0);

    const FILE_B = 'C:\\ws\\other.pdf';
    list.mockResolvedValue([
      row({ id: 'b1', filePath: FILE_B, pdfAnchor: b.anchor, quotedText: b.quote }),
    ]);
    await render({ filePath: FILE_B, model: textModel([pB]) });
    expect(latest.commentsByPage.get(6)!.map((c) => c.id)).toEqual(['b1']);

    // A's load finally resolves — it must be discarded, not painted.
    await act(async () => {
      releaseA([row({ id: 'a1', pdfAnchor: a.anchor, quotedText: a.quote })]);
    });
    await flush();

    expect(latest.commentsByPage.has(3)).toBe(false);
    expect(latest.commentsByPage.get(6)!.map((c) => c.id)).toEqual(['b1']);
  });
});
