// @vitest-environment jsdom
//
// WP-P4E — the plan comments rail. Guarantees under test:
//   • Threads associate to the CURRENTLY-OPEN document (per-document scoping from
//     the projection's `target.documentId`); a thread on another document does not
//     show while that other doc is closed.
//   • Reply threads render in order (oldest first).
//   • Orphaned targets are surfaced in their own section, never dropped and never
//     rendered as a clickable open-affordance.
//   • The compose box routes a new comment through `plans.createComment` with only
//     { planId, ref, body } — the renderer never supplies a recipient — and the
//     rail refetches so the new thread appears.
//   • A create rejection (ok:false) surfaces the reason.
//   • Reply is gated to supervisors: with none, no reply control appears; with one,
//     posting calls `plans.replyComment` with the chosen caller and refetches.
//   • A reply rejection keeps the form open and surfaces the reason.
//   • With no open document, the rail shows the "open a document" hint and no
//     compose box, but still surfaces orphaned threads.
//   • A preload without `listComments` degrades to empty (no throw).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlanCommentsRail from './PlanCommentsRail';
import { useDashboardStore } from '../../stores/dashboard-store';
import type {
  PlanCommentThread,
  PlanCommentsProjection,
  PlanCommentTarget,
  PlanTabDocument,
  SelectionComment,
  SelectionCommentReply,
} from '../../../shared/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let listMock: ReturnType<typeof vi.fn>;
let createMock: ReturnType<typeof vi.fn>;
let replyMock: ReturnType<typeof vi.fn>;
// The projection store the mocked IPC reads; create/reply mutate it and the rail
// refetches — exactly the round-trip the rail relies on to show a new thread/reply.
let projection: PlanCommentsProjection;

function comment(over: Partial<SelectionComment> = {}): SelectionComment {
  return {
    id: 'c-1',
    workspaceId: 'ws-1',
    targetType: 'file',
    kind: 'comment',
    anchorType: 'text',
    pdfAnchor: null,
    filePath: 'lares-plan-doc:v1:abc',
    pathType: null,
    rootDirectory: null,
    docHash: null,
    anchorStart: null,
    anchorEnd: null,
    lineStart: null,
    lineEnd: null,
    prefix: null,
    suffix: null,
    quotedText: '',
    body: 'A question.',
    status: 'queued',
    sentToAgentId: null,
    createdAt: '2026-08-03T00:00:00Z',
    updatedAt: '2026-08-03T00:00:00Z',
    sentAt: null,
    resolvedAt: null,
    ...over,
  };
}

function reply(over: Partial<SelectionCommentReply> = {}): SelectionCommentReply {
  return { id: 'r-1', commentId: 'c-1', body: 'An answer.', authorAgentId: 'sup-1', createdAt: 1, ...over };
}

function thread(comment_: SelectionComment, target: PlanCommentTarget, replies: SelectionCommentReply[] = []): PlanCommentThread {
  return { comment: comment_, replies, target };
}

const folderTarget = (documentId: string, name = 'plan.md'): PlanCommentTarget => ({
  kind: 'folder-doc',
  documentId,
  tab: 'plan',
  docRelPath: `x/${name}`,
  name,
});
const orphanTarget: PlanCommentTarget = { kind: 'orphaned', docRelPath: 'deliberations/gone.md' };

function activeDoc(documentId = 'd-plan', name = 'plan.md'): PlanTabDocument {
  return { ref: { source: 'folder', documentId }, name, kind: 'plan', sizeBytes: 100, mtimeMs: 1 };
}

function seedSupervisors(count: number): void {
  const agents = Array.from({ length: count }, (_v, i) => ({
    id: `sup-${i + 1}`,
    title: `Supervisor ${i + 1}`,
    workspaceId: 'ws-1',
    isSupervisor: true,
  }));
  useDashboardStore.setState({ agents: agents as never, selectedWorkspaceId: 'ws-1' } as never);
}

beforeEach(() => {
  projection = {
    planId: 'plan-1',
    warnings: [],
    threads: [
      thread(comment({ id: 'c-1', body: 'On the open plan.' }), folderTarget('d-plan'), [
        reply({ id: 'r-1', commentId: 'c-1', body: 'first', createdAt: 1 }),
        reply({ id: 'r-2', commentId: 'c-1', body: 'second', createdAt: 2 }),
      ]),
      thread(comment({ id: 'c-2', body: 'On another doc.' }), folderTarget('d-other', 'other.md')),
      thread(comment({ id: 'c-3', body: 'On a vanished doc.' }), orphanTarget),
    ],
  };
  listMock = vi.fn(async () => projection);
  createMock = vi.fn(async (req: { planId: string; ref: { documentId: string }; body: string }) => {
    projection.threads = [
      ...projection.threads,
      thread(comment({ id: 'c-new', body: req.body }), folderTarget(req.ref.documentId)),
    ];
    return { ok: true as const, comment: comment({ id: 'c-new', body: req.body }), recipientId: 'sup-1', send: null };
  });
  replyMock = vi.fn(async (req: { commentId: string; body: string; callerAgentId: string }) => {
    const t = projection.threads.find((x) => x.comment.id === req.commentId)!;
    t.replies = [...t.replies, reply({ id: 'r-new', commentId: req.commentId, body: req.body, createdAt: 99 })];
    return { ok: true as const, reply: reply({ id: 'r-new', commentId: req.commentId, body: req.body, createdAt: 99 }) };
  });
  (window as unknown as { api: unknown }).api = {
    plans: { listComments: listMock, createComment: createMock, replyComment: replyMock },
  };
  useDashboardStore.setState({ agents: [] as never, selectedWorkspaceId: null } as never);
});

async function render(el: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(el);
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  useDashboardStore.setState({ agents: [] as never, selectedWorkspaceId: null } as never);
  vi.clearAllMocks();
});

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
function type(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('PlanCommentsRail (WP-P4E comments rail)', () => {
  it('shows threads for the OPEN document only, replies in order, and always surfaces orphaned', async () => {
    await render(<PlanCommentsRail planId="plan-1" activeDoc={activeDoc('d-plan')} />);

    const docThreads = qa('plan-comment-thread');
    expect(docThreads).toHaveLength(1); // c-1 (open doc); NOT c-2 (other doc)
    expect(q('plan-comment-question-body')?.textContent).toContain('On the open plan.');

    const replies = qa('plan-comment-reply-body').map((n) => n.textContent);
    expect(replies).toEqual(['first', 'second']);

    // Orphaned surfaced in its own section, and NOT clickable (no button in it).
    const orphSection = q('plan-comment-orphaned-section');
    expect(orphSection).not.toBeNull();
    const orph = q('plan-comment-orphaned');
    expect(orph?.textContent).toContain('On a vanished doc.');
    // With no supervisor, the only buttons are none — assert no open affordance.
    expect(orphSection!.querySelectorAll('button').length).toBe(0);
  });

  it('compose routes create with { planId, ref, body } (no recipient) and refetches', async () => {
    await render(<PlanCommentsRail planId="plan-1" activeDoc={activeDoc('d-plan')} />);
    listMock.mockClear();

    const textarea = q('plan-comment-compose-textarea') as HTMLTextAreaElement;
    type(textarea, 'New comment body');
    await flush();
    await act(async () => {
      (q('plan-comment-compose-submit') as HTMLButtonElement).click();
    });
    await flush();

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0]).toEqual({ planId: 'plan-1', ref: { source: 'folder', documentId: 'd-plan' }, body: 'New comment body' });
    expect(listMock).toHaveBeenCalled(); // refetched
    // The new thread now appears for the open doc.
    expect(document.body.textContent).toContain('New comment body');
  });

  it('surfaces a create rejection', async () => {
    createMock.mockResolvedValueOnce({ ok: false, code: 'document-not-in-plan', error: 'not in plan' });
    await render(<PlanCommentsRail planId="plan-1" activeDoc={activeDoc('d-plan')} />);

    type(q('plan-comment-compose-textarea') as HTMLTextAreaElement, 'x');
    await flush();
    await act(async () => {
      (q('plan-comment-compose-submit') as HTMLButtonElement).click();
    });
    await flush();

    expect(q('plan-comment-compose-error')?.textContent).toContain('not in plan');
  });

  it('reply is gated to supervisors — none present ⇒ no reply control', async () => {
    await render(<PlanCommentsRail planId="plan-1" activeDoc={activeDoc('d-plan')} />);
    expect(q('plan-comment-reply-open')).toBeNull();
  });

  it('a supervisor posts a reply with the chosen caller, then refetches', async () => {
    seedSupervisors(1);
    await render(<PlanCommentsRail planId="plan-1" activeDoc={activeDoc('d-plan')} />);

    await act(async () => {
      (q('plan-comment-reply-open') as HTMLButtonElement).click();
    });
    await flush();
    type(q('plan-comment-reply-textarea') as HTMLTextAreaElement, 'my answer');
    await flush();
    await act(async () => {
      (q('plan-comment-reply-submit') as HTMLButtonElement).click();
    });
    await flush();

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0][0]).toEqual({ commentId: 'c-1', body: 'my answer', callerAgentId: 'sup-1' });
    expect(document.body.textContent).toContain('my answer');
  });

  it('a reply rejection keeps the form open and surfaces the reason', async () => {
    seedSupervisors(1);
    replyMock.mockResolvedValueOnce({ ok: false, code: 'not-responsible-supervisor', error: 'not responsible' });
    await render(<PlanCommentsRail planId="plan-1" activeDoc={activeDoc('d-plan')} />);

    await act(async () => {
      (q('plan-comment-reply-open') as HTMLButtonElement).click();
    });
    await flush();
    type(q('plan-comment-reply-textarea') as HTMLTextAreaElement, 'answer');
    await flush();
    await act(async () => {
      (q('plan-comment-reply-submit') as HTMLButtonElement).click();
    });
    await flush();

    expect(q('plan-comment-reply-error')?.textContent).toContain('not responsible');
    expect(q('plan-comment-reply-form')).not.toBeNull(); // stays open
  });

  it('with no open document: shows the hint, no compose, but still surfaces orphaned', async () => {
    await render(<PlanCommentsRail planId="plan-1" activeDoc={null} />);
    expect(q('plan-comments-no-doc')).not.toBeNull();
    expect(q('plan-comment-compose')).toBeNull();
    expect(q('plan-comment-orphaned-section')).not.toBeNull();
  });

  it('a preload without listComments degrades to empty (no throw)', async () => {
    (window as unknown as { api: unknown }).api = { plans: {} };
    await render(<PlanCommentsRail planId="plan-1" activeDoc={activeDoc('d-plan')} />);
    expect(q('plan-comments-rail')).not.toBeNull();
    expect(q('plan-comment-thread')).toBeNull();
    expect(q('plan-comments-empty')).not.toBeNull();
  });
});
