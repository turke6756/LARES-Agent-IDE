import type { AgentStatus } from '../../shared/types';

export type StatusChangeSource =
  | 'monitor'
  | 'runner-exit'
  | 'launch'
  | 'restart'
  | 'restart-failed'
  | 'stop';

export interface StatusChangedEvent {
  agentId: string;
  status: AgentStatus;
  fromStatus?: AgentStatus;
  source: StatusChangeSource;
}
