import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  PlanCommentThread,
  PlanCommentsProjection,
  PlanTabDocument,
} from '../../../shared/types';
import { hasSupervisorPrivilege } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';

// WP-P4E — the plan comments rail. It renders question/answer threads rolled up
// by the WP-P4D-proj projection (`plans.listComments`) alongside the tabbed
// document home. Threads associate to the CURRENTLY-OPEN document (per-document
// association from the projection's `target.documentId`); a compose box routes a
// new comment through `plans.createComment` — the renderer supplies only the
// plan, the opaque document ref, and a body, and the SERVER picks the recipient
// (the plan's current responsible supervisor). The rail never selects one.
//
// Orphaned targets — a folder-doc logical key whose document no longer resolves —
// are surfaced in their own section (never dropped, never clickable to a missing
// doc). Comments are first-class at ANY lifecycle stage (Edward's ruling: plans
// stay conversational — hardened is never frozen); the compose box is open to any
// renderer. A reply, however, is a supervisor action: `plans.replyComment` is
// revalidated server-side against the plan's responsible supervisor, so the reply
// affordance is gated to same-workspace privileged agents (mirroring the P4C
// overview editor). The server is the authority — a rejection is a first-class
// outcome, never assumed success.

interface PlanCommentsRailProps {
  planId: string;
  /** The currently-open document (from PlanDocumentTabs). Provides the opaque ref
   *  a new comment is created against and the id threads are scoped to. Null when
   *  no document is open (Packages / empty tab / not-yet-opened). */
  activeDoc: PlanTabDocument | null;
}

/** A reply thread, oldest reply first (the DTO already orders them). */
function ThreadView({
  thread,
  orphaned,
  supervisors,
  onReplied,
}: {
  thread: PlanCommentThread;
  orphaned: boolean;
  supervisors: { id: string; title: string }[];
  onReplied: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [callerId, setCallerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canReply = supervisors.length > 0;

  const openForm = useCallback(() => {
    setDraft('');
    setError(null);
    setCallerId((prev) => (prev && supervisors.some((s) => s.id === prev) ? prev : supervisors[0]?.id ?? ''));
    setOpen(true);
  }, [supervisors]);

  const submit = useCallback(async () => {
    const body = draft.trim();
    if (!body || !callerId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.api.plans.replyComment({ commentId: thread.comment.id, body, callerAgentId: callerId });
      if (res && res.ok) {
        setOpen(false);
        setDraft('');
        onReplied();
      } else {
        setError(res?.error ?? 'Could not post the reply — only the responsible supervisor can answer.');
      }
    } catch {
      setError('Could not post the reply — only the responsible supervisor can answer.');
    } finally {
      setBusy(false);
    }
  }, [draft, callerId, busy, thread.comment.id, onReplied]);

  return (
    <div
      className="border-b border-white/10 px-3 py-2"
      data-testid={orphaned ? 'plan-comment-orphaned' : 'plan-comment-thread'}
      data-target-kind={thread.target.kind}
    >
      {thread.comment.quotedText && (
        <div className="mb-1 border-l-2 border-white/15 pl-2 text-[11px] italic text-gray-500" data-testid="plan-comment-quote">
          {thread.comment.quotedText}
        </div>
      )}
      <div className="prose-custom text-[13px] text-gray-200" data-testid="plan-comment-question-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{thread.comment.body}</ReactMarkdown>
      </div>

      {thread.replies.length > 0 && (
        <div className="mt-1.5 space-y-1.5 border-l border-white/10 pl-2">
          {thread.replies.map((r) => (
            <div key={r.id} className="prose-custom text-[12px] text-gray-300" data-testid="plan-comment-reply">
              <div data-testid="plan-comment-reply-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{r.body}</ReactMarkdown>
              </div>
            </div>
          ))}
        </div>
      )}

      {canReply && !open && (
        <button
          type="button"
          onClick={openForm}
          data-testid="plan-comment-reply-open"
          className="mt-1.5 rounded border border-white/15 px-2 py-0.5 text-[11px] text-gray-400 hover:text-gray-200"
        >
          Reply
        </button>
      )}

      {canReply && open && (
        <div className="mt-1.5" data-testid="plan-comment-reply-form">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Answer as the responsible supervisor…"
            disabled={busy}
            data-testid="plan-comment-reply-textarea"
            className="w-full resize-y rounded border border-white/15 bg-surface-0 px-2 py-1 text-[12px] text-gray-200 outline-none focus:border-accent-blue disabled:opacity-60"
          />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {supervisors.length > 1 && (
              <select
                value={callerId}
                onChange={(e) => setCallerId(e.target.value)}
                disabled={busy}
                data-testid="plan-comment-reply-supervisor-select"
                aria-label="Answering supervisor"
                className="rounded border border-white/15 bg-surface-0 px-1.5 py-1 text-[12px] text-gray-200"
              >
                {supervisors.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !callerId || draft.trim().length === 0}
              data-testid="plan-comment-reply-submit"
              className="rounded bg-accent-blue px-2 py-0.5 text-[12px] font-medium text-white disabled:opacity-60"
            >
              {busy ? 'Posting…' : 'Post reply'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              data-testid="plan-comment-reply-cancel"
              className="rounded px-2 py-0.5 text-[12px] text-gray-400 hover:text-gray-200 disabled:opacity-60"
            >
              Cancel
            </button>
            {error && (
              <span className="text-[12px] text-red-400" data-testid="plan-comment-reply-error" role="alert">
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PlanCommentsRail({ planId, activeDoc }: PlanCommentsRailProps): React.ReactElement {
  const [projection, setProjection] = useState<PlanCommentsProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);

  const agents = useDashboardStore((s) => s.agents);
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const supervisors = useMemo(
    () =>
      agents
        .filter((a) => a.workspaceId === selectedWorkspaceId && hasSupervisorPrivilege(a))
        .map((a) => ({ id: a.id, title: a.title })),
    [agents, selectedWorkspaceId],
  );

  // Fetch (and refetch) the projection. Guarded optional call so a renderer whose
  // preload predates this channel simply shows nothing rather than throwing.
  const refetch = useCallback(() => {
    const call = window.api?.plans?.listComments;
    if (typeof call !== 'function') {
      setProjection(null);
      setLoading(false);
      return () => {};
    }
    let active = true;
    setLoading(true);
    void Promise.resolve(call(planId))
      .then((p) => {
        if (!active) return;
        setProjection(p ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setProjection(null);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [planId]);

  useEffect(() => refetch(), [refetch]);

  const activeDocId = activeDoc?.ref.documentId ?? null;
  const threads = projection?.threads ?? [];

  // Per-document association: live threads whose resolved target is the open doc.
  const docThreads = useMemo(
    () => threads.filter((t) => t.target.kind !== 'orphaned' && t.target.documentId === activeDocId),
    [threads, activeDocId],
  );
  // Orphaned threads have no live document — always surfaced, never clickable.
  const orphanedThreads = useMemo(() => threads.filter((t) => t.target.kind === 'orphaned'), [threads]);

  const submitComment = useCallback(async () => {
    const body = draft.trim();
    if (!body || !activeDoc || posting) return;
    setPosting(true);
    setComposeError(null);
    try {
      const res = await window.api.plans.createComment({ planId, ref: activeDoc.ref, body });
      if (res && res.ok) {
        setDraft('');
        refetch();
      } else {
        setComposeError(res?.error ?? 'Could not post the comment.');
      }
    } catch {
      setComposeError('Could not post the comment.');
    } finally {
      setPosting(false);
    }
  }, [draft, activeDoc, posting, planId, refetch]);

  return (
    <aside
      className="flex w-72 shrink-0 flex-col border-l border-white/10 bg-surface-1/30"
      data-testid="plan-comments-rail"
      aria-label="Plan comments"
    >
      <div className="shrink-0 border-b border-white/10 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">
        Comments
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="px-3 py-3 text-[12px] text-gray-500" data-testid="plan-comments-loading">
            Loading…
          </div>
        ) : (
          <>
            {activeDoc ? (
              docThreads.length > 0 ? (
                <div data-testid="plan-comments-doc-threads">
                  {docThreads.map((t) => (
                    <ThreadView key={t.comment.id} thread={t} orphaned={false} supervisors={supervisors} onReplied={refetch} />
                  ))}
                </div>
              ) : (
                <div className="px-3 py-3 text-[12px] italic text-gray-500" data-testid="plan-comments-empty">
                  No comments on this document yet.
                </div>
              )
            ) : (
              <div className="px-3 py-3 text-[12px] italic text-gray-500" data-testid="plan-comments-no-doc">
                Open a document to comment.
              </div>
            )}

            {orphanedThreads.length > 0 && (
              <div data-testid="plan-comment-orphaned-section">
                <div className="border-b border-t border-amber-500/20 bg-amber-500/5 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-amber-400/80">
                  Orphaned — document no longer resolves
                </div>
                {orphanedThreads.map((t) => (
                  <ThreadView key={t.comment.id} thread={t} orphaned supervisors={supervisors} onReplied={refetch} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Compose — open to any renderer; the server picks the recipient. Only
          enabled when a document is open (a comment needs a document ref). */}
      {activeDoc && (
        <div className="shrink-0 border-t border-white/10 px-3 py-2" data-testid="plan-comment-compose">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder={`Comment on ${activeDoc.name}…`}
            disabled={posting}
            data-testid="plan-comment-compose-textarea"
            className="w-full resize-y rounded border border-white/15 bg-surface-0 px-2 py-1 text-[12px] text-gray-200 outline-none focus:border-accent-blue disabled:opacity-60"
          />
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void submitComment()}
              disabled={posting || draft.trim().length === 0}
              data-testid="plan-comment-compose-submit"
              className="rounded bg-accent-blue px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-60"
            >
              {posting ? 'Posting…' : 'Comment'}
            </button>
            {composeError && (
              <span className="text-[12px] text-red-400" data-testid="plan-comment-compose-error" role="alert">
                {composeError}
              </span>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
