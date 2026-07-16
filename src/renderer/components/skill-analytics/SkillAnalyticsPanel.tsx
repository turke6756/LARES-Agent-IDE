import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3, RefreshCw, AlertTriangle, Gauge, Activity, Loader2, Info, Clock,
  ChevronRight, ChevronDown, Wrench, Layers, X,
} from 'lucide-react';
import type {
  SkillUsageResult, SkillEffectiveness, SkillCostRollup, SkillGroupRow, SkillTimelineRow,
  McpToolUsageResult, McpToolRow, McpToolsetRollup, McpUsageGroupRow, McpToolLaneCell,
  AttributionTier, AttributionCoverageBand, AgentRoleLane,
} from '../../../shared/types';

// Usage Analytics (base plan §P2.3 / master WP3 + wave2 MCP-tool observability +
// skill-usage legibility). Read-only rollups over the WP2 parse foundation. The
// §P2.4 / A8 rule the UI makes visible: EFFECTIVENESS (a two-tier score, only the
// observable tier scored) and COST sit in SEPARATE columns and are NEVER blended.
// MCP tool usage is a first-class counts-only surface fed by its own engine — never
// blended into scored skill surfaces (MCP calls have no window, no score, no cost).

type WindowKey = '24h' | '7d' | '30d' | 'all';
const WINDOWS: { key: WindowKey; label: string; ms: number | null }[] = [
  { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { key: 'all', label: 'All', ms: null },
];

type ViewKey = 'all' | 'skills' | 'mcp' | 'dead';
const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'skills', label: 'Skills' },
  { key: 'mcp', label: 'MCP tools' },
  { key: 'dead', label: 'Dead weight' },
];

type LaneFilter = 'all' | AgentRoleLane | 'unknown';
const LANES: { key: LaneFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'supervisor', label: 'Supervisor' },
  { key: 'worker', label: 'Worker' },
  { key: 'researcher', label: 'Researcher' },
  { key: 'legacy', label: 'Legacy' },
  { key: 'unknown', label: 'Unknown' },
];

// Skill breakdown facets — Agent type is the default (skill-legibility D6); the
// old "Invoker" facet is relabeled "Detection" and demoted (it groups on `detector`,
// only tool_use vs slash_command — a low-signal detection method, NOT "who invoked").
type GroupKey = 'byAgentType' | 'byWorkspace' | 'byAgentDir' | 'byInvoker';
const GROUPS: { key: GroupKey; label: string; help: string; filterable: boolean }[] = [
  { key: 'byAgentType', label: 'Agent type', help: 'supervisor / worker / researcher / legacy — the agent lane that invoked the skill (from stream_lane_stats).', filterable: true },
  { key: 'byWorkspace', label: 'Workspace', help: 'Grouped by Claude project slug (workspace path not yet recorded, so this is a slug proxy).', filterable: true },
  { key: 'byAgentDir', label: 'Agent dir', help: 'Raw launch working directory — the low-level source of Agent type. Display-only.', filterable: false },
  { key: 'byInvoker', label: 'Detection', help: 'How the invocation was detected: Skill tool call vs. slash command. Not the agent — see Agent type. Display-only.', filterable: false },
];

// MCP breakdown facets.
type McpGroupKey = 'byAgent' | 'byWorkspace' | 'byLane' | 'bySession';
const MCP_GROUPS: { key: McpGroupKey; label: string; help: string }[] = [
  { key: 'byAgent', label: 'Agent', help: 'Attribution is SESSION-BASED: a call maps to an agent only when its session resolves. Unmatched calls collapse to (unattributed) — many agents share a working directory, so this counts per session/run, not strictly per agent.' },
  { key: 'byWorkspace', label: 'Workspace', help: 'Workspace title when a session resolves, else the Claude project slug (workspace path not yet recorded).' },
  { key: 'byLane', label: 'Lane', help: 'Persona lane (supervisor / worker / researcher / legacy) from stream_lane_stats.' },
  { key: 'bySession', label: 'Session', help: 'One row per session / agent run (stream). Capped at 100 rows.' },
];

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
function fmtScore(s: number | null): string { return s == null ? '—' : s.toFixed(2); }
function scoreColor(s: number | null): string {
  if (s == null) return '#6b7280';
  if (s >= 0.75) return '#22c55e';
  if (s >= 0.5) return '#f59e0b';
  return '#ef4444';
}
function titleCase(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function detectionLabel(d: string): string {
  return d === 'slash_command' ? 'Slash command' : d === 'tool_use' ? 'Skill tool call' : d;
}

function InfoDot({ text }: { text: string }): JSX.Element {
  return (
    <span
      tabIndex={0}
      title={text}
      aria-label={text}
      className="inline-flex cursor-help align-middle ml-1 text-gray-500 hover:text-gray-300"
    >
      <Info size={11} />
    </span>
  );
}

export default function SkillAnalyticsPanel(): JSX.Element {
  const [view, setView] = useState<ViewKey>('all');
  const [windowKey, setWindowKey] = useState<WindowKey>('7d');
  const [laneFilter, setLaneFilter] = useState<LaneFilter>('all');
  const [slugFilter, setSlugFilter] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState<{ id: string | null; label: string } | null>(null);
  const [toolsetFilter, setToolsetFilter] = useState<string | null>(null);

  const [result, setResult] = useState<SkillUsageResult | null>(null);
  const [mcp, setMcp] = useState<McpToolUsageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [group, setGroup] = useState<GroupKey>('byAgentType');
  const [mcpGroup, setMcpGroup] = useState<McpGroupKey>('byAgent');
  const [indexing, setIndexing] = useState<{ done: number; total: number } | null>(null);

  const win = WINDOWS.find((w) => w.key === windowKey)!;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const sinceMs = win.ms != null ? Date.now() - win.ms : undefined;
    const lane = laneFilter === 'all' ? undefined : laneFilter;
    const slug = slugFilter ?? undefined;
    try {
      const [skillRes, mcpRes] = await Promise.all([
        window.api.skillAnalytics.query({ sinceMs, slug, lane }),
        window.api.mcpToolUsage.query({
          sinceMs, slug, lane,
          agentId: agentFilter?.id ?? undefined,
        }),
      ]);
      if (skillRes.ok) setResult(skillRes.data);
      else { setResult(null); setError(skillRes.error); }
      if (mcpRes.ok) setMcp(mcpRes.data);
      else setMcp(null);
    } catch (e) {
      setResult(null); setMcp(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [win.ms, laneFilter, slugFilter, agentFilter]);

  useEffect(() => { void load(); }, [load]);

  // Backfill progress banner (panel may mount mid-index; query returns partial data).
  useEffect(() => {
    let cancelled = false;
    void window.api.skillAnalytics.indexPoll().then((s: any) => {
      if (cancelled) return;
      if (s && s.ready === false && s.progress) setIndexing({ done: s.progress.filesDone, total: s.progress.filesTotal });
      else setIndexing(null);
    });
    const off = window.api.skillAnalytics.onIndexProgress((p: any) => {
      if (cancelled) return;
      if (p.filesDone >= p.filesTotal && p.filesTotal > 0) { setIndexing(null); void load(); }
      else setIndexing({ done: p.filesDone, total: p.filesTotal });
    });
    return () => { cancelled = true; off?.(); };
  }, [load]);

  const maxCount = useMemo(
    () => Math.max(1, ...(result?.mostUsed.map((m) => m.count) ?? [1])),
    [result],
  );
  const costBySkill = useMemo(() => {
    const m = new Map<string, SkillCostRollup>();
    for (const c of result?.cost ?? []) m.set(c.skill, c);
    return m;
  }, [result]);

  // Workspace <select> options come from the aggregates themselves (only slugs with data).
  const workspaceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const g of result?.byWorkspace ?? []) if (g.key && g.key !== '(unknown)') set.add(g.key);
    return [...set].sort();
  }, [result]);
  // Agent <select> options (MCP only) come from byAgent — only agents with calls, plus (unattributed).
  const agentOptions = useMemo(() => mcp?.byAgent ?? [], [mcp]);

  const laneLabel = laneFilter === 'all' ? 'all lanes' : titleCase(laneFilter);
  const wsLabel = slugFilter ?? 'all workspaces';
  const kindLabel = { all: 'skills + MCP tools', skills: 'skills', mcp: 'MCP tools', dead: 'dead weight' }[view];

  const showSkills = view === 'all' || view === 'skills';
  const showMcp = view === 'all' || view === 'mcp';
  const showDead = view === 'dead';

  return (
    <div className="h-full overflow-auto bg-surface-0 text-[13px]">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 px-4 py-2.5 bg-surface-0/95 backdrop-blur border-b dark:border-white/10 light:border-black/10">
        <BarChart3 size={16} className="text-accent-blue-bright shrink-0" />
        <span className="font-medium">Usage</span>
        {/* View toggle: All | Skills | MCP tools | Dead weight */}
        <Segmented options={VIEWS} value={view} onChange={(v) => setView(v as ViewKey)} />
        {/* Time window */}
        <Segmented options={WINDOWS} value={windowKey} onChange={(v) => setWindowKey(v as WindowKey)} />
        {/* Agent type (lane) */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-500">Agent type</span>
          <Segmented options={LANES} value={laneFilter} onChange={(v) => setLaneFilter(v as LaneFilter)} />
        </div>
        {/* Workspace */}
        <select
          value={slugFilter ?? ''}
          onChange={(e) => setSlugFilter(e.target.value || null)}
          className="text-[11px] bg-transparent border dark:border-white/10 light:border-black/10 rounded px-1.5 py-1"
          title="Workspace scope (Claude project slug — workspace path not yet recorded)"
        >
          <option value="">All workspaces</option>
          {workspaceOptions.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        {/* Agent selector — MCP attribution only */}
        {showMcp && agentOptions.length > 0 && (
          <select
            value={agentFilter?.id ?? ''}
            onChange={(e) => {
              const opt = agentOptions.find((a) => (a.agentId ?? '') === e.target.value);
              setAgentFilter(e.target.value ? { id: opt?.agentId ?? null, label: opt?.label ?? e.target.value } : null);
            }}
            className="text-[11px] bg-transparent border dark:border-white/10 light:border-black/10 rounded px-1.5 py-1"
            title="MCP attribution is session-based; only agents with resolved sessions appear"
          >
            <option value="">All agents</option>
            {agentOptions.filter((a) => a.agentId).map((a) => (
              <option key={a.agentId!} value={a.agentId!}>{a.label}</option>
            ))}
          </select>
        )}
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded text-[12px] hover:bg-white/10 disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Scope line — always visible; discloses the slug proxy (req #2/#3, cross-cutting #5). */}
        {result && (
          <div className="text-[11px] text-gray-400 leading-relaxed">
            Showing <span className="text-gray-200">{laneLabel}</span> ·{' '}
            <span className="text-gray-200">{wsLabel}</span> ·{' '}
            <span className="text-gray-200">{win.label}</span> ·{' '}
            <span className="text-gray-200">{kindLabel}</span>.{' '}
            {result.totalInvocations} skill invocation{result.totalInvocations === 1 ? '' : 's'} across {result.mostUsed.length} skills
            {mcp ? <> · {mcp.totalCalls} MCP tool call{mcp.totalCalls === 1 ? '' : 's'}</> : null}.
            {result.scopeMeta.workspaceKeyIsSlugProxy && (
              <span className="block text-gray-500">Workspace = Claude project slug (workspace path not yet recorded).</span>
            )}
            {mcp && mcp.scopeMeta.droppedUnattributedCalls > 0 && (
              <span className="block text-amber-500/80">
                {mcp.scopeMeta.droppedUnattributedCalls} MCP call{mcp.scopeMeta.droppedUnattributedCalls === 1 ? ' is' : 's are'} hidden by this workspace filter (unattributable to any workspace — session-based attribution).
              </span>
            )}
            {(result.scopeMeta.droppedUnattributedCount ?? 0) > 0 && (
              <span className="block text-amber-500/80">
                {result.scopeMeta.droppedUnattributedCount} skill invocation{result.scopeMeta.droppedUnattributedCount === 1 ? ' is' : 's are'} hidden by this workspace filter (unattributable to any workspace — session-based attribution).
              </span>
            )}
          </div>
        )}

        {/* Active cross-filter chips */}
        {(laneFilter !== 'all' || slugFilter || agentFilter) && (
          <div className="flex flex-wrap items-center gap-2">
            {laneFilter !== 'all' && (
              <FilterChip label={`Agent type: ${titleCase(laneFilter)}`} onClear={() => setLaneFilter('all')} />
            )}
            {slugFilter && <FilterChip label={`Workspace: ${slugFilter}`} onClear={() => setSlugFilter(null)} />}
            {agentFilter && <FilterChip label={`Agent: ${agentFilter.label}`} onClear={() => setAgentFilter(null)} />}
          </div>
        )}

        <MethodologyDetails />

        {indexing && (
          <div className="flex items-center gap-2 text-[12px] text-amber-400">
            <Loader2 size={14} className="animate-spin shrink-0" />
            Indexing session logs… {indexing.done} of {indexing.total} files (results are partial)
          </div>
        )}
        {loading && !result && <div className="text-gray-400">Loading…</div>}
        {error && (
          <div className="flex items-start gap-2 text-red-400">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>Query failed: {error}</span>
          </div>
        )}

        {/* ── Skills views ── */}
        {showSkills && result && result.totalInvocations > 0 && (
          <>
            <MostUsedCard result={result} maxCount={maxCount} />
            <EffectivenessCostCard effectiveness={result.effectiveness} costBySkill={costBySkill} />
          </>
        )}
        {showSkills && result && result.totalInvocations === 0 && !loading && (
          <div className="text-gray-400">No skill invocations recorded in this scope.</div>
        )}

        {/* ── MCP tools views ── */}
        {showMcp && mcp && (
          <>
            <McpAttributionCard mcp={mcp} />
            <McpMostUsedCard mcp={mcp} />
            <McpToolsetCard mcp={mcp} toolsetFilter={toolsetFilter} setToolsetFilter={setToolsetFilter} />
            <McpBreakdownCard
              mcp={mcp} group={mcpGroup} setGroup={setMcpGroup}
              onPickAgent={(r) => setAgentFilter(r.agentId ? { id: r.agentId, label: r.label } : null)}
              onPickLane={(k) => setLaneFilter((LANES.some((l) => l.key === k) ? k : 'unknown') as LaneFilter)}
            />
            <McpTimelineCard mcp={mcp} />
          </>
        )}

        {/* Timeline + breakdown (skills) shown for skills/all views */}
        {showSkills && result && result.totalInvocations > 0 && (
          <>
            <TimelineCard result={result} />
            <BreakdownCard
              result={result} group={group} setGroup={setGroup}
              onPickLane={(k) => setLaneFilter((LANES.some((l) => l.key === k) ? k : 'unknown') as LaneFilter)}
              onPickWorkspace={(k) => setSlugFilter(k)}
            />
            <RecentCard result={result} />
          </>
        )}

        {/* ── Dead weight view (Layer 3 — computation pending) ── */}
        {showDead && <DeadWeightCard />}
      </div>
    </div>
  );
}

function Segmented<T extends string>({ options, value, onChange }: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <div className="flex items-center rounded overflow-hidden border dark:border-white/10 light:border-black/10 text-[11px]">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`px-2 py-1 ${value === o.key ? 'bg-white/15 text-gray-100' : 'text-gray-400 hover:bg-white/5'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent-blue-bright/15 text-accent-blue-bright px-2 py-0.5 text-[11px]">
      {label}
      <button onClick={onClear} className="hover:text-gray-100" aria-label={`Clear ${label}`}>
        <X size={11} />
      </button>
    </span>
  );
}

function MethodologyDetails(): JSX.Element {
  return (
    <details className="ui-card px-3 py-2 text-[12px] text-gray-300">
      <summary className="cursor-pointer text-gray-400 select-none">How these numbers are computed</summary>
      <div className="mt-2 space-y-1.5 leading-relaxed">
        <p><b>Effectiveness (green 0–1, e.g. .92)</b> — average over <i>finalized</i> invocation windows of an observable
          composite. Each window: base 0.50; +0.50 if it produced ≥1 non-error tool result AND closed on a clean
          end-of-turn; −0.25 if any tool result errored; −0.15 for a repeated in-window search; −0.15 if it ended on a
          question. Clamped 0–1. Green ≥ 0.75, amber ≥ 0.50, red below. Open windows aren't scored; the (n) beside a score
          is how many windows were scored.</p>
        <p><b>✓ N</b> — positive windows: ≥1 non-error tool result AND a clean end-of-turn.
          <b> err / rpt / q</b> — windows with tool errors / repeated searches / that ended on a question.</p>
        <p><b>Cost — Fresh / invoke</b> — median fresh spend per invocation = input + cache-creation + output tokens; ± = p25–p75
          spread (hover the number). Cache <i>reads</i> are shown separately and never counted as spend.</p>
        <p><b>Heuristic (corr / wf)</b> — surfaced, never folded into the score; not captured by the parser today.</p>
        <p><b>MCP tools</b> — counts only. MCP calls aren't windowed, so they carry no effectiveness or cost — shown
          separately by design. Per-tool error rates aren't shown (tool results aren't linked to the calling tool in the
          log). Agent attribution is <b>session-based</b>: a call maps to a specific agent only when its session resolves;
          the rest stay in an honest (unattributed) bucket.</p>
        <p><b>Scope</b> — all figures respect the header filters: time window, workspace, agent type, kind.</p>
      </div>
    </details>
  );
}

function Card({ title, icon, children, aside }: { title: string; icon: React.ReactNode; children: React.ReactNode; aside?: React.ReactNode }): JSX.Element {
  return (
    <div className="ui-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b dark:border-white/10 light:border-black/10">
        {icon}
        <span className="font-medium">{title}</span>
        {aside}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function MostUsedCard({ result, maxCount }: { result: SkillUsageResult; maxCount: number }): JSX.Element {
  return (
    <Card
      title="Most used skills"
      icon={<BarChart3 size={15} className="text-accent-blue-bright" />}
      aside={<InfoDot text="Per-skill invocation count in the active scope. The right-hand number is the average observable effectiveness (0–1)." />}
    >
      <ul className="space-y-1.5">
        {result.mostUsed.map((m) => (
          <li key={m.skill} className="flex items-center gap-3">
            <span className="w-40 truncate text-[12px]" title={m.skill}>{m.skill}</span>
            <div className="flex-1 h-5 rounded-sm overflow-hidden bg-white/5">
              <div
                className="h-full rounded-sm bg-accent-blue-bright/70 flex items-center justify-end pr-1.5 text-[10px] text-gray-100"
                style={{ width: `${Math.max((m.count / maxCount) * 100, 4)}%` }}
                title={`${m.count} times invoked in scope`}
              >
                {m.count}
              </div>
            </div>
            <span
              className="w-9 text-right text-[11px] tabular-nums shrink-0"
              style={{ color: scoreColor(m.avgEffectiveness) }}
              title="avg observable effectiveness (0–1)"
            >
              {fmtScore(m.avgEffectiveness)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function EffectivenessCostCard({ effectiveness, costBySkill }: {
  effectiveness: SkillEffectiveness[];
  costBySkill: Map<string, SkillCostRollup>;
}): JSX.Element {
  return (
    <Card
      title="Effectiveness & cost"
      icon={<Gauge size={15} className="text-emerald-400" />}
      aside={
        <span className="ml-2 flex items-center gap-1 text-[10px] text-gray-500">
          <Info size={11} /> two tiers + cost — never blended into one number
        </span>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] min-w-[640px]">
          <thead className="text-gray-400 text-left">
            <tr className="border-b dark:border-white/5 light:border-black/5">
              <th className="px-2 py-1.5 font-normal">Skill</th>
              <th className="px-2 py-1.5 font-normal">Observable<InfoDot text="Observable-tier composite ∈ [0,1] — the only scored number. Mean over finalized windows; (n) = windows scored." /></th>
              <th className="px-2 py-1.5 font-normal">Observable inputs<InfoDot text="Raw window signals behind the score: ✓ positive windows, err errored, rpt repeated searches, q ended on a question." /></th>
              <th className="px-2 py-1.5 font-normal">Heuristic<InfoDot text="Heuristic tier (user_correction / workflow_followed) — surfaced, never folded into the score. Not captured by the parser today." /></th>
              <th className="px-2 py-1.5 font-normal text-right">Fresh / invoke<InfoDot text="Median fresh spend per invocation = input + cache-creation + output. ± = p25–p75 spread. A separate dimension, never blended into effectiveness." /></th>
              <th className="px-2 py-1.5 font-normal text-right">In / Out / Cache<InfoDot text="Median fresh input+cache-creation / output / cache-read tokens. Cache reads are shown separately and never counted as spend." /></th>
            </tr>
          </thead>
          <tbody>
            {effectiveness.map((e) => {
              const c = costBySkill.get(e.skill);
              return (
                <tr key={e.skill} className="border-b dark:border-white/5 light:border-black/5 last:border-0">
                  <td className="px-2 py-1.5 truncate max-w-[160px]" title={e.skill}>{e.skill}</td>
                  <td className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="tabular-nums font-medium" style={{ color: scoreColor(e.observableScore) }}>
                        {fmtScore(e.observableScore)}
                      </span>
                      <span className="text-[10px] text-gray-500">({e.scoredInvocations})</span>
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="flex flex-wrap gap-1">
                      <Badge tone="pos" title="windows that produced ≥1 non-error tool_result AND a clean end_turn">✓{e.positiveWindows}</Badge>
                      {e.errorWindows > 0 && <Badge tone="neg" title="windows with error tool_results">err {e.errorWindows}</Badge>}
                      {e.repeatedSearchWindows > 0 && <Badge tone="neg" title="repeated in-window search">rpt {e.repeatedSearchWindows}</Badge>}
                      {e.endedWithQuestionWindows > 0 && <Badge tone="neg" title="window ended with a question">q {e.endedWithQuestionWindows}</Badge>}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-gray-400">
                    {e.heuristic.userCorrection === 0 && e.heuristic.workflowFollowed === 0
                      ? <span className="text-[11px] text-gray-600">not captured</span>
                      : <span className="flex flex-wrap gap-1">
                          {e.heuristic.userCorrection > 0 && <Badge tone="warn" title="user_correction (heuristic)">corr {e.heuristic.userCorrection}</Badge>}
                          {e.heuristic.workflowFollowed > 0 && <Badge tone="neutral" title="workflow_followed (heuristic)">wf {e.heuristic.workflowFollowed}</Badge>}
                        </span>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {c ? <span title={`p25 ${c.freshP25} · p75 ${c.freshP75}`}>{fmtNum(c.freshMedian)} <span className="text-[10px] text-gray-500">±</span></span> : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-400 text-[11px]">
                    {c ? `${fmtNum(c.freshInputMedian)} / ${fmtNum(c.outputMedian)} / ${fmtNum(c.cacheReadMedian)}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-gray-500">
        Observable composite scored from finalized-window signals only; heuristic tier and cost (median fresh spend =
        input+cache_creation+output per invocation; cache reads shown separately, never counted as spend) are displayed beside it and never folded in.
      </p>
    </Card>
  );
}

function Badge({ children, tone, title }: { children: React.ReactNode; tone: 'pos' | 'neg' | 'warn' | 'neutral'; title?: string }): JSX.Element {
  const cls = {
    pos: 'bg-emerald-500/15 text-emerald-400',
    neg: 'bg-red-500/15 text-red-400',
    warn: 'bg-amber-500/15 text-amber-400',
    neutral: 'bg-white/10 text-gray-400',
  }[tone];
  return <span className={`px-1 rounded text-[10px] tabular-nums ${cls}`} title={title}>{children}</span>;
}

// ── MCP tools cards ─────────────────────────────────────────────────────────────

// WP-C / P2 — the honest four-tier attribution disclosure, rendered near the claims.
// Mirrors the MCP-route DTO (tierBreakdown + attributionCoveragePct + byToolLane) so
// the dashboard and the agent-facing tool tell the SAME story for the same dataset.
const ATTRIBUTION_TIERS: { key: AttributionTier; label: string; help: string; color: string }[] = [
  { key: 'agent-attributed', label: 'Agent-attributed', help: 'Session resolves to ONE dashboard agent. Strongest — but still capped by the shared-cwd invariant (never promoted to "direct" on coverage).', color: 'bg-emerald-400/70' },
  { key: 'lane-attributed-explicit', label: 'Lane (explicit)', help: 'The stream carries explicit lane metadata (stream_lane_stats.lane).', color: 'bg-cyan-400/70' },
  { key: 'lane-inferred-from-current-grant', label: 'Lane (inferred)', help: 'No explicit lane, but the tool\'s toolset is granted to exactly ONE lane today — inferred from the current grant topology (lower confidence). Never inferred for a toolset shared by >1 lane.', color: 'bg-amber-400/70' },
  { key: 'unattributed', label: 'Unattributed', help: 'No agent, no lane, no exclusive-grant signal. Kept first-class — never dropped, never implied to be one agent (many agents share a working directory).', color: 'bg-gray-500/60' },
];

function coverageBandOf(pct: number): AttributionCoverageBand {
  if (pct > 80) return 'direct';
  if (pct >= 50) return 'cautioned';
  if (pct >= 10) return 'provisional';
  return 'diagnostic';
}
const BAND_STYLE: Record<AttributionCoverageBand, { label: string; className: string }> = {
  direct: { label: 'direct', className: 'text-emerald-400' },
  cautioned: { label: 'cautioned', className: 'text-cyan-300' },
  provisional: { label: 'provisional', className: 'text-amber-400' },
  diagnostic: { label: 'diagnostic', className: 'text-gray-400' },
};

function McpAttributionCard({ mcp }: { mcp: McpToolUsageResult }): JSX.Element {
  const total = mcp.totalCalls;
  const pct = mcp.attributionCoveragePct;
  const band = coverageBandOf(pct);
  const bandStyle = BAND_STYLE[band];
  // Top tool×lane cells (attributed only — the unattributed bucket is disclosed via
  // the tier bar above, so this cross-tab focuses on where lanes actually resolved).
  const cells: McpToolLaneCell[] = useMemo(
    () => [...mcp.byToolLane].filter((c) => c.tier !== 'unattributed').sort((a, b) => b.count - a.count).slice(0, 8),
    [mcp],
  );
  return (
    <Card
      title="Attribution coverage"
      icon={<Gauge size={15} className="text-cyan-400" />}
      aside={<InfoDot text="Honest four-tier attribution for MCP calls. Coverage bands (direct / cautioned / provisional / diagnostic) qualify LANE claims only — a per-agent claim is never promoted to 'direct' on coverage strength (cwd is many-to-one per agent)." />}
    >
      <div className="mb-3 flex items-baseline gap-2">
        <span className={`text-2xl font-semibold tabular-nums ${bandStyle.className}`}>{pct}%</span>
        <span className="text-[11px] text-gray-400">lane coverage</span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${bandStyle.className} bg-white/5`}>{bandStyle.label}</span>
      </div>
      {band === 'diagnostic' && (
        <p className="mb-2 text-[10px] text-gray-400">
          Coverage is too low for a lane-specific claim — this is a coverage diagnostic, not a lane verdict.
        </p>
      )}
      {/* Four-tier breakdown bar */}
      <div className="mb-1 flex h-3 w-full overflow-hidden rounded-sm bg-white/5">
        {ATTRIBUTION_TIERS.map((t) => {
          const n = mcp.tierBreakdown[t.key];
          const w = total > 0 ? (n / total) * 100 : 0;
          return w > 0 ? <div key={t.key} className={t.color} style={{ width: `${w}%` }} title={`${t.label}: ${n}`} /> : null;
        })}
      </div>
      <ul className="mb-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
        {ATTRIBUTION_TIERS.map((t) => (
          <li key={t.key} className="flex items-center gap-1.5 text-[10px] text-gray-400" title={t.help}>
            <span className={`inline-block h-2 w-2 rounded-sm ${t.color}`} />
            <span className="truncate">{t.label}</span>
            <span className="ml-auto tabular-nums text-gray-300">{mcp.tierBreakdown[t.key]}</span>
          </li>
        ))}
      </ul>
      {cells.length > 0 && (
        <>
          <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-gray-500">Tool × lane (top resolved)</div>
          <ul className="space-y-0.5">
            {cells.map((c) => (
              <li key={`${c.toolName}:${c.lane}:${c.tier}`} className="flex items-center gap-2 text-[10px]">
                <span className="w-40 truncate text-gray-300" title={c.toolName}>{c.toolShort}</span>
                <span className="w-24 truncate text-gray-400" title={`tier: ${c.tier}`}>{c.lane}</span>
                <span className="ml-auto tabular-nums text-gray-400">{c.count}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function McpMostUsedCard({ mcp }: { mcp: McpToolUsageResult }): JSX.Element {
  const max = Math.max(1, ...mcp.byTool.map((t) => t.count));
  return (
    <Card
      title="Most used MCP tools"
      icon={<Wrench size={15} className="text-accent-blue-bright" />}
      aside={<InfoDot text="Individual MCP tools your agents actually invoked (one tool_use block = one call), grouped by tool. Counts only — MCP calls aren't windowed, so no effectiveness or cost." />}
    >
      {mcp.byTool.length === 0 ? (
        <div className="text-gray-500 text-[12px]">No MCP tool calls in this scope.</div>
      ) : (
        <ul className="space-y-1.5">
          {mcp.byTool.map((t) => (
            <li key={t.toolName} className="flex items-center gap-3">
              <span className="w-52 truncate text-[12px]" title={t.toolName}>{t.toolShort}</span>
              <div className="flex-1 h-5 rounded-sm overflow-hidden bg-white/5">
                <div
                  className="h-full rounded-sm bg-accent-blue-bright/70 flex items-center justify-end pr-1.5 text-[10px] text-gray-100"
                  style={{ width: `${Math.max((t.count / max) * 100, 4)}%` }}
                  title={`${t.count} times invoked in scope · ${t.distinctStreams} session(s)`}
                >
                  {t.count}
                </div>
              </div>
              <span className="w-16 text-right text-[10px] text-gray-500 truncate" title={`toolset: ${t.toolset ?? 'unknown'}`}>
                {t.toolset ?? 'unknown'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function McpToolsetCard({ mcp, toolsetFilter, setToolsetFilter }: {
  mcp: McpToolUsageResult; toolsetFilter: string | null; setToolsetFilter: (t: string | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const rows: McpToolsetRollup[] = mcp.byToolset;
  const max = Math.max(1, ...rows.map((r) => r.count));
  const toggle = (k: string) => {
    setOpen((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  };
  return (
    <Card
      title="By toolset"
      icon={<Layers size={15} className="text-violet-400" />}
      aside={<InfoDot text="MCP calls grouped by toolset (e.g. browser). Expand a toolset to see which individual tools inside it were called. Combined with the Agent-type/Workspace scope, this answers which tools each agent used." />}
    >
      {rows.length === 0 ? (
        <div className="text-gray-500 text-[12px]">No MCP tool calls in this scope.</div>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => {
            const key = r.toolset ?? '(unknown)';
            const isOpen = open.has(key);
            return (
              <li key={key}>
                <div className="flex items-center gap-2">
                  <button onClick={() => toggle(key)} className="flex items-center gap-1 flex-1 min-w-0 text-left hover:text-gray-100" aria-expanded={isOpen}>
                    {isOpen ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
                    <span className="truncate text-[12px]" title={key}>{key}</span>
                    <span className="text-[10px] text-gray-500 shrink-0">{r.tools.length} tool{r.tools.length === 1 ? '' : 's'}</span>
                  </button>
                  <div className="w-32 h-3.5 rounded-sm overflow-hidden bg-white/5 shrink-0">
                    <div className="h-full rounded-sm bg-violet-400/60" style={{ width: `${Math.max((r.count / max) * 100, 3)}%` }} />
                  </div>
                  <span className="w-10 text-right text-[11px] tabular-nums text-gray-400 shrink-0">{r.count}</span>
                </div>
                {isOpen && (
                  <ul className="ml-5 mt-1 mb-1.5 space-y-0.5 border-l dark:border-white/10 light:border-black/10 pl-2">
                    {r.tools.map((t) => (
                      <li key={t.toolName} className="flex items-center gap-2 text-[11px]">
                        <span className="flex-1 truncate text-gray-300" title={t.toolName}>{t.toolShort}</span>
                        <span className="text-gray-500 tabular-nums">{t.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function McpBreakdownCard({ mcp, group, setGroup, onPickAgent, onPickLane }: {
  mcp: McpToolUsageResult;
  group: McpGroupKey;
  setGroup: (g: McpGroupKey) => void;
  onPickAgent: (r: McpUsageGroupRow) => void;
  onPickLane: (k: string) => void;
}): JSX.Element {
  const rows: McpUsageGroupRow[] = mcp[group];
  const max = Math.max(1, ...rows.map((r) => r.count));
  const help = MCP_GROUPS.find((g) => g.key === group)!.help;
  const unattributedPct = mcp.totalCalls > 0 ? Math.round((1 - mcp.attributedCalls / mcp.totalCalls) * 100) : 0;
  return (
    <Card
      title="MCP breakdown"
      icon={<BarChart3 size={15} className="text-cyan-400" />}
      aside={
        <div className="ml-2 flex items-center gap-2">
          <Segmented options={MCP_GROUPS} value={group} onChange={(v) => setGroup(v as McpGroupKey)} />
          <InfoDot text={help} />
        </div>
      }
    >
      {group === 'byAgent' && (
        <p className="mb-2 text-[10px] text-amber-400/80">
          {unattributedPct}% of calls are unattributed — attribution is session-based (many agents share a working directory).
        </p>
      )}
      <ul className="space-y-1">
        {rows.map((r) => {
          const clickable = (group === 'byAgent' && r.agentId) || group === 'byLane';
          return (
            <li key={r.key} className="flex items-center gap-3">
              <button
                disabled={!clickable}
                onClick={() => { if (group === 'byAgent') onPickAgent(r); else if (group === 'byLane') onPickLane(r.key); }}
                className={`w-56 truncate text-left text-[11px] text-gray-300 ${clickable ? 'hover:text-gray-100 cursor-pointer' : 'cursor-default'}`}
                title={r.label}
              >
                {r.label}
              </button>
              <div className="flex-1 h-4 rounded-sm overflow-hidden bg-white/5">
                <div className="h-full rounded-sm bg-cyan-400/60" style={{ width: `${Math.max((r.count / max) * 100, 3)}%` }} />
              </div>
              <span className="w-10 text-right text-[11px] tabular-nums text-gray-400">{r.count}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function McpTimelineCard({ mcp }: { mcp: McpToolUsageResult }): JSX.Element {
  const buckets = useMemo(() => bucketize(mcp.timeline.map((r) => ({ tsMs: r.tsMs, label: r.toolShort }))), [mcp]);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <Card
      title="MCP call timeline"
      icon={<Activity size={15} className="text-cyan-400" />}
      aside={mcp.timelineTruncated ? <span className="ml-2 text-[10px] text-amber-400">(latest 5000 — older omitted)</span> : undefined}
    >
      {buckets.length === 0 ? (
        <div className="text-gray-500 text-[12px]">No MCP call timeline data.</div>
      ) : (
        <div className="flex items-end gap-0.5 h-16">
          {buckets.map((b, i) => (
            <div
              key={i}
              className="flex-1 bg-cyan-400/60 rounded-t-sm min-h-[1px]"
              style={{ height: `${(b.count / max) * 100}%` }}
              title={`${b.count} MCP calls · ${new Date(b.from).toLocaleString()}–${new Date(b.to).toLocaleString()}${b.top.length ? `\nTop: ${b.top.join(', ')}` : ''}`}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Skill timeline with hover + click-drill ─────────────────────────────────────

interface Bucket<T> { count: number; from: number; to: number; top: string[]; rows: T[]; }
function bucketize<T extends { tsMs: number; label: string }>(items: T[], N = 40): Bucket<T>[] {
  if (items.length === 0) return [];
  const min = items[0].tsMs, max = items[items.length - 1].tsMs;
  const span = Math.max(1, max - min);
  const step = span / N;
  const out: Bucket<T>[] = Array.from({ length: N }, (_, i) => ({
    count: 0, from: min + i * step, to: min + (i + 1) * step, top: [], rows: [],
  }));
  for (const r of items) {
    const i = Math.min(N - 1, Math.floor(((r.tsMs - min) / span) * N));
    out[i].count++;
    out[i].rows.push(r);
  }
  for (const b of out) {
    const freq = new Map<string, number>();
    for (const r of b.rows) freq.set(r.label, (freq.get(r.label) ?? 0) + 1);
    b.top = [...freq.entries()].sort((a, c) => c[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`);
  }
  return out;
}

function TimelineCard({ result }: { result: SkillUsageResult }): JSX.Element {
  const [drill, setDrill] = useState<{ rows: SkillTimelineRow[]; from: number; to: number; idx: number } | null>(null);
  const buckets = useMemo(
    () => bucketize(result.timeline.map((r) => ({ ...r, label: r.skill }))),
    [result],
  );
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <Card
      title="Skill invocations (latest 5000)"
      icon={<Activity size={15} className="text-cyan-400" />}
      aside={
        <div className="ml-2 flex items-center gap-2">
          {result.timelineTruncated && <span className="text-[10px] text-amber-400">(older invocations omitted)</span>}
          <InfoDot text="Skill invocations over time; hover a bar for its top skills, click to list the invocations behind it. MCP-tool timeline is shown separately." />
        </div>
      }
    >
      {buckets.length === 0 ? (
        <div className="text-gray-500 text-[12px]">No timeline data.</div>
      ) : (
        <>
          <div className="flex items-end gap-0.5 h-16">
            {buckets.map((b, i) => (
              <button
                key={i}
                onClick={() => b.count > 0 && setDrill({ rows: b.rows, from: b.from, to: b.to, idx: i })}
                className={`flex-1 rounded-t-sm min-h-[1px] ${drill?.idx === i ? 'bg-cyan-400' : 'bg-cyan-400/60 hover:bg-cyan-400/90'}`}
                style={{ height: `${(b.count / max) * 100}%` }}
                title={`${b.count} invocations · ${new Date(b.from).toLocaleString()}–${new Date(b.to).toLocaleString()}${b.top.length ? `\nTop: ${b.top.join(', ')}` : ''}`}
                aria-label={`${b.count} invocations`}
              />
            ))}
          </div>
          {drill && (
            <div className="mt-3 border-t dark:border-white/10 light:border-black/10 pt-2">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[11px] text-gray-300">
                  {drill.rows.length} invocation{drill.rows.length === 1 ? '' : 's'}, {new Date(drill.from).toLocaleString()}–{new Date(drill.to).toLocaleString()}
                </span>
                <button onClick={() => setDrill(null)} className="ml-auto flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-100">
                  <X size={11} /> clear
                </button>
              </div>
              <div className="overflow-x-auto max-h-56 overflow-y-auto">
                <table className="w-full text-[11px] min-w-[560px]">
                  <thead className="text-gray-400 text-left sticky top-0 bg-surface-0">
                    <tr className="border-b dark:border-white/5 light:border-black/5">
                      <th className="px-2 py-1 font-normal">Time</th>
                      <th className="px-2 py-1 font-normal">Skill</th>
                      <th className="px-2 py-1 font-normal">Agent type</th>
                      <th className="px-2 py-1 font-normal">Workspace</th>
                      <th className="px-2 py-1 font-normal">Detection</th>
                      <th className="px-2 py-1 font-normal">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drill.rows.slice().sort((a, b) => b.tsMs - a.tsMs).map((r) => (
                      <tr key={r.id} className="border-b dark:border-white/5 light:border-black/5 last:border-0">
                        <td className="px-2 py-1 text-gray-400 tabular-nums whitespace-nowrap">{new Date(r.tsMs).toLocaleString()}</td>
                        <td className="px-2 py-1 truncate max-w-[120px]" title={r.skill}>{r.skill}</td>
                        <td className="px-2 py-1 text-gray-400">{titleCase(r.lane)}</td>
                        <td className="px-2 py-1 text-gray-400 truncate max-w-[120px]" title={r.workspaceKey}>{r.workspaceKey}</td>
                        <td className="px-2 py-1 text-gray-400">{detectionLabel(r.detector)}</td>
                        <td className="px-2 py-1 text-gray-500 truncate max-w-[100px]" title={r.jsonlPath ?? undefined}>{r.id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function BreakdownCard({ result, group, setGroup, onPickLane, onPickWorkspace }: {
  result: SkillUsageResult;
  group: GroupKey;
  setGroup: (g: GroupKey) => void;
  onPickLane: (k: string) => void;
  onPickWorkspace: (k: string) => void;
}): JSX.Element {
  const rows: SkillGroupRow[] = result[group];
  const max = Math.max(1, ...rows.map((r) => r.count));
  const meta = GROUPS.find((g) => g.key === group)!;
  return (
    <Card
      title="Breakdown"
      icon={<BarChart3 size={15} className="text-violet-400" />}
      aside={
        <div className="ml-2 flex items-center gap-2">
          <Segmented options={GROUPS} value={group} onChange={(v) => setGroup(v as GroupKey)} />
          <InfoDot text={meta.help} />
        </div>
      }
    >
      <ul className="space-y-1">
        {rows.map((r) => {
          const label = group === 'byAgentType' ? titleCase(r.key)
            : group === 'byInvoker' ? detectionLabel(r.key)
            : r.key;
          return (
            <li key={r.key} className="flex items-center gap-3">
              <button
                disabled={!meta.filterable}
                onClick={() => { if (group === 'byAgentType') onPickLane(r.key); else if (group === 'byWorkspace') onPickWorkspace(r.key); }}
                className={`w-56 truncate text-left text-[11px] text-gray-300 ${meta.filterable ? 'hover:text-gray-100 cursor-pointer' : 'cursor-default'}`}
                title={r.key}
              >
                {label}
              </button>
              <div className="flex-1 h-4 rounded-sm overflow-hidden bg-white/5">
                <div className="h-full rounded-sm bg-violet-400/60" style={{ width: `${Math.max((r.count / max) * 100, 3)}%` }} />
              </div>
              <span className="w-10 text-right text-[11px] tabular-nums text-gray-400">{r.count}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function RecentCard({ result }: { result: SkillUsageResult }): JSX.Element {
  return (
    <Card title="Recent invocations" icon={<Clock size={15} className="text-gray-400" />}>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] min-w-[560px]">
          <thead className="text-gray-400 text-left">
            <tr className="border-b dark:border-white/5 light:border-black/5">
              <th className="px-2 py-1 font-normal">Skill</th>
              <th className="px-2 py-1 font-normal">When</th>
              <th className="px-2 py-1 font-normal">Agent type</th>
              <th className="px-2 py-1 font-normal">Workspace</th>
              <th className="px-2 py-1 font-normal">Detection</th>
            </tr>
          </thead>
          <tbody>
            {result.contextSamples.map((s, i) => (
              <tr key={i} className="border-b dark:border-white/5 light:border-black/5 last:border-0">
                <td className="px-2 py-1 truncate max-w-[160px]" title={s.args ?? undefined}>{s.skill}</td>
                <td className="px-2 py-1 text-gray-400 tabular-nums whitespace-nowrap">{new Date(s.tsMs).toLocaleString()}</td>
                <td className="px-2 py-1 text-gray-400">{titleCase(s.lane)}</td>
                <td className="px-2 py-1 text-gray-400 truncate max-w-[140px]" title={s.slug ?? undefined}>{s.slug ?? '—'}</td>
                <td className="px-2 py-1 text-gray-400">{detectionLabel(s.detector)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function DeadWeightCard(): JSX.Element {
  return (
    <Card title="Dead-weight MCP tool grants" icon={<AlertTriangle size={15} className="text-amber-400" />}>
      <div className="text-[12px] text-gray-400 space-y-1.5">
        <p>
          Dead-weight detection (granted-but-never-invoked MCP tools per lane, with an exposure gate that
          separates <i>dead</i> from <i>insufficient exposure</i>) is <b>not yet wired</b> — the Layer-3
          grant-coverage computation and its optimizer feed are pending.
        </p>
        <p className="text-gray-500">
          To keep the surface honest, nothing is shown here rather than a fabricated figure. Live tool usage is
          available under the <b>MCP tools</b> view; granted-but-unused classification will appear here once the
          coverage query lands.
        </p>
      </div>
    </Card>
  );
}
