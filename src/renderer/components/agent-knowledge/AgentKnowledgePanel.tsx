import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Brain, RefreshCw, AlertTriangle, ChevronRight, ChevronDown,
  Sparkles, Ban, Wrench, Database, ListOrdered, FileText, ExternalLink,
  HelpCircle, Scissors,
} from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type {
  AgentContextOverhead,
  AgentKnowledgeGraph,
  ExtractKnowledgeResult,
  KnowledgeNode,
  KnowledgeNodeType,
  KnowledgeSourceRole,
  KnowledgeBehaviorStatus,
  ScanOverheadResult,
} from '../../../shared/types';

// WP5 — the panel's organizing principle is now SOURCE ROLE (which CLAUDE.md /
// tool / memory a piece came from), because "the connection between CLAUDE.md and
// agent actions IS the product". Node type survives as a per-row badge + filter;
// behavior linkage (WP3) is the load-bearing-vs-stale signal on every row.

// Node-type badges. `workflow` is surfaced as "Procedures" (WP5 rename) — the
// internal type key is unchanged. Each carries a legend describing its classifier.
const TYPE_META: Record<KnowledgeNodeType, {
  label: string; icon: React.FC<{ size?: number; className?: string; style?: React.CSSProperties }>; color: string; legend: string;
}> = {
  capability: { label: 'Capability', icon: Sparkles, color: '#3b82f6',
    legend: 'A stated ability or affordance the agent has — a single fact, not an ordered process.' },
  constraint: { label: 'Constraint', icon: Ban, color: '#ef4444',
    legend: 'A rule or prohibition ("never…", "must…", "do not…") the agent is bound by.' },
  tool: { label: 'Tool', icon: Wrench, color: '#22c55e',
    legend: 'A named tool or MCP toolset the agent is told it can invoke.' },
  memory: { label: 'Memory', icon: Database, color: '#10b981',
    legend: 'A durable note from a MEMORY.md / behavioral.md surface.' },
  workflow: { label: 'Procedures', icon: ListOrdered, color: '#f59e0b',
    legend: 'Numbered steps and how-to / process headings — ordered instructions, not single facts.' },
  'file-reference': { label: 'File reference', icon: FileText, color: '#06b6d4',
    legend: 'A path or file the guidance points the agent at; touch counts show if it is actually used.' },
};

const TYPE_ORDER: KnowledgeNodeType[] = ['capability', 'constraint', 'tool', 'memory', 'workflow', 'file-reference'];

// WP2 — friendly, human-facing label per source role (distinct from InheritanceScope).
const ROLE_LABEL: Record<KnowledgeSourceRole, string> = {
  'agent-claude': 'Agent CLAUDE.md',
  'workspace-claude': 'Workspace CLAUDE.md',
  'ancestor-claude': 'Inherited CLAUDE.md',
  'user-claude': 'User global CLAUDE.md',
  'managed': 'Managed policy',
  'import': 'Imported',
  'skill': 'Skill',
  'mcp': 'MCP tool',
  'memory': 'MEMORY.md',
  'other': 'Other',
};

// WP5 — primary layout: source-role SECTIONS in a fixed, meaningful order.
interface Section { key: string; label: string; roles: KnowledgeSourceRole[] }
const SECTIONS: Section[] = [
  { key: 'agent', label: 'Agent CLAUDE.md', roles: ['agent-claude'] },
  { key: 'workspace', label: 'Workspace CLAUDE.md', roles: ['workspace-claude'] },
  { key: 'inherited', label: 'Inherited / Imported', roles: ['ancestor-claude', 'user-claude', 'managed', 'import'] },
  { key: 'tools', label: 'Tools & Skills', roles: ['skill', 'mcp'] },
  { key: 'memory', label: 'Memory', roles: ['memory'] },
  { key: 'other', label: 'Other', roles: ['other'] },
];

const STATUS_META: Record<KnowledgeBehaviorStatus, { label: string; color: string }> = {
  'observed': { label: 'observed', color: '#22c55e' },
  'never-observed': { label: 'never observed', color: '#f59e0b' },
  'insufficient-exposure': { label: 'not judgeable', color: '#6b7280' },
  'unobservable': { label: 'not judgeable', color: '#6b7280' },
};

function relTime(ms: number | null | undefined): string {
  if (ms == null) return 'never';
  const d = Date.now() - ms;
  if (d < 0) return 'just now';
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const dd = Math.floor(h / 24); if (dd < 30) return `${dd}d ago`;
  const mo = Math.floor(dd / 30); return `${mo}mo ago`;
}

// Sort within a section: never-observed by descending exposure (highest-value trim
// targets first), then observed by recency, then the rest (WP5 default sort).
function sortRank(n: KnowledgeNode): [number, number] {
  const st = n.behavior?.status;
  if (st === 'never-observed') return [0, -(n.behavior?.exposureTurns ?? 0)];
  if (st === 'observed') return [1, -(n.behavior?.lastObservedMs ?? 0)];
  return [2, 0];
}

interface Props {
  /** When opened per-agent (`params.agentId`) the picker preselects this agent. */
  initialAgentId?: string;
}

export default function AgentKnowledgePanel({ initialAgentId }: Props): JSX.Element {
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const openTab = useDashboardStore((s) => s.openTab);
  const openToolTab = useDashboardStore((s) => s.openToolTab);

  const [agents, setAgents] = useState<AgentContextOverhead[]>([]);
  const [agentId, setAgentId] = useState<string | undefined>(initialAgentId);
  const [graph, setGraph] = useState<AgentKnowledgeGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Filters (WP5).
  const [statusFilter, setStatusFilter] = useState<'all' | KnowledgeBehaviorStatus>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | KnowledgeSourceRole>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | KnowledgeNodeType>('all');

  // Populate the agent picker from the same overhead scan the tool grew out of.
  useEffect(() => {
    let cancelled = false;
    if (!selectedWorkspaceId) return;
    void (async () => {
      const res: ScanOverheadResult = await window.api.contextOverhead.scan({ workspaceId: selectedWorkspaceId });
      if (cancelled) return;
      if (res.ok) {
        setAgents(res.model.agents);
        setAgentId((cur) => cur ?? res.model.agents[0]?.id);
      } else {
        setError(res.error);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedWorkspaceId]);

  const selectedAgent = useMemo(() => agents.find((a) => a.id === agentId), [agents, agentId]);

  const extract = useCallback(async () => {
    if (!selectedWorkspaceId || !agentId) return;
    setLoading(true);
    setError(null);
    try {
      const res: ExtractKnowledgeResult = await window.api.agentKnowledge.extract({
        workspaceId: selectedWorkspaceId,
        agentId,
      });
      if (res.ok) setGraph(res.graph);
      else { setGraph(null); setError(res.error); }
    } catch (e) {
      setGraph(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedWorkspaceId, agentId]);

  useEffect(() => { void extract(); }, [extract]);

  // WP4 — open the source file in CodeMirror source mode, scrolled to and flashing
  // the exact node span. A repeat click re-fires via a fresh nonce.
  const openNode = useCallback((node: KnowledgeNode) => {
    if (!node.source.absPath || !selectedAgent) return;
    openTab(
      node.source.absPath, selectedAgent.workingDir, selectedAgent.pathType, selectedAgent.id,
      selectedWorkspaceId ?? undefined,
      { lineStart: node.source.lineStart, lineEnd: node.source.lineEnd, mode: 'source', nonce: Date.now() },
    );
  }, [openTab, selectedAgent, selectedWorkspaceId]);

  // WP5 cross-panel loop closure — jump to the optimizer for this agent's workspace.
  const suggestRemoval = useCallback(() => {
    openToolTab('context-optimizer', 'Context Optimizer',
      selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : undefined);
  }, [openToolTab, selectedWorkspaceId]);

  // Filter, then group by source-role section, then sort within each section.
  const filtered = useMemo(() => {
    const nodes = (graph?.nodes ?? []).filter((n) =>
      (statusFilter === 'all' || (n.behavior?.status ?? 'unobservable') === statusFilter) &&
      (roleFilter === 'all' || n.sourceRole === roleFilter) &&
      (typeFilter === 'all' || n.type === typeFilter),
    );
    return nodes;
  }, [graph, statusFilter, roleFilter, typeFilter]);

  const sectioned = useMemo(() => {
    const byKey = new Map<string, KnowledgeNode[]>();
    for (const s of SECTIONS) byKey.set(s.key, []);
    for (const n of filtered) {
      const sec = SECTIONS.find((s) => s.roles.includes(n.sourceRole)) ?? SECTIONS[SECTIONS.length - 1];
      byKey.get(sec.key)!.push(n);
    }
    for (const arr of byKey.values()) {
      arr.sort((a, b) => {
        const [ra, va] = sortRank(a); const [rb, vb] = sortRank(b);
        return ra !== rb ? ra - rb : va - vb;
      });
    }
    return byKey;
  }, [filtered]);

  const total = graph?.nodes.length ?? 0;

  return (
    <div className="h-full overflow-auto bg-surface-0 text-[13px]">
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2.5 bg-surface-0/95 backdrop-blur border-b dark:border-white/10 light:border-black/10">
        <Brain size={16} className="text-accent-blue-bright shrink-0" />
        <span className="font-medium">Agent Knowledge</span>
        <select
          value={agentId ?? ''}
          onChange={(e) => setAgentId(e.target.value || undefined)}
          className="text-[12px] bg-surface-1 border dark:border-white/10 light:border-black/10 rounded px-2 py-1 max-w-[240px]"
        >
          {agents.length === 0 && <option value="">No agents</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        {graph && (
          <span className="text-[11px] text-gray-400">
            {total} nodes · {graph.sourceFiles.length} sources · deterministic (no LLM)
          </span>
        )}
        <button
          onClick={() => void extract()}
          disabled={loading || !agentId}
          className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded text-[12px] hover:bg-white/10 disabled:opacity-50"
          title="Re-extract"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Explainer: the connection is the point. */}
        <div className="flex items-start gap-2 text-[11px] text-gray-500">
          <Brain size={13} className="mt-0.5 shrink-0" />
          <span>
            Every piece of guidance is grouped by <span className="text-gray-300">which CLAUDE.md / tool / memory</span>{' '}
            it comes from, and tagged with whether the agent's <span className="text-gray-300">behavior</span> actually
            shows it being used (last {30}d). Click any row to open the source at its exact lines. Amber “never observed”
            rows are candidates to trim — “Suggest removal →” hands them to the Context Optimizer.
          </span>
        </div>

        {/* Filters */}
        {graph && total > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <FilterSelect label="Status" value={statusFilter} onChange={(v) => setStatusFilter(v as typeof statusFilter)}
              options={[['all', 'All status'], ['observed', 'Observed'], ['never-observed', 'Never observed'],
                ['insufficient-exposure', 'Insufficient exposure'], ['unobservable', 'Unobservable']]} />
            <FilterSelect label="Source" value={roleFilter} onChange={(v) => setRoleFilter(v as typeof roleFilter)}
              options={[['all', 'All sources'], ...(Object.keys(ROLE_LABEL) as KnowledgeSourceRole[]).map((r) => [r, ROLE_LABEL[r]] as [string, string])]} />
            <FilterSelect label="Type" value={typeFilter} onChange={(v) => setTypeFilter(v as typeof typeFilter)}
              options={[['all', 'All types'], ...TYPE_ORDER.map((t) => [t, TYPE_META[t].label] as [string, string])]} />
            <span className="text-gray-500">{filtered.length} shown</span>
          </div>
        )}

        {loading && !graph && <div className="text-gray-400">Extracting…</div>}
        {error && (
          <div className="flex items-start gap-2 text-red-400">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>Extraction failed: {error}</span>
          </div>
        )}
        {graph && total === 0 && !loading && (
          <div className="text-gray-400">No knowledge nodes found for this agent's config surfaces.</div>
        )}
        {graph && total > 0 && (
          <>
            {SECTIONS.map((s) => (
              <RoleSection
                key={s.key}
                section={s}
                nodes={sectioned.get(s.key) ?? []}
                onOpen={openNode}
                onSuggestRemoval={suggestRemoval}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: [string, string][];
}): JSX.Element {
  return (
    <label className="flex items-center gap-1 text-gray-500">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-surface-1 border dark:border-white/10 light:border-black/10 rounded px-1.5 py-0.5 text-gray-300"
      >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function RoleSection({ section, nodes, onOpen, onSuggestRemoval }: {
  section: Section;
  nodes: KnowledgeNode[];
  onOpen: (n: KnowledgeNode) => void;
  onSuggestRemoval: () => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(true);
  if (nodes.length === 0) return null;
  const staleCount = nodes.filter((n) => n.behavior?.status === 'never-observed').length;
  return (
    <div className="ui-card overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">{section.label}</span>
        <span className="text-[11px] text-gray-400">{nodes.length}</span>
        {staleCount > 0 && (
          <span className="text-[10px] text-amber-400/90 px-1.5 py-0.5 rounded bg-amber-500/10">
            {staleCount} never observed
          </span>
        )}
      </button>
      {open && (
        <ul className="divide-y dark:divide-white/5 light:divide-black/5">
          {nodes.map((n, i) => (
            <NodeRow key={i} node={n} onOpen={onOpen} onSuggestRemoval={onSuggestRemoval} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NodeRow({ node, onOpen, onSuggestRemoval }: {
  node: KnowledgeNode;
  onOpen: (n: KnowledgeNode) => void;
  onSuggestRemoval: () => void;
}): JSX.Element {
  const meta = TYPE_META[node.type];
  const TypeIcon = meta.icon;
  const b = node.behavior;
  const fr = node.fileReferenceStats;
  const status = b?.status ?? (node.type === 'file-reference' ? undefined : 'unobservable');
  const isStale = status === 'never-observed';

  return (
    <li className="px-3 py-1.5">
      <div className="flex items-start gap-2 group">
        <button
          onClick={() => onOpen(node)}
          disabled={!node.source.absPath}
          className="flex-1 min-w-0 text-left flex items-start gap-2 hover:bg-white/5 rounded px-1 -mx-1 py-0.5 disabled:opacity-60 disabled:cursor-default"
          title={node.source.absPath ? `${node.source.absPath}:${node.source.lineStart}-${node.source.lineEnd}` : 'No source file'}
        >
          <TypeIcon size={13} style={{ color: meta.color }} className="shrink-0 mt-0.5" />
          <span className="flex-1 min-w-0">
            <span className="block truncate">{node.label}</span>
            {node.detail && <span className="block text-[11px] text-gray-400 truncate">{node.detail}</span>}
          </span>
          {node.source.absPath && (
            <ExternalLink size={12} className="shrink-0 mt-0.5 opacity-0 group-hover:opacity-70" />
          )}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-1 pl-6 text-[10px]">
        {/* node-type badge + legend */}
        <span className="inline-flex items-center gap-1 px-1 rounded bg-white/5 text-gray-400" title={meta.legend}>
          {meta.label}
          <HelpCircle size={9} className="opacity-50" />
        </span>
        {/* source chip (WP2) — disambiguates on hover by absPath */}
        <span className="px-1 rounded bg-white/5 text-gray-400" title={node.source.absPath || undefined}>
          {ROLE_LABEL[node.sourceRole]}
        </span>
        {/* behavior status (WP3/WP5) */}
        {status && <BehaviorBadge node={node} />}
        {/* file-reference r/w/x */}
        {fr && (
          <span className="px-1 rounded bg-white/5 text-gray-400 tabular-nums"
            title={`file touches in last ${fr.windowDays}d · ${fr.distinctStreams} streams · last ${relTime(fr.lastTouchedMs)}`}>
            r{fr.reads}/w{fr.writes}/x{fr.executes}
            {fr.touches > 0 && <span className="text-gray-500"> · {relTime(fr.lastTouchedMs)}</span>}
          </span>
        )}
        {isStale && (
          <button
            onClick={onSuggestRemoval}
            className="inline-flex items-center gap-1 px-1 rounded text-amber-400 hover:bg-amber-500/10"
            title="Open the Context Optimizer to review a removal for this lane"
          >
            <Scissors size={9} /> Suggest removal →
          </button>
        )}
      </div>
    </li>
  );
}

function BehaviorBadge({ node }: { node: KnowledgeNode }): JSX.Element {
  const b = node.behavior;
  const status = (b?.status ?? 'unobservable') as KnowledgeBehaviorStatus;
  const m = STATUS_META[status];
  let text = m.label;
  let tip = b?.explanation ?? '';
  if (status === 'observed' && b) {
    text = `used ${b.occurrences}× · ${relTime(b.lastObservedMs)}`;
    tip = tip || `A matching tool/skill/file predicate fired in this lane's corpus (last ${b.windowDays}d). Streams: ${b.distinctStreams}.`;
  } else if (status === 'never-observed' && b) {
    text = `0× in ${b.windowDays}d — possibly stale`;
    tip = tip || `Enough lane activity to judge (${b.exposureTurns} turns), but no matching behavior. Candidate for trim.`;
  } else if (status === 'insufficient-exposure') {
    tip = tip || 'Observable, but the lane has too little corpus to judge.';
  } else {
    tip = tip || 'No mechanical predicate (pure prose) — not judgeable from behavior.';
  }
  return (
    <span
      className="px-1 rounded tabular-nums"
      style={{ color: m.color, backgroundColor: m.color + '1f' }}
      title={tip}
    >
      {text}
    </span>
  );
}
