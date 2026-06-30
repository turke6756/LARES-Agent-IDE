import React from 'react';
import type { Agent, ContextStats } from '../../../shared/types';

// Shared, presentational subexpressions lifted out of AgentCard so the
// horizontal OwnerContainerBar can reuse them verbatim instead of duplicating
// (plan §2.3). These are pure render helpers — no store access, no side effects.

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Role chip (Supervisor / Researcher / Worker) + the orthogonal Supervised and
// Elevated (supervisor privilege lane) badges. The caller owns the surrounding
// flex row and the leading #id span — this renders only the chip cluster.
export function RoleChips({ agent }: { agent: Agent }) {
  return (
    <>
      {agent.isSupervisor ? (
        <span className="text-[11px] text-amber-400 bg-amber-500/15 px-1.5 py-0.5 font-semibold truncate" title="Supervisor — watches workers and routes questions to the human">Supervisor</span>
      ) : agent.isResearcher ? (
        <span className="text-[11px] text-teal-400 bg-teal-500/15 px-1.5 py-0.5 font-semibold truncate" title="Researcher — browses and researches the web in an app-managed sandbox; never edits code">Researcher</span>
      ) : agent.isWorker ? (
        <span className="text-[11px] text-sky-400 bg-sky-500/15 px-1.5 py-0.5 font-semibold truncate" title="Worker — status derived from turn-boundary hooks">Worker</span>
      ) : null}
      {agent.isSupervised && !agent.isSupervisor && (
        <span className="text-[11px] text-purple-400 bg-purple-500/15 px-1.5 py-0.5 font-semibold truncate" title="A supervisor watches this agent's status and routes its questions to the human">Supervised</span>
      )}
      {agent.privilegeLane === 'supervisor' && !agent.isSupervisor && (
        <span className="text-[11px] text-amber-400/80 bg-amber-500/10 px-1.5 py-0.5 font-semibold truncate" title="Elevated — granted the supervisor-tier MCP toolset (orchestration, teams, comms, observability), but renders as its own persona card">Elevated</span>
      )}
    </>
  );
}

// Context-usage bar: token counts, a colored fill scaled to context %, model id
// and percentage. `className` overrides the wrapper spacing so the vertical card
// and the horizontal owner bar can each place it appropriately.
export function ContextStatsBar({ cs, className = 'mb-2' }: { cs: ContextStats; className?: string }) {
  const pct = cs.contextPercentage;
  const isWarning = pct > 60;
  const isCritical = pct > 85;
  const barColor = isCritical ? 'bg-accent-red' : isWarning ? 'bg-accent-orange' : 'bg-accent-blue';
  const textColor = isCritical ? 'text-accent-red' : isWarning ? 'text-accent-orange' : 'text-accent-blue';
  return (
    <div className={className}>
      <div className="flex items-center justify-between text-[11px] text-gray-400 mb-1">
        <span className={`${textColor} ${isCritical ? 'font-bold' : 'font-medium'}`}>
          {isCritical ? '!! ' : ''}Ctx {formatTokenCount(cs.totalContextTokens)}/{formatTokenCount(cs.contextWindowMax)}
        </span>
        <span>Turns: {cs.turnCount} Out: {formatTokenCount(cs.totalOutputTokens)}</span>
      </div>
      <div className="relative w-full h-[4px] bg-surface-3 overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-500 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between mt-0.5">
        <span className="text-[11px] text-gray-500 truncate">{cs.model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>
        <span className={`text-[11px] ${textColor} font-semibold`}>{pct}%</span>
      </div>
    </div>
  );
}
