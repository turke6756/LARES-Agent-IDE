import { AgentStatus, FileOperation } from '../../shared/types';
import { stripAnsi } from './strip-ansi';

// BUG-20: Last output preview is sourced from the agent's actual last
// assistant chat message rather than the PTY frame tail. These caps keep
// long turns from drowning the supervisor's event context.
const CHAT_PREVIEW_MAX_LINES = 10;
const CHAT_PREVIEW_MAX_CHARS = 800;
// Turn-end events (working → idle) carry the worker's FULL last assistant
// message instead of the 10-line/800-char preview: that message is the
// worker's hand-off to the supervisor (workers are instructed to end turns
// with their question/decision in plain text), and head-truncating it cut
// off exactly the part the supervisor needed. The safety ceiling exists only
// so a runaway essay can't flood the supervisor's prompt buffer; when it
// trips, head AND tail are both preserved (the ask lives at the end).
const CHAT_FULL_MAX_CHARS = 6000;
const CHAT_FULL_HEAD_CHARS = 2500;
const CHAT_FULL_TAIL_CHARS = 3000;
const FILES_TOUCHED_MAX_ENTRIES = 10;
const CONSOLIDATED_HINT_MAX_CHARS = 80;

// Team events are not currently emitted. If Teams reintroduces them, restore
// the type tag (e.g. 'team_created' | 'team_loop_detected') and the matching
// payload branches in buildEventPayload.
//
// Waiting-for-input (P2-03) is intentionally NOT a new type tag — it rides on
// `status_change` with `toStatus === 'waiting'` plus `waitingKind` /
// `waitingExcerpt` per §2.3.3.
export interface SupervisorEvent {
  type: 'status_change' | 'context_threshold' | 'tmux_new_session_failed'
    | 'handoff_failed' | 'worker_stalled' | 'transient_subscription_expired';
  agentId: string;
  agentTitle: string;
  workspaceId: string;
  fromStatus?: AgentStatus;
  toStatus?: AgentStatus;
  lastExitCode?: number | null;
  contextPercentage?: number;
  contextWindowMax?: number;
  totalContextTokens?: number;
  turnCount?: number;
  model?: string;
  logTail?: string;
  /** BUG-22 Step 1 diagnostic — fields used by `tmux_new_session_failed`
   *  events so the supervisor sees the failed tmux session name, the rendered
   *  inner command, and tmux's exit code / stderr in the event message. */
  tmuxSessionName?: string;
  /** The fully-rendered inner shell command that was passed to
   *  `tmuxNewSession` (the body the pane would have run). Useful when
   *  discriminating between quoting bugs and venv-activation failures. */
  command?: string;
  tmuxExitCode?: number | null;
  tmuxStderr?: string;
  /** The outer `tmux new-session ...` command that was handed to wslExec. */
  tmuxCommand?: string;
  /** BUG-20: agent's last clean assistant chat message text (post `\n`-joined
   *  assistant-text events for the most recent turn). When present, the
   *  `Last output:` block prefers this over the PTY-frame logTail, which on
   *  Claude Code workers reliably slices TUI footer chrome (status bar,
   *  permission ribbon, hook spinner) instead of the real assistant prose. */
  lastAssistantMessage?: string;
  /** BUG-20: file activities the agent has produced recently (db rows from
   *  `getFileActivities`, sorted newest-first). Rendered as a "Files touched:"
   *  block after "Last output:". Section is omitted when empty/undefined. */
  filesTouched?: Array<{ filePath: string; operation: FileOperation }>;
  /** P2-03: populated when `toStatus === 'waiting'`. Kind is shared with the
   *  StatusMonitor's `WaitingKind` union (question / y-n / enter / choice /
   *  approve / tty-pattern / notification). `notification` is the hook-driven
   *  wait sourced from the Claude Notification hook (e.g. AskUserQuestion /
   *  permission prompt). */
  waitingKind?: 'question' | 'y-n' | 'enter' | 'choice' | 'approve' | 'tty-pattern' | 'notification';
  waitingExcerpt?: string;
  /** Handoff handshake — `handoff_failed` fields. The synchronous
   *  confirm-and-retry exhausted its re-press attempts without ever seeing a
   *  UserPromptSubmit hook: the prompt was typed but the worker turn never
   *  started. Delivered even for fire-and-forget send paths so the supervisor
   *  is woken instead of waiting forever for a Stop hook that can't come. */
  handoffAttempts?: number;
  failureMessage?: string;
  /** Stalled-worker watchdog — `worker_stalled` fields. How long the agent
   *  has been in `working` with zero signal (no PTY output, no hook event). */
  stalledForMs?: number;
  /** Transient subscription — set on a status event delivered to a transient
   *  subscriber so the render frames it as a reply to *their* message, not an
   *  owned agent's lifecycle event. */
  viaSubscription?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

function formatLogTail(logTail: string | undefined, maxLines: number): string {
  if (!logTail?.trim()) return '';
  // BUG-13 Path B Change 2: strip ANSI escapes and control bytes per line
  // before prefixing with `> `. Raw PTY output (e.g. Claude Code's grey
  // suggestion text rendered as `\x1b[s\x1b[2m❯ commit this\x1b[u`) would
  // otherwise leak escape sequences AND a phantom `❯ ` line into the
  // supervisor's `Last output:` field, where it reads as if the user typed
  // it. Drop lines that are pure whitespace after stripping so cursor-
  // restore-only sequences don't leave blank `>` rows.
  const cleaned = logTail
    .split('\n')
    .map(stripAnsi)
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim().length > 0);
  if (cleaned.length === 0) return '';
  const lines = cleaned.slice(-maxLines);
  return '\nLast output:\n' + lines.map(l => `> ${l}`).join('\n');
}

/** BUG-20: render the "Last output:" block from the agent's clean last
 *  assistant message. Truncates to CHAT_PREVIEW_MAX_LINES /
 *  CHAT_PREVIEW_MAX_CHARS so essay-length turns don't drown the event.
 *  Returns '' when there is no usable content so the caller can fall back. */
function formatChatPreview(message: string | undefined): string {
  if (!message) return '';
  const trimmed = message.replace(/\s+$/, '');
  if (trimmed.length === 0) return '';
  let lines = trimmed.split('\n');
  let truncated = false;
  if (lines.length > CHAT_PREVIEW_MAX_LINES) {
    lines = lines.slice(0, CHAT_PREVIEW_MAX_LINES);
    truncated = true;
  }
  let body = lines.join('\n');
  if (body.length > CHAT_PREVIEW_MAX_CHARS) {
    body = body.slice(0, CHAT_PREVIEW_MAX_CHARS);
    truncated = true;
  }
  const rendered = body.split('\n').map(l => `> ${l}`).join('\n');
  return '\nLast output:\n' + rendered + (truncated ? '\n> …' : '');
}

/** Turn-end (working → idle) rendering: the full last assistant message from
 *  the parsed chat log, `> `-prefixed. Only past CHAT_FULL_MAX_CHARS does it
 *  truncate, and then from the MIDDLE — the headline (head) and the worker's
 *  closing question/ask (tail) both survive. Returns '' when there is no
 *  usable content so the caller can fall back to the PTY tail. */
function formatChatFull(message: string | undefined): string {
  if (!message) return '';
  const trimmed = message.replace(/\s+$/, '');
  if (trimmed.length === 0) return '';
  let body = trimmed;
  if (body.length > CHAT_FULL_MAX_CHARS) {
    const omitted = body.length - CHAT_FULL_HEAD_CHARS - CHAT_FULL_TAIL_CHARS;
    body = body.slice(0, CHAT_FULL_HEAD_CHARS)
      + `\n… [${omitted} chars omitted] …\n`
      + body.slice(body.length - CHAT_FULL_TAIL_CHARS);
  }
  const rendered = body.split('\n').map(l => `> ${l}`).join('\n');
  return '\nLast output:\n' + rendered;
}

/** BUG-20: render the "Files touched:" block. Section is omitted when the
 *  array is empty/undefined so events for read-only / chat-only turns
 *  stay compact. */
function formatFilesTouched(
  files: SupervisorEvent['filesTouched'],
): string {
  if (!files || files.length === 0) return '';
  const shown = files.slice(0, FILES_TOUCHED_MAX_ENTRIES);
  const lines = shown.map(f => `> ${f.filePath} (${f.operation})`);
  const overflow = files.length > FILES_TOUCHED_MAX_ENTRIES
    ? `\n> … (${files.length - FILES_TOUCHED_MAX_ENTRIES} more)`
    : '';
  return '\nFiles touched:\n' + lines.join('\n') + overflow;
}

/** BUG-20: single-line, char-capped hint used in the consolidated digest. */
function consolidatedHint(message: string | undefined): string {
  if (!message) return '';
  const firstLine = message.split('\n').find(l => l.trim().length > 0);
  if (!firstLine) return '';
  const trimmed = firstLine.trim();
  if (trimmed.length <= CONSOLIDATED_HINT_MAX_CHARS) return trimmed;
  return trimmed.slice(0, CONSOLIDATED_HINT_MAX_CHARS - 1) + '…';
}

function formatContext(event: SupervisorEvent): string {
  if (event.contextPercentage == null) return '';
  const tokens = event.totalContextTokens != null && event.contextWindowMax != null
    ? ` (${formatTokens(event.totalContextTokens)}/${formatTokens(event.contextWindowMax)} tokens`
      + (event.turnCount != null ? `, ${event.turnCount} turns)` : ')')
    : '';
  return `\nContext: ${event.contextPercentage}%${tokens}`;
}

export function buildEventPayload(event: SupervisorEvent): string {
  const agentLine = `Agent: "${event.agentTitle}" (${event.agentId.slice(0, 8)})`;

  if (event.type === 'status_change') {
    // Transient-subscription framing: when this status event is delivered to a
    // transient subscriber (viaSubscription), the header reads as a reply to
    // *their* message rather than an owned agent's lifecycle event. We do NOT
    // assert "still busy" — the TTL handler renders that separately.
    const header = event.viaSubscription
      ? `[DASHBOARD EVENT] Reply to your message to "${event.agentTitle}" — its turn ended (one-turn subscription now expired)`
      : '[DASHBOARD EVENT] Agent status changed';

    // P2-03: dedicated "waiting for input" rendering when an agent flips to
    // 'waiting'. We hand the supervisor the kind + excerpt so it can decide
    // how to reply (send_message_to_agent for text, send_keys_to_agent for
    // arrow-key pickers).
    if (event.toStatus === 'waiting') {
      const kindLine = event.waitingKind
        ? `Waiting kind: ${event.waitingKind}`
        : 'Waiting kind: unknown';
      const excerptLine = event.waitingExcerpt
        ? `Excerpt: ${JSON.stringify(event.waitingExcerpt)}`
        : '';
      return [
        '[DASHBOARD EVENT] Agent waiting for input'
          + (event.viaSubscription ? ' (reply to your message; subscription still open)' : ''),
        agentLine,
        kindLine,
        excerptLine,
        formatLogTail(event.logTail, 5),
      ].filter(Boolean).join('\n');
    }

    const statusLine = event.fromStatus && event.toStatus
      ? `Status: ${event.fromStatus} → ${event.toStatus}`
      : `Status: ${event.toStatus || 'unknown'}`;
    const exitLine = event.toStatus === 'crashed' && event.lastExitCode != null
      ? `\nExit code: ${event.lastExitCode}`
      : '';

    // BUG-20: prefer the clean chat-source preview when we have one; fall
    // back to the PTY-frame tail otherwise (early bootstrap / providers
    // without parsed chat / chat-service failure path).
    //
    // working → idle is the turn-end hand-off: render the worker's full last
    // assistant message (it ends with the question/decision the supervisor
    // must act on). Every other transition (done, crashed, waiting → idle)
    // keeps the compact 10-line/800-char preview.
    const isTurnEnd = event.fromStatus === 'working' && event.toStatus === 'idle';
    const chatPreview = isTurnEnd
      ? formatChatFull(event.lastAssistantMessage)
      : formatChatPreview(event.lastAssistantMessage);
    const outputBlock = chatPreview || formatLogTail(event.logTail, 5);

    return [
      header,
      agentLine,
      statusLine + exitLine,
      formatContext(event),
      outputBlock,
      formatFilesTouched(event.filesTouched),
    ].filter(Boolean).join('\n');
  }

  if (event.type === 'context_threshold') {
    // Advisory framing, deliberately. The old wording ("compact this agent")
    // read as a command and, fired at 80/90/95, trained supervisors to
    // interrupt healthy near-complete work. 100% context is a COST boundary,
    // not a model cliff — nothing breaks there and no handoff is mandatory.
    return [
      '[DASHBOARD EVENT] Context threshold crossed',
      agentLine,
      formatContext(event),
      `Threshold: ${event.contextPercentage}% — ADVISORY, not a deadline.`,
      '100% is not a literal cutoff: nothing breaks when an agent fills its window, '
        + 'and no handoff is strictly required. This is about cost and efficiency — '
        + 'a bloated context makes every remaining turn more expensive.',
      'Prefer a continuation handoff when the agent is idle or between tasks: read its '
        + 'log, launch a successor via launch_agent carrying the compacted context '
        + '(accomplished / current state / next), then stop_agent the old one.',
      'If it is mid-task and genuinely close to finishing, LET IT FINISH — tearing down '
        + 'near-complete work costs more than the context does. Hand off after.',
    ].filter(Boolean).join('\n');
  }

  if (event.type === 'tmux_new_session_failed') {
    // BUG-22 Step 1 diagnostic. Render a distinct header so the supervisor
    // can tell the tmux-creation failure apart from a generic `Agent status
    // changed` event — the runner-exit crash that usually follows produces
    // the latter, but the structural cause is upstream and visible here.
    const stderrText = event.tmuxStderr && event.tmuxStderr.length > 0
      ? event.tmuxStderr
      : '(empty)';
    const exitLine = event.tmuxExitCode != null
      ? `tmux exit code: ${event.tmuxExitCode}`
      : 'tmux exit code: (unknown)';
    return [
      '[DASHBOARD EVENT] WSL tmux session creation failed',
      agentLine,
      event.tmuxSessionName ? `tmux session: ${event.tmuxSessionName}` : '',
      exitLine,
      `stderr:\n${stderrText}`,
      event.command ? `command:\n${event.command}` : '',
    ].filter(Boolean).join('\n');
  }

  if (event.type === 'handoff_failed') {
    // Handoff handshake — the send path delivered the prompt but the worker
    // turn never started (no UserPromptSubmit hook after every re-press).
    // Distinct header + explicit "do not wait for a Stop hook" framing: the
    // usual idle event will never arrive for this turn, so the supervisor
    // must act now instead of sleeping.
    return [
      '[DASHBOARD EVENT] Worker handoff FAILED — prompt delivered but turn never started',
      agentLine,
      event.handoffAttempts != null
        ? `Submit re-pressed ${event.handoffAttempts}x with no UserPromptSubmit hook.`
        : '',
      event.failureMessage ? `Detail: ${event.failureMessage}` : '',
      'The worker is NOT working and will never emit a Stop-hook idle event for this prompt.',
      'Recommended: read_agent_log to see the PTY; if the prompt sits unsubmitted, '
        + 'send_keys_to_agent {key: "enter"}; if the agent is dead or hook-broken, relaunch it.',
      formatLogTail(event.logTail, 5),
    ].filter(Boolean).join('\n');
  }

  if (event.type === 'worker_stalled') {
    const mins = event.stalledForMs != null
      ? Math.round(event.stalledForMs / 60000)
      : null;
    return [
      '[DASHBOARD EVENT] Worker appears stalled',
      agentLine,
      mins != null
        ? `Status has been 'working' with zero signal (no PTY output, no hook event) for ~${mins} min.`
        : `Status has been 'working' with zero signal (no PTY output, no hook event).`,
      'A live turn keeps the PTY streaming, so this silence likely means a hung tool, a dead '
        + 'process, or a submit that never took.',
      'Recommended: read_agent_log to inspect; send_keys_to_agent {key: "enter"} if a prompt sits '
        + 'unsubmitted; stop/relaunch if the process is dead.',
      formatLogTail(event.logTail, 5),
    ].filter(Boolean).join('\n');
  }

  if (event.type === 'transient_subscription_expired') {
    // Wording avoids asserting the target is "still busy" — at TTL fire we do
    // not read live status, only that no terminal event closed the window.
    return [
      `[DASHBOARD EVENT] Your one-turn subscription to "${event.agentTitle}" (${event.agentId.slice(0, 8)}) expired`,
      'No terminal event was delivered before the subscription window closed.',
      'Re-check it (read_agent_chat / read_agent_log) or re-message to open a fresh one-turn subscription.',
    ].join('\n');
  }

  // Defensive fallback — still name the sending agent so the supervisor can
  // attribute even a malformed/unknown event to its source.
  return [
    `[DASHBOARD EVENT] Unknown event type: ${(event as { type: string }).type}`,
    agentLine,
  ].join('\n');
}

export function buildConsolidatedPayload(events: SupervisorEvent[]): string {
  if (events.length === 1) return buildEventPayload(events[0]);

  const lines = [`[DASHBOARD EVENT] ${events.length} events occurred while you were busy:\n`];
  for (const event of events) {
    const title = `"${event.agentTitle}" (${event.agentId.slice(0, 8)})`;
    if (event.type === 'status_change') {
      if (event.toStatus === 'waiting') {
        const kind = event.waitingKind ?? 'unknown';
        lines.push(`- ${title}: waiting for input (${kind})`);
      } else {
        // BUG-20: append a single-line preview of the agent's last assistant
        // message when present so the supervisor can triage from the digest
        // line alone for the common cases.
        const hint = consolidatedHint(event.lastAssistantMessage);
        const suffix = hint ? ` — "${hint}"` : '';
        const replyTag = event.viaSubscription ? ' (reply to you)' : '';
        lines.push(`- ${title}: ${event.fromStatus} → ${event.toStatus}${replyTag}${suffix}`);
      }
    } else if (event.type === 'context_threshold') {
      lines.push(`- ${title}: context at ${event.contextPercentage}%`);
    } else if (event.type === 'tmux_new_session_failed') {
      lines.push(`- ${title}: WSL tmux session creation failed`);
    } else if (event.type === 'handoff_failed') {
      lines.push(`- ${title}: handoff FAILED — prompt delivered but turn never started`);
    } else if (event.type === 'worker_stalled') {
      const mins = event.stalledForMs != null ? Math.round(event.stalledForMs / 60000) : '?';
      lines.push(`- ${title}: stalled — working ~${mins} min with zero output/hook signal`);
    } else if (event.type === 'transient_subscription_expired') {
      lines.push(`- ${title}: one-turn subscription expired`);
    }
  }
  lines.push('\nUse list_agents and read_agent_log to assess each agent.');
  return lines.join('\n');
}
