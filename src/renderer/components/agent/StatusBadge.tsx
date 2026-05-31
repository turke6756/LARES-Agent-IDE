import React from 'react';
import type { AgentStatus } from '../../../shared/types';

const STATUS_CONFIG: Record<AgentStatus, { color: string; bg: string; pulse: boolean; label: string }> = {
  launching: { color: 'text-accent-yellow', bg: 'bg-accent-yellow', pulse: true, label: 'Starting' },
  working: { color: 'text-accent-green', bg: 'bg-accent-green', pulse: true, label: 'Working' },
  receiving: { color: 'text-accent-purple', bg: 'bg-accent-purple', pulse: true, label: 'Receiving' },
  idle: { color: 'text-accent-blue', bg: 'bg-accent-blue', pulse: false, label: 'Idle' },
  waiting: { color: 'text-accent-orange', bg: 'bg-accent-orange', pulse: true, label: 'Waiting' },
  done: { color: 'text-gray-400', bg: 'bg-gray-500', pulse: false, label: 'Done' },
  crashed: { color: 'text-accent-red', bg: 'bg-accent-red', pulse: false, label: 'Failed' },
  restarting: { color: 'text-accent-yellow', bg: 'bg-accent-yellow', pulse: true, label: 'Restarting' },
};

export default function StatusBadge({ status }: { status: AgentStatus }) {
  const config = STATUS_CONFIG[status];

  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${config.color}`}>
      <span className="relative flex h-1.5 w-1.5">
        {config.pulse && (
          <span className={`absolute inline-flex h-full w-full rounded-full ${config.bg} opacity-60 animate-pulse`} />
        )}
        <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${config.bg}`} />
      </span>
      {config.label}
    </div>
  );
}
