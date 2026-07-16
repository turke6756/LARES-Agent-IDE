// @vitest-environment jsdom
//
// Phase 3.3 / 3.6 — the PDF persistence + dispatch path.
//
// The whole point of the PDF comment stack is that it is the SAME stack: one
// `window.api.comments` IPC, one status machine, one send dispatch. These tests
// pin the parts that are genuinely PDF-specific — the durable anchor payload,
// `doc_hash` carrying the PDF fingerprint rather than a markdown content hash,
// and the reattach-outcome writeback — and assert that everything else is byte
// -identical to the text path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPdfComment, sendPersistedComments, updatePdfAnchor } from './comment-actions';
import { SELECTION_COMMENTS_CHANGED_EVENT } from './comment-events';
import type { PdfSelectionAnchorV1 } from '../../../shared/pdf-annotations';

const mockAgents: Array<{ id: string; title: string }> = [];
vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: { getState: () => ({ agents: mockAgents }) },
}));
vi.mock('./selection-toast', () => ({ showSelectionToast: vi.fn() }));

const create = vi.fn();
const update = vi.fn();
const send = vi.fn();

const ANCHOR: PdfSelectionAnchorV1 = {
  version: 1,
  fingerprint: 'fp-deadbeef',
  pages: [
    {
      pageIndex: 2,
      pageLabel: 'iii',
      start: { itemIndex: 0, charOffset: 4 },
      end: { itemIndex: 1, charOffset: 9 },
      rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.05 }],
    },
  ],
  prefix: 'before ',
  suffix: ' after',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAgents.length = 0;
  create.mockImplementation(async (input: unknown) => ({ id: 'pdf-row-1', ...(input as object) }));
  send.mockResolvedValue({ ok: true, agentId: 'a1', launched: false });
  (window as unknown as { api: unknown }).api = { comments: { create, update, send } };
});

describe('createPdfComment', () => {
  it('persists the durable anchor and pins doc_hash to the PDF fingerprint', async () => {
    const changed = vi.fn();
    window.addEventListener(SELECTION_COMMENTS_CHANGED_EVENT, changed);

    const row = await createPdfComment({
      workspaceId: 'ws-1',
      filePath: 'C:\\ws\\paper.pdf',
      pathType: 'windows',
      rootDirectory: 'C:\\ws',
      quotedText: 'quick brown',
      body: 'is this the right figure?',
      anchor: ANCHOR,
    });

    expect(row.id).toBe('pdf-row-1');
    const input = create.mock.calls[0][0];
    expect(input.anchorType).toBe('pdf');
    expect(input.pdfAnchor).toBe(ANCHOR);
    // doc_hash is the PDF fingerprint (plan §1.4) — NOT a markdown content hash.
    expect(input.docHash).toBe('fp-deadbeef');
    expect(input.quotedText).toBe('quick brown');
    expect(input.body).toBe('is this the right figure?');
    expect(input.kind).toBe('comment');
    // prefix/suffix stay populated for UI/search/prompt compatibility.
    expect(input.prefix).toBe('before ');
    expect(input.suffix).toBe(' after');
    expect(input.pathType).toBe('windows');
    expect(input.rootDirectory).toBe('C:\\ws');

    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(SELECTION_COMMENTS_CHANGED_EVENT, changed);
  });

  it('writes a highlight with an empty body even if one is supplied', async () => {
    await createPdfComment({
      workspaceId: 'ws-1',
      filePath: 'C:\\ws\\paper.pdf',
      quotedText: 'quick brown',
      body: 'ignored for a highlight',
      anchor: ANCHOR,
      kind: 'highlight',
    });
    const input = create.mock.calls[0][0];
    expect(input.kind).toBe('highlight');
    expect(input.body).toBe('');
  });

  it('persists a coordinate-only region note (no prefix/suffix to carry)', async () => {
    const regionAnchor: PdfSelectionAnchorV1 = {
      version: 1,
      fingerprint: 'fp-scan',
      pages: [
        {
          pageIndex: 3,
          start: { itemIndex: 0, charOffset: 0 },
          end: { itemIndex: 0, charOffset: 0 },
          rects: [{ x: 0.2, y: 0.3, width: 0.3, height: 0.2 }],
        },
      ],
      prefix: '',
      suffix: '',
    };
    await createPdfComment({
      workspaceId: 'ws-1',
      filePath: 'C:\\ws\\scan.pdf',
      quotedText: '[Area on PDF page 4]',
      body: 'what is this chart?',
      anchor: regionAnchor,
    });
    const input = create.mock.calls[0][0];
    expect(input.quotedText).toBe('[Area on PDF page 4]');
    expect(input.docHash).toBe('fp-scan');
    // Empty context must not be written as empty strings.
    expect(input.prefix).toBeUndefined();
    expect(input.suffix).toBeUndefined();
  });

  it('propagates an IPC failure so the caller can toast', async () => {
    create.mockRejectedValueOnce(new Error('db is locked'));
    await expect(
      createPdfComment({
        workspaceId: 'ws-1',
        filePath: 'C:\\ws\\paper.pdf',
        quotedText: 'q',
        body: 'b',
        anchor: ANCHOR,
      }),
    ).rejects.toThrow('db is locked');
  });
});

describe('updatePdfAnchor', () => {
  it('writes the reattach verdict + repointed anchor and announces the change', async () => {
    const changed = vi.fn();
    window.addEventListener(SELECTION_COMMENTS_CHANGED_EVENT, changed);

    await updatePdfAnchor('pdf-row-1', ANCHOR, 'needs-review', 'C:\\ws\\paper.pdf');

    expect(update).toHaveBeenCalledWith('pdf-row-1', {
      anchorType: 'pdf',
      pdfAnchor: ANCHOR,
      status: 'needs-review',
      prefix: 'before ',
      suffix: ' after',
      docHash: 'fp-deadbeef',
    });
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(SELECTION_COMMENTS_CHANGED_EVENT, changed);
  });
});

describe('PDF send path', () => {
  it('sends the PERSISTED row id — main builds the prompt from the row (plan §1.8)', async () => {
    const row = await createPdfComment({
      workspaceId: 'ws-1',
      filePath: 'C:\\ws\\paper.pdf',
      quotedText: 'quick brown',
      body: 'check this',
      anchor: ANCHOR,
    });

    mockAgents.push({ id: 'a1', title: 'Builder' });
    const result = await sendPersistedComments([row.id], { kind: 'existing', agentId: 'a1' }, 'C:\\ws\\paper.pdf');

    expect(send).toHaveBeenCalledWith({
      commentIds: ['pdf-row-1'],
      target: { kind: 'existing', agentId: 'a1' },
    });
    expect(result.ok).toBe(true);
    // The renderer never builds the PDF prompt itself — no page/quote text is
    // passed to the send IPC, only the row id.
    expect(JSON.stringify(send.mock.calls[0][0])).not.toContain('quick brown');
  });

  it('uses the identical dispatch for PDF rows as for text rows (send-all)', async () => {
    mockAgents.push({ id: 'a1', title: 'Builder' });
    await sendPersistedComments(['pdf-1', 'pdf-2'], { kind: 'new' }, 'C:\\ws\\paper.pdf');
    expect(send).toHaveBeenCalledWith({
      commentIds: ['pdf-1', 'pdf-2'],
      target: { kind: 'new' },
    });
  });
});
