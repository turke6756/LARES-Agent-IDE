import React from 'react';
import type { Agent, ContextStats, UsageLimitsReading, UsageWindowReading } from '../../../shared/types';

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

// WP2 (hook-absence-resilience) — compact "HOOKS OFF" pill shown beside the
// operational StatusBadge whenever the status-hook transport is unavailable for
// this agent (hooksUnavailable derived from hook_status = broken/degraded). Hook
// health is ORTHOGONAL to the operational status — this never replaces the
// StatusBadge; it only warns that status is being recovered from the session log
// and may lag. Renders nothing when hooks are healthy/unknown.
export function HooksOffBadge({ agent }: { agent: Agent }) {
  if (!agent.hooksUnavailable) return null;
  const tooltip =
    agent.hooksUnavailableReason === 'instrumentation-unavailable'
      ? "This command couldn't be instrumented for Lares hooks. Status is recovered from the session log and may lag — double-click the card to watch the terminal directly."
      : "Lares received no status hook from this agent (usually Node.js isn't on PATH). Status is recovered from the session log and may lag — double-click the card to watch the terminal directly.";
  return (
    <span
      className="text-[11px] text-amber-400 bg-amber-500/15 px-1.5 py-0.5 font-semibold truncate shrink-0"
      title={tooltip}
    >
      HOOKS OFF
    </span>
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

/** Format a reset countdown (seconds) as `Nh Mm` / `Mm` / `<1m`. */
function formatResetIn(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

/** One compact usage window micro-bar (5h / 7d). Colors mirror ContextStatsBar
 *  (>60 orange, >85 red). A stale window is dimmed and titled with its age. */
function UsageWindowRow({ label, w }: { label: string; w: UsageWindowReading }) {
  const pct = Math.round(w.used_percentage);
  const isWarning = pct > 60;
  const isCritical = pct > 85;
  const barColor = isCritical ? 'bg-accent-red' : isWarning ? 'bg-accent-orange' : 'bg-accent-blue';
  const textColor = isCritical ? 'text-accent-red' : isWarning ? 'text-accent-orange' : 'text-accent-blue';
  const title = w.stale
    ? `${label} usage ${pct}% — stale (captured ${Math.round(w.age_seconds)}s ago)`
    : `${label} usage ${pct}% — resets in ${formatResetIn(w.resets_in_seconds)}`;
  return (
    <div className={`flex items-center gap-1 ${w.stale ? 'opacity-60' : ''}`} title={title}>
      <span className="text-[10px] text-gray-500 w-4 shrink-0">{label}</span>
      <div className="relative w-10 h-[3px] bg-surface-3 overflow-hidden">
        <div className={`h-full ${barColor} transition-all duration-500 ease-out`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className={`text-[10px] ${textColor} font-semibold w-7 shrink-0 text-right`}>{pct}%</span>
    </div>
  );
}

/** Account-wide Claude subscription usage gauge (5h + 7d windows). Renders only
 *  the windows that are known (absent = hidden, never a 0% bar); renders nothing
 *  when no reading is available. See plans/usage-limits-mcp-and-ui.md. */
export function UsageGauge({ usage }: { usage: UsageLimitsReading | null }) {
  if (!usage?.available) return null;
  const fh = usage.five_hour;
  const sd = usage.seven_day;
  if (!fh && !sd) return null;
  return (
    <div className="flex flex-col gap-0.5 shrink-0" title="Claude subscription usage (account-wide)">
      {fh ? <UsageWindowRow label="5h" w={fh} /> : null}
      {sd ? <UsageWindowRow label="7d" w={sd} /> : null}
    </div>
  );
}
