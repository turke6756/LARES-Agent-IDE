import type { AgentStatus } from '../../shared/types';

export type StatusChangeSource =
  | 'monitor'
  | 'runner-exit'
  | 'launch'
  | 'restart'
  | 'restart-failed'
  | 'stop';

/** Mirror of `StatusMonitor.WaitingKind`. Re-declared here to keep this leaf
 *  module free of importing the monitor (which pulls in the database). */
export type WaitingKindTag = 'question' | 'y-n' | 'enter' | 'choice' | 'approve' | 'tty-pattern';

export interface StatusChangedEvent {
  agentId: string;
  status: AgentStatus;
  fromStatus?: AgentStatus;
  source: StatusChangeSource;
  /** P2-03: populated when `status === 'waiting'` so the bridge can pass it
   *  to the payload builder without re-reading the latch. */
  waitingKind?: WaitingKindTag;
  waitingExcerpt?: string;
}
