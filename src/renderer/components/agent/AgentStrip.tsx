import React, { useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { Agent, AgentProvider, AgentStatus } from '../../../shared/types';

// Mirrors StatusBadge's STATUS_CONFIG dot colors so the strip and the
// full-size cards never disagree about what a status looks like.
const DOT_COLORS: Record<AgentStatus, { bg: string; pulse: boolean }> = {
  launching: { bg: 'bg-accent-yellow', pulse: true },
  working: { bg: 'bg-accent-green', pulse: true },
  receiving: { bg: 'bg-accent-purple', pulse: true },
  idle: { bg: 'bg-accent-blue', pulse: false },
  waiting: { bg: 'bg-accent-orange', pulse: true },
  done: { bg: 'bg-gray-500', pulse: false },
  crashed: { bg: 'bg-accent-red', pulse: false },
  restarting: { bg: 'bg-accent-yellow', pulse: true },
};

// Subtle provider tint, hues from PROVIDER_META (claude amber, codex green, gemini blue).
const PROVIDER_TINT: Record<AgentProvider, { base: string; selected: string; hover: string }> = {
  claude: { base: 'bg-amber-500/[0.07]', selected: 'bg-amber-500/[0.16]', hover: 'hover:bg-amber-500/[0.12]' },
  gemini: { base: 'bg-blue-500/[0.07]', selected: 'bg-blue-500/[0.16]', hover: 'hover:bg-blue-500/[0.12]' },
  codex: { base: 'bg-green-500/[0.07]', selected: 'bg-green-500/[0.16]', hover: 'hover:bg-green-500/[0.12]' },
};

// Same left-border status colors as AgentCard.
const BORDER_COLORS: Record<string, string> = {
  working: 'border-l-accent-green',
  idle: 'border-l-accent-blue',
  waiting: 'border-l-accent-orange',
  crashed: 'border-l-accent-red',
  launching: 'border-l-accent-yellow',
  restarting: 'border-l-accent-yellow',
  done: 'border-l-gray-600',
  receiving: 'border-l-accent-purple',
};

function MiniAgentCard({
  agent,
  expanded,
  onSelect,
}: {
  agent: Agent;
  expanded: boolean;
  onSelect: (agentId: string) => void;
}) {
  // Subscribe only to this agent's slices — sibling updates don't re-render.
  const isSelected = useDashboardStore((s) => s.selectedAgentId === agent.id);
  const pct = useDashboardStore((s) => s.contextStats[agent.id]?.contextPercentage ?? null);

  const dot = DOT_COLORS[agent.status] || DOT_COLORS.done;
  const tint = PROVIDER_TINT[agent.provider || 'claude'] || PROVIDER_TINT.claude;
  const barColor =
    pct !== null && pct > 85 ? 'bg-accent-red' : pct !== null && pct > 60 ? 'bg-accent-orange' : 'bg-accent-blue';

  return (
    <button
      data-agent-id={agent.id}
      onClick={() => onSelect(agent.id)}
      title={`${agent.title} — ${agent.status}${pct !== null ? ` — ctx ${pct}%` : ''}`}
      className={`shrink-0 text-left px-1.5 py-1 border border-surface-3 border-l-2 transition-colors ${
        expanded ? 'w-full' : 'w-[88px]'
      } ${
        isSelected
          ? `${tint.selected} ${BORDER_COLORS[agent.status] || 'border-l-gray-600'}`
          : `${tint.base} ${tint.hover} border-l-surface-3`
      }`}
    >
      <div className="flex items-center gap-1 min-w-0">
        <span className={`relative flex h-1.5 w-1.5 shrink-0`}>
          {dot.pulse && (
            <span className={`absolute inline-flex h-full w-full rounded-full ${dot.bg} opacity-60 animate-pulse`} />
          )}
          <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${dot.bg}`} />
        </span>
        <span className={`text-[11px] truncate ${isSelected ? 'text-accent-blue font-semibold' : 'text-gray-300'}`}>
          {agent.title}
        </span>
      </div>
      <div className="mt-1 h-[3px] w-full bg-surface-3 overflow-hidden">
        {pct !== null && (
          <div className={`h-full ${barColor} transition-all duration-500`} style={{ width: `${Math.min(pct, 100)}%` }} />
        )}
      </div>
    </button>
  );
}

/**
 * Compressed, horizontally scrolling view of the dashboard agents for the
 * detail panel. Same store order as AgentGrid: first grid card = leftmost.
 * Expandable into a 2-column wrapped grid for quick agent switching without
 * leaving file view.
 */
export default function AgentStrip({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const agents = useDashboardStore((s) => s.agents);
  const selectedAgentId = useDashboardStore((s) => s.selectedAgentId);
  const selectAgent = useDashboardStore((s) => s.selectAgent);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the selected agent's card in view when selection changes elsewhere.
  useEffect(() => {
    if (expanded || !selectedAgentId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-agent-id="${CSS.escape(selectedAgentId)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedAgentId, expanded]);

  const handleSelect = (agentId: string) => {
    selectAgent(agentId);
    // You expanded to find someone; once found, give the space back.
    if (expanded && !defaultExpanded) setExpanded(false);
  };

  if (agents.length === 0) {
    return <div className="text-[12px] text-gray-500 italic py-1">No agents running</div>;
  }

  return (
    <div className="flex items-start gap-1 min-w-0">
      {expanded ? (
        <div className="flex-1 grid grid-cols-2 gap-1.5 max-h-[40vh] overflow-y-auto scrollbar-thin min-w-0">
          {agents.map((agent) => (
            <MiniAgentCard key={agent.id} agent={agent} expanded onSelect={handleSelect} />
          ))}
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 flex gap-1.5 overflow-x-auto scrollbar-thin pb-0.5 min-w-0">
          {agents.map((agent) => (
            <MiniAgentCard key={agent.id} agent={agent} expanded={false} onSelect={handleSelect} />
          ))}
        </div>
      )}
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse agent list' : 'Expand agent list'}
        title={expanded ? 'Collapse agent list' : 'Expand agent list'}
        className="ui-btn ui-btn-ghost min-h-0 shrink-0 px-1 py-0.5 text-[11px] text-gray-400"
      >
        {expanded ? '▴' : '▾'}
      </button>
    </div>
  );
}
