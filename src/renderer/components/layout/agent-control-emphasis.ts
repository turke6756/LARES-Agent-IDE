import type { AgentStatus } from '../../../shared/types';

/** Controls that deserve attention in the detail-pane action row. */
export function restartNeedsAttention(status: AgentStatus, pending: boolean): boolean {
  return !pending && (status === 'done' || status === 'crashed');
}

export function stopNeedsAttention(status: AgentStatus, pending: boolean): boolean {
  return !pending && (status === 'working' || status === 'idle');
}
