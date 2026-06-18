// WP-P5-A — main-process `comments:send` orchestration
// (plans/selection-to-agent-primitive-plan.md §1.8, §7 WP-P5-A).
//
// Status machine, written next to the DB:
//   sync gate rejection      → rows untouched (stay `draft`), distinct error
//                              code returned; 'agent-busy' carries the built
//                              prompt so the renderer can run the slice-1
//                              prompt-staging fallback verbatim.
//   gate passed              → rows `queued`, IPC result returns immediately.
//   delivery resolves        → rows `sent` + sent_at.
//   delivery rejects/false   → rows `send_failed` (+ the same
//                              'agent:send-input-error' surface chat sends use).
//
// Existing-agent delivery uses supervisor.sendInput; the busy gate mirrors the
// slice-1 renderer contract (selection-dispatch.ts INPUT_ACCEPTING) so a
// status that would have hit the staging fallback there returns 'agent-busy'
// here. New-agent delivery reuses the WP-P2 launch-with-initialUserPrompt
// pending-map seam — once launchAgent resolves, the prompt is committed to
// that exactly-once machinery (its own failure surface is 'sendInputError'),
// so the rows are marked `sent` at launch resolve.
//
// Dependencies are injected so the machine is testable without electron or
// the better-sqlite3 native binding (see selection-comments-send.test.ts);
// ipc-handlers.ts wires the real supervisor + database.

import type {
  Agent,
  LaunchAgentInput,
  SelectionComment,
  SendSelectionCommentsRequest,
  SendSelectionCommentsResult,
} from '../shared/types';
import { buildQuotedPrompt, type QuoteItem, type QuotedPromptSource } from '../shared/selection-prompt';

// Mirrors INPUT_ACCEPTING in src/renderer/lib/selection/selection-dispatch.ts —
// the statuses where slice 1 sends directly instead of falling back to staging.
export const COMMENT_SEND_ACCEPTING = new Set<string>(['idle', 'waiting', 'done', 'crashed']);

export interface SendSelectionCommentsDeps {
  getComment(id: string): SelectionComment | null;
  getAgent(id: string): Agent | null;
  isInputInFlight(agentId: string): boolean;
  /** supervisor.sendInput — resolves `false` when no runner accepted the input. */
  sendInput(agentId: string, text: string): Promise<boolean>;
  launchAgent(input: LaunchAgentInput): Promise<Agent>;
  markQueued(ids: string[], agentId: string | null): void;
  markSent(ids: string[], agentId: string): void;
  markSendFailed(ids: string[]): void;
  /** Async delivery failure — routed to the 'agent:send-input-error' channel. */
  onAsyncSendError(payload: { agentId: string; error: string }): void;
  /** Rows changed outside an IPC round-trip — routed to 'comments:changed'. */
  onCommentsChanged(commentIds: string[]): void;
}

function buildPromptForRows(rows: SelectionComment[]): string {
  const first = rows[0];
  const source: QuotedPromptSource = {
    targetType: 'file',
    sourceLabel: first.filePath!,
    // `Lines:` is a header-level field (one per prompt), so it only makes
    // sense for a single-comment send; multi-item sends omit it.
    file: rows.length === 1
      ? {
          filePath: first.filePath!,
          lineStart: first.lineStart ?? undefined,
          lineEnd: first.lineEnd ?? undefined,
        }
      : { filePath: first.filePath! },
  };
  // An empty body means "no comment — act on this text directly" (plan §4).
  const items: QuoteItem[] = rows.map((r) => ({
    quote: r.quotedText,
    comment: r.body || undefined,
  }));
  return buildQuotedPrompt(source, items);
}

export async function sendSelectionComments(
  deps: SendSelectionCommentsDeps,
  request: SendSelectionCommentsRequest,
): Promise<SendSelectionCommentsResult> {
  const ids = request?.commentIds;
  if (!Array.isArray(ids) || ids.length === 0 || !request.target) {
    return { ok: false, code: 'invalid-request', error: 'commentIds must be a non-empty array and a target is required' };
  }

  const rows: SelectionComment[] = [];
  for (const id of ids) {
    const row = deps.getComment(id);
    if (!row) return { ok: false, code: 'comment-not-found', error: `Comment not found: ${id}` };
    rows.push(row);
  }
  const first = rows[0];
  if (!first.filePath) {
    return { ok: false, code: 'invalid-request', error: 'Only file-target comments can be sent' };
  }
  for (const r of rows) {
    if (r.workspaceId !== first.workspaceId || r.filePath !== first.filePath) {
      return { ok: false, code: 'invalid-request', error: 'All comments in one send must belong to the same workspace file' };
    }
  }

  const prompt = buildPromptForRows(rows);

  if (request.target.kind === 'existing') {
    const agent = deps.getAgent(request.target.agentId);
    if (!agent) {
      return { ok: false, code: 'agent-not-found', error: `Agent not found: ${request.target.agentId}` };
    }
    // Synchronous status gate — same shape as the 'agent:send-input' IPC gate
    // plus the slice-1 accepting set. Rows stay draft; the renderer maps
    // 'agent-busy' to the prompt-staging fallback.
    if (deps.isInputInFlight(agent.id) || !COMMENT_SEND_ACCEPTING.has(agent.status)) {
      const reported = deps.isInputInFlight(agent.id) ? 'receiving' : agent.status;
      return {
        ok: false,
        code: 'agent-busy',
        error: `Agent is "${reported}" — comments left as draft`,
        prompt,
      };
    }

    deps.markQueued(ids, agent.id);
    // Fire-and-forget past this point (Windows codex/gemini typing can take
    // 30+ seconds — see the 'agent:send-input' handler); transitions land in
    // the DB and surface via onCommentsChanged.
    void deps.sendInput(agent.id, prompt).then(
      (delivered) => {
        if (delivered === false) {
          deps.markSendFailed(ids);
          deps.onAsyncSendError({ agentId: agent.id, error: 'Input delivery failed — no runner accepted the input' });
        } else {
          deps.markSent(ids, agent.id);
        }
        deps.onCommentsChanged(ids);
      },
      (err: unknown) => {
        deps.markSendFailed(ids);
        deps.onAsyncSendError({ agentId: agent.id, error: err instanceof Error ? err.message : String(err) });
        deps.onCommentsChanged(ids);
      },
    );
    return { ok: true, agentId: agent.id, launched: false };
  }

  // New agent: same launch shape as slice-1 selection-dispatch.ts.
  deps.markQueued(ids, null);
  try {
    const agent = await deps.launchAgent({
      workspaceId: first.workspaceId,
      title: 'Selection task',
      provider: 'claude',
      isWorker: true,
      initialUserPrompt: prompt,
    });
    deps.markSent(ids, agent.id);
    deps.onCommentsChanged(ids);
    return { ok: true, agentId: agent.id, launched: true };
  } catch (err: unknown) {
    deps.markSendFailed(ids);
    deps.onCommentsChanged(ids);
    return { ok: false, code: 'launch-failed', error: err instanceof Error ? err.message : String(err) };
  }
}
