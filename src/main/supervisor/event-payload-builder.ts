import { AgentStatus } from '../../shared/types';

// Team events are not currently emitted. If Teams reintroduces them, restore
// the type tag (e.g. 'team_created' | 'team_loop_detected') and the matching
// payload branches in buildEventPayload.
//
// Waiting-for-input (P2-03) is intentionally NOT a new type tag — it rides on
// `status_change` with `toStatus === 'waiting'` plus `waitingKind` /
// `waitingExcerpt` per §2.3.3.
export interface SupervisorEvent {
  type: 'status_change' | 'context_threshold';
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
  /** P2-03: populated when `toStatus === 'waiting'`. Kind is shared with the
   *  StatusMonitor's `WaitingKind` union (question / y-n / enter / choice /
   *  approve / tty-pattern). */
  waitingKind?: 'question' | 'y-n' | 'enter' | 'choice' | 'approve' | 'tty-pattern';
  waitingExcerpt?: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

function formatLogTail(logTail: string | undefined, maxLines: number): string {
  if (!logTail?.trim()) return '';
  const lines = logTail.trim().split('\n').slice(-maxLines);
  return '\nLast output:\n' + lines.map(l => `> ${l}`).join('\n');
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
        '[DASHBOARD EVENT] Agent waiting for input',
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

    return [
      '[DASHBOARD EVENT] Agent status changed',
      agentLine,
      statusLine + exitLine,
      formatContext(event),
      formatLogTail(event.logTail, 5),
    ].filter(Boolean).join('\n');
  }

  if (event.type === 'context_threshold') {
    return [
      '[DASHBOARD EVENT] Context threshold crossed',
      agentLine,
      formatContext(event),
      `Threshold: ${event.contextPercentage}% — compact this agent (read log, launch new agent with summary, stop old agent)`,
    ].filter(Boolean).join('\n');
  }

  return `[DASHBOARD EVENT] Unknown event type: ${(event as { type: string }).type}`;
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
        lines.push(`- ${title}: ${event.fromStatus} → ${event.toStatus}`);
      }
    } else if (event.type === 'context_threshold') {
      lines.push(`- ${title}: context at ${event.contextPercentage}%`);
    }
  }
  lines.push('\nUse list_agents and read_agent_log to assess each agent.');
  return lines.join('\n');
}
