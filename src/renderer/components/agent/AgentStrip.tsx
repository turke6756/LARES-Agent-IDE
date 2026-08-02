import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDashboardStore } from '../../stores/dashboard-store';
import { isActivePhase } from './continuation-phase-view';
import type { Agent, AgentProvider, AgentStatus } from '../../../shared/types';
import {
  buildAgentForest,
  isOwnerContainer,
  collectDescendantAgents,
  type AgentTreeNode,
} from './agent-grouping';
import { applyHorizontalWheelScroll } from '../../lib/horizontal-wheel';

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
  grok: { base: 'bg-purple-500/[0.07]', selected: 'bg-purple-500/[0.16]', hover: 'hover:bg-purple-500/[0.12]' },
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
  // Gold "snake" border while this agent is mid context-brick continuation transfer.
  const transferring = useDashboardStore((s) => isActivePhase(s.continuationPhases[agent.id]?.phase));

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
        transferring ? 'agent-transfer-glow' : ''
      } ${
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
 * A supervisor (owner-container) in the strip: its own mini card plus a caret
 * that opens a dropdown listing every worker/researcher it owns (flattened to
 * any depth). The caret is a sibling — MiniAgentCard is a <button>, so the
 * dropdown toggle can't nest inside it. The dropdown is portalled to <body> and
 * fixed-positioned so it escapes the strip's `overflow` clipping.
 */
function SupervisorCard({
  node,
  expanded,
  onSelect,
}: {
  node: AgentTreeNode;
  expanded: boolean;
  onSelect: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const owned = collectDescendantAgents(node);

  // Anchor the dropdown under the caret. Right-align its edge with the caret so
  // it never spills off the right of the narrow detail panel; clamp to the
  // viewport left edge just in case.
  const reposition = () => {
    const el = caretRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = 224; // w-56
    setPos({ top: r.bottom + 4, left: Math.max(8, r.right - width), width });
  };

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScrollOrResize = () => reposition();
    window.addEventListener('resize', onScrollOrResize);
    // Capture-phase scroll: any ancestor scrolling should keep the panel pinned.
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || caretRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleChildSelect = (agentId: string) => {
    setOpen(false);
    onSelect(agentId);
  };

  return (
    <div className={`relative flex items-stretch ${expanded ? 'w-full' : 'w-[108px] shrink-0'}`}>
      <div className="min-w-0 flex-1">
        <MiniAgentCard agent={node.agent} expanded onSelect={onSelect} />
      </div>
      <button
        ref={caretRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${owned.length} owned agent${owned.length === 1 ? '' : 's'}`}
        className={`shrink-0 flex flex-col items-center justify-center px-1 border border-l-0 border-surface-3 text-[9px] transition-colors ${
          open ? 'bg-accent-blue/20 text-accent-blue' : 'text-gray-400 hover:text-gray-100 hover:bg-surface-3/60'
        }`}
      >
        <span className="text-[9px] leading-none tabular-nums">{owned.length}</span>
        <span className={`leading-none transition-transform duration-150 ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && pos &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            className="fixed z-50 max-h-[50vh] overflow-y-auto scrollbar-thin border border-surface-3 bg-surface-1 shadow-lg p-1 flex flex-col gap-1"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            <div className="px-1 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 truncate">
              Under {node.agent.title}
            </div>
            {owned.length === 0 ? (
              <div className="px-1 py-1 text-[11px] text-gray-500 italic">No owned agents</div>
            ) : (
              owned.map((child) => (
                <MiniAgentCard key={child.id} agent={child} expanded onSelect={handleChildSelect} />
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * Compressed view of the dashboard agents for the detail panel. Supervisors
 * (owner-containers) are listed FIRST — each as a card with a dropdown caret
 * that reveals the workers/researchers it owns — then lone workers/researchers
 * follow. Expandable from a horizontally-scrolling row into a 2-column grid for
 * quick agent switching without leaving the file view.
 */
export default function AgentStrip({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const agents = useDashboardStore((s) => s.agents);
  const selectedAgentId = useDashboardStore((s) => s.selectedAgentId);
  const selectAgent = useDashboardStore((s) => s.selectAgent);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Bucket the flat list into an owner→children forest, then split supervisors
  // (owner-containers) from lone agents so the strip can render supervisors
  // first with their per-supervisor dropdowns.
  const forest = React.useMemo(() => buildAgentForest(agents), [agents]);
  const supervisors = React.useMemo(() => forest.filter(isOwnerContainer), [forest]);
  const loners = React.useMemo(() => forest.filter((n) => !isOwnerContainer(n)), [forest]);

  // Keep the selected agent's card in view when selection changes elsewhere.
  // Only top-level cards carry `data-agent-id` in the strip; a worker selected
  // from inside a dropdown lives under its supervisor and simply won't scroll —
  // acceptable, the supervisor card is already visible.
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

  const cards = (
    <>
      {supervisors.map((node) => (
        <SupervisorCard key={node.agent.id} node={node} expanded={expanded} onSelect={handleSelect} />
      ))}
      {loners.map((node) => (
        <MiniAgentCard key={node.agent.id} agent={node.agent} expanded={expanded} onSelect={handleSelect} />
      ))}
    </>
  );

  return (
    <div className="flex items-start gap-1 min-w-0">
      {expanded ? (
        <div className="flex-1 grid grid-cols-2 gap-1.5 max-h-[40vh] overflow-y-auto scrollbar-thin min-w-0">
          {cards}
        </div>
      ) : (
        <div
          ref={scrollRef}
          onWheel={(e) => applyHorizontalWheelScroll(e.currentTarget, e)}
          className="flex-1 flex gap-1.5 overflow-x-auto scrollbar-thin pb-0.5 min-w-0"
        >
          {cards}
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
