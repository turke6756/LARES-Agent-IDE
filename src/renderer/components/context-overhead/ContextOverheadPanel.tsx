import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, RefreshCw, FileText, AlertTriangle, ChevronRight, ChevronDown, Pencil, Plus } from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type {
  AgentContextOverhead,
  ConfigSectionWeight,
  ConfigWeightRollup,
  InheritanceFrame,
  InheritanceScope,
  McpServerOverhead,
  McpToolOverhead,
  OverheadModel,
  OverheadSource,
  OverheadSourceKind,
  ScanOverheadResult,
  SectionWeightClass,
} from '../../../shared/types';

// Per-kind segment colors for the stacked bars + drill-down dots.
const KIND_COLOR: Record<OverheadSourceKind, string> = {
  'agent-claude': '#3b82f6',
  'inherited-claude': '#60a5fa',
  'claude-local': '#818cf8',
  'user-claude': '#a855f7',
  'managed-policy': '#ec4899',
  'agents-md': '#fb923c', // WP2 — AGENTS.md directory chain (provider-audience scoped)
  rules: '#f59e0b',
  memory: '#10b981', // legacy (no longer emitted; kept for the union)
  'memory-index': '#10b981', // resident pointer (0 tokens)
  'memory-body': '#6ee7b7', // light green — on-demand memory body
  behavioral: '#14b8a6',
  'settings-hooks': '#6366f1',
  skill: '#22c55e', // legacy (no longer emitted; kept for the union)
  'skill-header': '#16a34a', // dim green — resident header (baseline)
  'skill-body': '#86efac', // light green overlay — on-invoke body (scenario)
  import: '#06b6d4',
  'mcp-tool-schema': '#ef4444',
  'system-baseline': '#64748b',
  unknown: '#9ca3af',
};

const MCP_COLOR = '#ef4444';

// Plain-language name for every source kind (legend, §E4). Covers the whole union
// incl. legacy kinds so no rendered color dot is ever unlegended.
const KIND_LABEL: Record<OverheadSourceKind, string> = {
  'agent-claude': "Agent's own CLAUDE.md",
  'inherited-claude': 'Inherited CLAUDE.md (an ancestor directory)',
  'claude-local': 'CLAUDE.local.md (local override)',
  'user-claude': 'User CLAUDE.md (~/.claude)',
  'managed-policy': 'Managed-policy CLAUDE.md (enterprise)',
  'agents-md': 'AGENTS.md — directory chain, provider-audience scoped (WP2)',
  rules: 'Rules file (.claude/rules/*.md)',
  memory: 'Memory (legacy — no longer emitted)',
  'memory-index': 'Memory index — resident pointer, 0 tokens (body read on demand)',
  'memory-body': 'Memory body — on-demand, not injected each session',
  behavioral: 'behavioral.md (shared worker notes)',
  'settings-hooks': 'settings.json (hooks / config)',
  skill: 'Skill (legacy — no longer emitted)',
  'skill-header': 'Skill header — resident YAML frontmatter (baseline)',
  'skill-body': 'Skill body — on-demand, loads when the skill runs',
  import: '@import — a file inlined into its parent',
  'mcp-tool-schema': 'MCP tool schema',
  'system-baseline': 'System baseline',
  unknown: 'Unknown source',
};

// Inheritance-scope chip meanings (legend, §E4).
const SCOPE_LABEL: Record<InheritanceScope, string> = {
  agent: "the agent's own directory",
  'workspace-ancestor': 'an ancestor directory inside the workspace',
  'parent-ancestor': 'an ancestor directory above the workspace root',
  user: 'the user scope (~/.claude)',
  managed: 'the managed/enterprise policy scope',
  'additional-dir': 'a directory added via --add-dir',
  unknown: 'unknown scope',
};

// Section weight classification (§E5). Six statuses; `live`/`dead` are behavior-only
// (this plan's structural classifier never emits them) — legended so the UI is stable.
const WEIGHT_CLASS_COLOR: Record<SectionWeightClass, string> = {
  live: '#22c55e',
  dead: '#ef4444',
  'structurally-broken': '#f97316',
  'insufficient-evidence': '#eab308',
  unobservable: '#64748b',
  'not-analyzed': '#6b7280',
};
const WEIGHT_CLASS_LABEL: Record<SectionWeightClass, string> = {
  live: 'live',
  dead: 'dead',
  'structurally-broken': 'structurally broken',
  'insufficient-evidence': 'insufficient evidence',
  unobservable: 'unobservable',
  'not-analyzed': 'not analyzed',
};
const WEIGHT_CLASS_TOOLTIP: Record<SectionWeightClass, string> = {
  live: 'Observed behavior exercises this guidance. Requires behavior data (not yet wired).',
  dead: 'Sufficient exposure exists but the guidance is never exercised. Requires behavior data (not yet wired).',
  'structurally-broken': 'A concrete reference provably does not resolve (missing file / absent skill / ungranted toolset). Actionable dead weight, provable now.',
  'insufficient-evidence': 'Has references that DO resolve, but no behavior data yet to judge live vs dead.',
  unobservable: 'Pure prose with no mechanical predicate; cannot be judged either way.',
  'not-analyzed': 'Classification did not run (file too large or unreadable).',
};
const WEIGHT_CLASS_ORDER: SectionWeightClass[] = [
  'structurally-broken', 'insufficient-evidence', 'unobservable', 'not-analyzed', 'live', 'dead',
];

function fmt(n: number): string {
  return n.toLocaleString();
}

// Disclosure view for the headline total (Wave-2 §E1). `resident` (default) sums
// ONLY sources that actually enter context each session (`residentTotal`, the
// truthful headline). `worst-case` adds the on-demand pool (skill bodies, memory
// body) on top (`total`) — labeled as worst-case, never asserted as loaded.
type DisclosureView = 'resident' | 'worst-case';

export default function ContextOverheadPanel(): JSX.Element {
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const openTab = useDashboardStore((s) => s.openTab);
  const [result, setResult] = useState<ScanOverheadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<DisclosureView>('resident');

  const scan = useCallback(async () => {
    if (!selectedWorkspaceId) return;
    setLoading(true);
    try {
      const res = await window.api.contextOverhead.scan({ workspaceId: selectedWorkspaceId });
      setResult(res);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [selectedWorkspaceId]);

  useEffect(() => {
    void scan();
  }, [scan]);

  return (
    <div className="h-full overflow-auto bg-surface-0 text-[13px]">
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2.5 bg-surface-0/95 backdrop-blur border-b dark:border-white/10 light:border-black/10">
        <BarChart3 size={16} className="text-accent-blue-bright shrink-0" />
        <span className="font-medium">Context Overhead</span>
        {result?.ok && (
          <span className="text-[11px] text-gray-400">
            {result.model.estimatorMethod} · approximate (cl100k proxy; Claude tokenizer ~30% higher)
          </span>
        )}
        {result?.ok && <DisclosureToggle view={view} onChange={setView} />}
        <button
          onClick={() => void scan()}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded text-[12px] hover:bg-white/10 disabled:opacity-50"
          title="Re-scan"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="p-4 space-y-4">
        {result?.ok && <Legend />}
        {loading && !result && <div className="text-gray-400">Scanning…</div>}
        {result && !result.ok && (
          <div className="flex items-start gap-2 text-red-400">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>Scan failed: {result.error}</span>
          </div>
        )}
        {result?.ok && <ModelView model={result.model} openTab={openTab} view={view} />}
      </div>
    </div>
  );
}

function DisclosureToggle({
  view,
  onChange,
}: {
  view: DisclosureView;
  onChange: (v: DisclosureView) => void;
}): JSX.Element {
  const opts: Array<{ v: DisclosureView; label: string; title: string }> = [
    {
      v: 'resident',
      label: 'Resident only',
      title: 'Headline = residentTotal: only content injected into context every session (CLAUDE.md/config, skill headers, MCP schemas). On-demand content (skill bodies, the MEMORY.md body) is NOT included — it is not injected each session.',
    },
    {
      v: 'worst-case',
      label: 'Resident + on-demand (worst case)',
      title: 'Headline = total: residentTotal plus the on-demand pool (skill bodies + MEMORY.md body) added on top. Worst case — on-demand content is only disclosed when read/invoked, not loaded every session.',
    },
  ];
  return (
    <div className="flex items-center rounded overflow-hidden border dark:border-white/10 light:border-black/10 text-[11px]">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          title={o.title}
          className={`px-2 py-0.5 transition-colors ${
            view === o.v ? 'bg-white/15 text-gray-100' : 'text-gray-400 hover:bg-white/5'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The headline token count for an agent under the selected disclosure view.
 *  `resident` = residentTotal (truthful headline); `worst-case` = total (adds the
 *  on-demand pool). Falls back to `total` only for legacy models missing the
 *  Wave-2 split. */
function headlineTokens(agent: AgentContextOverhead, view: DisclosureView): number {
  const resident = agent.residentTotal?.tokens ?? agent.total.tokens;
  return view === 'resident' ? resident : agent.total.tokens;
}

/** On-demand pool tokens (skill bodies + memory body) — never in the resident headline. */
function onDemandTokens(agent: AgentContextOverhead): number {
  return agent.onDemandTotal?.tokens ?? Math.max(0, agent.total.tokens - (agent.residentTotal?.tokens ?? agent.total.tokens));
}

function ModelView({
  model,
  openTab,
  view,
}: {
  model: OverheadModel;
  openTab: ReturnType<typeof useDashboardStore.getState>['openTab'];
  view: DisclosureView;
}): JSX.Element {
  const maxTotal = Math.max(1, ...model.agents.map((a) => headlineTokens(a, view)));
  const openWorkspacePath = (path: string) => {
    const a = model.agents[0];
    openTab(path, a?.workingDir ?? model.workspaceRoot, model.pathType, a?.id ?? '', model.workspaceId);
  };

  return (
    <>
      {/* Workspace-wide config weight classification (§E5) */}
      {model.workspaceConfigWeight && model.workspaceConfigWeight.sections.length > 0 && (
        <ConfigWeightView
          rollup={model.workspaceConfigWeight}
          title="Workspace config — weight classification"
          onOpenPath={openWorkspacePath}
        />
      )}

      {/* Comparative chart */}
      <div className="space-y-2">
        {model.agents.map((agent) => (
          <ComparativeBar key={agent.id} agent={agent} maxTotal={maxTotal} view={view} />
        ))}
        {model.agents.length === 0 && (
          <div className="text-gray-400">No agents discovered in this workspace.</div>
        )}
      </div>

      {/* Per-agent drill-down */}
      <div className="space-y-3">
        {model.agents.map((agent) => (
          <AgentDrillDown key={agent.id} agent={agent} model={model} openTab={openTab} view={view} />
        ))}
      </div>

      {model.globalWarnings.length > 0 && (
        <div className="text-[12px] text-amber-400/80 space-y-1">
          {model.globalWarnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function segmentsFor(
  agent: AgentContextOverhead,
  view: DisclosureView,
): Array<{ kind: OverheadSourceKind | 'mcp'; tokens: number }> {
  const byKind = new Map<OverheadSourceKind, number>();
  for (const s of agent.flatSources) {
    if (s.estimate.tokens <= 0) continue;
    // Resident view drops on-demand sources (skill bodies, memory body) — they
    // are not injected each session, so they never enter the resident bar.
    if (view === 'resident' && s.disclosureTier === 'on-demand') continue;
    byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + s.estimate.tokens);
  }
  const segs: Array<{ kind: OverheadSourceKind | 'mcp'; tokens: number }> = [...byKind.entries()].map(
    ([kind, tokens]) => ({ kind, tokens }),
  );
  const mcpTokens = agent.mcpServers
    .filter((m) => !m.excludedByStrictMode)
    .reduce((sum, m) => sum + m.total.tokens, 0);
  if (mcpTokens > 0) segs.push({ kind: 'mcp', tokens: mcpTokens });
  return segs;
}

function ComparativeBar({
  agent,
  maxTotal,
  view,
}: {
  agent: AgentContextOverhead;
  maxTotal: number;
  view: DisclosureView;
}): JSX.Element {
  const segs = segmentsFor(agent, view);
  const headline = headlineTokens(agent, view);
  const widthPct = (headline / maxTotal) * 100;
  const onDemand = onDemandTokens(agent);
  return (
    <div className="flex items-center gap-2">
      <div className="w-32 shrink-0 truncate text-[12px]" title={agent.name}>
        {agent.name}
      </div>
      <div className="flex-1 h-5 rounded-sm overflow-hidden bg-white/5 flex" style={{ width: `${Math.max(widthPct, 2)}%` }}>
        {segs.map((seg, i) => (
          <div
            key={i}
            className="h-full"
            style={{
              width: `${(seg.tokens / Math.max(headline, 1)) * 100}%`,
              backgroundColor: seg.kind === 'mcp' ? MCP_COLOR : KIND_COLOR[seg.kind],
            }}
            title={`${seg.kind}: ${fmt(seg.tokens)} tokens`}
          />
        ))}
      </div>
      <div className="w-40 shrink-0 text-right text-[12px] leading-tight">
        <div className="tabular-nums">{fmt(headline)}</div>
        {onDemand > 0 && view === 'resident' && (
          <div
            className="text-[10px] text-gray-500"
            title="On-demand pool: skill bodies + the MEMORY.md body. Read/invoked when needed — NOT injected each session, so not in the resident headline."
          >
            + on-demand pool: {fmt(onDemand)}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentDrillDown({
  agent,
  model,
  openTab,
  view,
}: {
  agent: AgentContextOverhead;
  model: OverheadModel;
  openTab: ReturnType<typeof useDashboardStore.getState>['openTab'];
  view: DisclosureView;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  const openPath = (path: string) => {
    openTab(path, agent.workingDir, agent.pathType, agent.id, model.workspaceId);
  };
  const openSource = (s: OverheadSource) => {
    if (!s.openable || !s.resolvedPath) return;
    openPath(s.resolvedPath);
  };
  const openServer = (srv: McpServerOverhead) => {
    if (!srv.configPath) return;
    openPath(srv.configPath);
  };
  // "+ Add skill" — open the agent's skills dir so the user can drop in a new one.
  // Derived from an existing skill row's path when present (keeps separator style),
  // else composed from the working dir.
  const sep = agent.workingDir.includes('\\') ? '\\' : '/';
  const skillDir = `${agent.workingDir}${sep}.claude${sep}skills`;

  return (
    <div className="rounded border dark:border-white/10 light:border-black/10">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">{agent.name}</span>
        <span
          className="text-[11px] px-1.5 py-0.5 rounded bg-white/10 text-gray-300"
          title="Role lane — which built-in lane (or persona) this agent runs as; drives strict-mode MCP gating."
        >
          {agent.lane}
        </span>
        <span
          className="text-[11px] px-1.5 py-0.5 rounded bg-white/10 text-gray-300"
          title="Confidence of the token counts"
        >
          {agent.exactness}
        </span>
        <span
          className="ml-auto tabular-nums text-[12px]"
          title={`Resident (injected each session): ${fmt(agent.residentTotal?.tokens ?? agent.total.tokens)} · Worst case (resident + on-demand): ${fmt(agent.total.tokens)}`}
        >
          {fmt(headlineTokens(agent, view))} tok
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          {/* Resident vs on-demand, side by side (truthful accounting — Wave-2 §1). */}
          <div className="flex items-center gap-3 text-[11px] text-gray-400">
            <span title="Resident: everything injected into context each session (config + skill headers + MCP schemas). This is the truthful headline.">
              Resident (each session):{' '}
              <span className="tabular-nums text-gray-200">{fmt(agent.residentTotal?.tokens ?? agent.total.tokens)}</span>
            </span>
            <span title="On-demand pool: skill bodies + the MEMORY.md body. Read/invoked when needed — NOT injected each session.">
              + on-demand pool:{' '}
              <span className="tabular-nums text-gray-200">{fmt(onDemandTokens(agent))}</span>
            </span>
            <button
              onClick={() => openPath(skillDir)}
              className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 text-gray-300"
              title="Open this agent's .claude/skills/ directory to add or trim a skill"
            >
              <Plus size={12} /> Add skill
            </button>
          </div>

          {/* Inheritance chain */}
          <div className="space-y-1">
            {agent.inheritanceChain.map((frame, i) => (
              <FrameRow key={i} frame={frame} onOpen={openSource} onEdit={openSource} />
            ))}
          </div>

          {/* Config weight classification (§E5) */}
          {agent.configWeight && agent.configWeight.sections.length > 0 && (
            <ConfigWeightView
              rollup={agent.configWeight}
              title="Config — weight classification"
              onOpenPath={openPath}
            />
          )}

          {/* MCP servers */}
          {agent.mcpServers.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-gray-400">MCP tool schemas</div>
              {agent.mcpServers.map((srv) => (
                <McpRow key={srv.id} srv={srv} onOpen={openServer} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FrameRow({
  frame,
  onOpen,
  onEdit,
}: {
  frame: InheritanceFrame;
  onOpen: (s: OverheadSource) => void;
  onEdit: (s: OverheadSource) => void;
}): JSX.Element {
  return (
    <div className={frame.included ? '' : 'opacity-50'}>
      <div className="flex items-center gap-2 text-[11px] text-gray-400 py-0.5">
        <span className="px-1.5 py-0.5 rounded bg-white/5">{frame.scope}</span>
        <span>d={frame.distanceFromAgentCwd}</span>
        <span className="truncate" title={frame.dir}>{frame.dir}</span>
      </div>
      {frame.sources.map((s) => (
        <SourceRow key={s.id} source={s} depth={0} included={frame.included} onOpen={onOpen} onEdit={onEdit} />
      ))}
    </div>
  );
}

// Short, muted badge labels for the edit-safety class (§3.1).
const MUTABLE_BADGE: Record<OverheadSource['mutable'], { label: string; title: string }> = {
  'user-owned': { label: 'editable', title: 'User-owned — safe to edit directly.' },
  'scaffold-managed': { label: 'scaffold', title: 'Dashboard-scaffolded — edits here are overwritten on relaunch; change the source constant instead.' },
  'generated-vendor': { label: 'vendor', title: 'Generated/vendored — edit the source, not this file.' },
};

function SourceRow({
  source,
  depth,
  included,
  onOpen,
  onEdit,
}: {
  source: OverheadSource;
  depth: number;
  included: boolean;
  onOpen: (s: OverheadSource) => void;
  onEdit: (s: OverheadSource) => void;
}): JSX.Element {
  const dedup = (source.warnings ?? []).some((w) => w.toLowerCase().includes('dedup'));
  const clickable = source.openable && !!source.resolvedPath;
  const isSkillRow = source.kind === 'skill-header' || source.kind === 'skill-body';
  const isMemoryRow = source.kind === 'memory-index' || source.kind === 'memory-body';
  const isImportRow = source.kind === 'import';
  return (
    <>
      <div
        className={`flex items-center gap-2 py-0.5 group ${clickable ? 'cursor-pointer hover:bg-white/5 rounded' : ''} ${
          included && !dedup ? '' : 'opacity-50 line-through'
        }`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => clickable && onOpen(source)}
        title={source.resolvedPath ?? source.label}
      >
        <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: KIND_COLOR[source.kind] }} />
        {clickable && <FileText size={12} className="text-gray-400 shrink-0" />}
        <span className="truncate flex-1">{source.label}</span>
        {isSkillRow && source.disclosureState && (
          <span
            className="text-[10px] px-1 rounded bg-white/5 text-gray-400 shrink-0"
            title={
              source.disclosureState === 'advertised-header'
                ? 'Resident YAML header — advertised estimate (injection not yet validated).'
                : 'On-invoke body — scenario overlay (loads when the skill runs).'
            }
          >
            {source.disclosureState === 'advertised-header' ? 'header' : 'body'}
          </span>
        )}
        {isMemoryRow && (
          <span
            className="text-[10px] px-1 rounded bg-white/5 text-gray-400 shrink-0"
            title={
              source.kind === 'memory-index'
                ? 'MEMORY.md is read on demand; only the CLAUDE.md pointer is resident — body counted 0.'
                : `~${fmt(source.estimate.tokens)} tokens, read when the agent chooses — not injected each session.`
            }
          >
            {source.kind === 'memory-index' ? 'resident' : 'on-demand'}
          </span>
        )}
        {isImportRow && (
          <span
            className="text-[10px] px-1 rounded bg-white/5 text-gray-400 shrink-0"
            title="@import — a file inlined into its parent by an @path reference in the parent's markdown."
          >
            import
          </span>
        )}
        {source.resolvedPath && (
          <span
            className="text-[10px] px-1 rounded bg-white/5 text-gray-500 shrink-0"
            title={MUTABLE_BADGE[source.mutable].title}
          >
            {MUTABLE_BADGE[source.mutable].label}
          </span>
        )}
        {!source.exists && <span className="text-[10px] text-gray-500">missing</span>}
        <span className="tabular-nums text-[12px] text-gray-300">{fmt(source.estimate.tokens)}</span>
        {clickable && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(source); }}
            className="shrink-0 p-0.5 rounded text-gray-500 hover:text-gray-200 hover:bg-white/10 opacity-0 group-hover:opacity-100"
            title="Open in the editor to trim / edit"
          >
            <Pencil size={11} />
          </button>
        )}
      </div>
      {(source.children ?? []).map((c) => (
        <SourceRow key={c.id} source={c} depth={depth + 1} included={included} onOpen={onOpen} onEdit={onEdit} />
      ))}
    </>
  );
}

function McpRow({
  srv,
  onOpen,
}: {
  srv: McpServerOverhead;
  onOpen: (s: McpServerOverhead) => void;
}): JSX.Element {
  const clickable = !!srv.configPath;
  const [open, setOpen] = useState(false);
  // Per-tool drill-down: only servers that carry sourced per-tool detail are
  // expandable. Groups without tool detail (named-only servers) render exactly
  // as before — no chevron, identical markup.
  const hasTools = srv.tools.length > 0;
  // Descending by schema token cost, largest first. Copy before sorting so the
  // scan model's array is never mutated in place.
  const tools = hasTools
    ? [...srv.tools].sort((a, b) => b.estimate.tokens - a.estimate.tokens)
    : srv.tools;
  return (
    <div className={srv.excludedByStrictMode ? 'opacity-50' : ''}>
      <div
        className={`flex items-center gap-2 py-0.5 ${clickable ? 'cursor-pointer hover:bg-white/5 rounded' : ''}`}
        onClick={() => clickable && onOpen(srv)}
        title={srv.configPath ?? 'Discovered name only — schema requires a live MCP connection (not sourced).'}
      >
        {hasTools && (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
            className="shrink-0 -ml-0.5 p-0.5 rounded text-gray-400 hover:text-gray-200 hover:bg-white/10"
            title={open ? 'Hide per-tool schema costs' : 'Show per-tool schema costs'}
            aria-expanded={open}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        )}
        <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: MCP_COLOR }} />
        {clickable && <FileText size={12} className="text-gray-400 shrink-0" />}
        <span className="truncate flex-1">{srv.displayName}</span>
        {!srv.schemaSourced && (
          <span className="text-[10px] text-amber-400" title="Schema not sized — requires a live MCP connection.">⚠</span>
        )}
        {srv.excludedByStrictMode && (
          <span className="text-[10px] px-1 rounded bg-white/10 text-gray-400">strict-excluded</span>
        )}
        <span className="tabular-nums text-[12px] text-gray-300">{fmt(srv.total.tokens)}</span>
      </div>

      {hasTools && open && (
        <div className="space-y-0.5">
          {tools.map((t) => (
            <McpToolRow key={t.name} tool={t} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One MCP tool leaf under an expanded server/toolset group: tool name + its
 *  estimated schema token cost. Indented one level under the group row, matching
 *  the SourceRow child indent idiom (8 + depth*16 = 24px). */
function McpToolRow({ tool }: { tool: McpToolOverhead }): JSX.Element {
  return (
    <div
      className="flex items-center gap-2 py-0.5"
      style={{ paddingLeft: 8 + 16 }}
      title={`${tool.name} — ${fmt(tool.estimate.tokens)} schema tokens`}
    >
      <span className="w-2 h-2 rounded-sm shrink-0 opacity-60" style={{ backgroundColor: MCP_COLOR }} />
      <span className="truncate flex-1 text-gray-400">{tool.name}</span>
      <span className="tabular-nums text-[12px] text-gray-300">{fmt(tool.estimate.tokens)}</span>
    </div>
  );
}

// ── Legend (§E4): covers EVERY glyph the panel renders ────────────────────────

function Swatch({ color, sq = false }: { color: string; sq?: boolean }): JSX.Element {
  return <span className={`w-2 h-2 shrink-0 ${sq ? 'rounded-sm' : 'rounded-full'}`} style={{ backgroundColor: color }} />;
}

function LegendBadge({ text, title }: { text: string; title: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5" title={title}>
      <span className="text-[10px] px-1 rounded bg-white/10 text-gray-300">{text}</span>
      <span className="text-gray-400">{title}</span>
    </span>
  );
}

function Legend(): JSX.Element {
  const [open, setOpen] = useState(false);
  const kinds = Object.keys(KIND_COLOR) as OverheadSourceKind[];
  const scopes = Object.keys(SCOPE_LABEL) as InheritanceScope[];
  return (
    <div className="rounded border dark:border-white/10 light:border-black/10 text-[11px]">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/5">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="font-medium">Legend</span>
        <span className="text-gray-500">— what every color, badge, and number means</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-3 text-gray-400">
          <div>
            <div className="uppercase tracking-wide text-gray-500 mb-1">Source colors</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
              {kinds.map((k) => (
                <span key={k} className="flex items-center gap-1.5">
                  <Swatch color={KIND_COLOR[k]} sq /> <span>{KIND_LABEL[k]}</span>
                </span>
              ))}
              <span className="flex items-center gap-1.5">
                <Swatch color={MCP_COLOR} sq /> <span>MCP server tool-schema total</span>
              </span>
            </div>
          </div>

          <div>
            <div className="uppercase tracking-wide text-gray-500 mb-1">Disclosure-tier &amp; row badges</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
              <LegendBadge text="resident" title="Injected into context every session — counts toward the headline." />
              <LegendBadge text="on-demand" title="Read/invoked when needed — NOT injected each session; shown in a separate pool." />
              <LegendBadge text="header" title="Skill header — resident YAML frontmatter (baseline)." />
              <LegendBadge text="body" title="Skill body — on-invoke overlay (loads when the skill runs)." />
              <LegendBadge text="import" title="@import — a file inlined into its parent by an @path reference in the parent's markdown." />
              <LegendBadge text={MUTABLE_BADGE['user-owned'].label} title={MUTABLE_BADGE['user-owned'].title} />
              <LegendBadge text={MUTABLE_BADGE['scaffold-managed'].label} title={MUTABLE_BADGE['scaffold-managed'].title} />
              <LegendBadge text={MUTABLE_BADGE['generated-vendor'].label} title={MUTABLE_BADGE['generated-vendor'].title} />
              <LegendBadge text="missing" title="The referenced file was not found on disk." />
              <LegendBadge text="strict-excluded" title="This MCP server is not counted for this lane (strict mode) — counted as 0." />
              <LegendBadge text="⚠" title="Schema not sized — requires a live MCP connection." />
            </div>
          </div>

          <div>
            <div className="uppercase tracking-wide text-gray-500 mb-1">Chips &amp; numbers</div>
            <div className="space-y-0.5">
              <div><span className="text-gray-300">d={'{n}'}</span> — directory distance from the agent's cwd (0 = agent dir; negative = user/managed pseudo-frames).</div>
              <div><span className="text-gray-300">exactness</span> — confidence of the token counts: <em>exact</em> (live tokenizer), <em>mixed</em>, or <em>estimated</em> (proxy).</div>
              <div><span className="text-gray-300">lane chip</span> — the agent's role lane (supervisor / researcher / worker / persona); drives strict-mode MCP gating.</div>
              <div>
                <span className="text-gray-300">scope chips</span> —{' '}
                {scopes.map((s, i) => (
                  <span key={s}>{i > 0 ? ', ' : ''}<span className="text-gray-300">{s}</span> ({SCOPE_LABEL[s]})</span>
                ))}.
              </div>
              <div className="text-gray-500">Header note: “cl100k proxy; Claude tokenizer ~30% higher” — counts use the cl100k approximation; the real Claude tokenizer runs ~30% higher.</div>
            </div>
          </div>

          <div>
            <div className="uppercase tracking-wide text-gray-500 mb-1">Weight classification (config sections)</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
              {WEIGHT_CLASS_ORDER.map((c) => (
                <span key={c} className="flex items-center gap-1.5" title={WEIGHT_CLASS_TOOLTIP[c]}>
                  <Swatch color={WEIGHT_CLASS_COLOR[c]} sq />
                  <span className="text-gray-300">{WEIGHT_CLASS_LABEL[c]}</span>
                  <span>— {WEIGHT_CLASS_TOOLTIP[c]}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Config weight view (§E5): stacked bar + per-section list ───────────────────

function ConfigWeightView({
  rollup,
  title,
  onOpenPath,
}: {
  rollup: ConfigWeightRollup;
  title: string;
  onOpenPath: (path: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const total = WEIGHT_CLASS_ORDER.reduce((sum, c) => sum + (rollup.tokensByClass[c] ?? 0), 0);
  const barClasses = WEIGHT_CLASS_ORDER.filter((c) => (rollup.tokensByClass[c] ?? 0) > 0);

  return (
    <div className="rounded border dark:border-white/10 light:border-black/10">
      <div className="px-3 py-2 space-y-2">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="font-medium text-gray-200">{title}</span>
          <span className="text-gray-500">{fmt(total)} resident tokens · {rollup.sections.length} sections</span>
        </div>

        {/* Stacked bar */}
        <div className="h-3 rounded-sm overflow-hidden bg-white/5 flex">
          {barClasses.map((c) => (
            <div
              key={c}
              className="h-full"
              style={{ width: `${((rollup.tokensByClass[c] ?? 0) / Math.max(total, 1)) * 100}%`, backgroundColor: WEIGHT_CLASS_COLOR[c] }}
              title={`${WEIGHT_CLASS_LABEL[c]}: ${fmt(rollup.tokensByClass[c] ?? 0)} tokens — ${WEIGHT_CLASS_TOOLTIP[c]}`}
            />
          ))}
        </div>

        {/* Per-status totals (all six; live/dead render empty with a behavior-data note) */}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
          {WEIGHT_CLASS_ORDER.map((c) => {
            const behaviorOnly = c === 'live' || c === 'dead';
            return (
              <span key={c} className="flex items-center gap-1" title={WEIGHT_CLASS_TOOLTIP[c]}>
                <Swatch color={WEIGHT_CLASS_COLOR[c]} sq />
                <span className="text-gray-300">{WEIGHT_CLASS_LABEL[c]}</span>
                <span className="tabular-nums text-gray-400">{fmt(rollup.tokensByClass[c] ?? 0)}</span>
                {behaviorOnly && <span className="text-gray-600">(needs behavior data)</span>}
              </span>
            );
          })}
        </div>

        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? 'Hide' : 'Show'} sections
        </button>
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-0.5">
          {rollup.sections.map((sec, i) => (
            <ConfigSectionRow key={`${sec.sourcePath}:${sec.startLine}:${i}`} sec={sec} onOpenPath={onOpenPath} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigSectionRow({
  sec,
  onOpenPath,
}: {
  sec: ConfigSectionWeight;
  onOpenPath: (path: string) => void;
}): JSX.Element {
  const evidence = sec.evidence.length > 0 ? sec.evidence.join('; ') : 'no evidence recorded';
  return (
    <div
      className="flex items-center gap-2 py-0.5 text-[11px] cursor-pointer hover:bg-white/5 rounded"
      onClick={() => onOpenPath(sec.sourcePath)}
      title={`${sec.sourcePath} (lines ${sec.startLine}–${sec.endLine})`}
    >
      <Swatch color={WEIGHT_CLASS_COLOR[sec.weightClass]} sq />
      <FileText size={12} className="text-gray-400 shrink-0" />
      <span className="truncate flex-1 text-gray-300">
        {sec.heading}
        <span className="text-gray-600"> · {sec.sourceLabel}</span>
      </span>
      <span
        className="text-[10px] px-1 rounded bg-white/5 text-gray-400 shrink-0"
        title={evidence}
      >
        {WEIGHT_CLASS_LABEL[sec.weightClass]}
      </span>
      <span className="tabular-nums text-[12px] text-gray-300">{fmt(sec.tokens)}</span>
    </div>
  );
}
