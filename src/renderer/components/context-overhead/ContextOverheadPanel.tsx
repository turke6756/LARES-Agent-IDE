import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, RefreshCw, FileText, AlertTriangle, ChevronRight, ChevronDown } from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type {
  AgentContextOverhead,
  InheritanceFrame,
  McpServerOverhead,
  OverheadModel,
  OverheadSource,
  OverheadSourceKind,
  ScanOverheadResult,
} from '../../../shared/types';

// Per-kind segment colors for the stacked bars + drill-down dots.
const KIND_COLOR: Record<OverheadSourceKind, string> = {
  'agent-claude': '#3b82f6',
  'inherited-claude': '#60a5fa',
  'claude-local': '#818cf8',
  'user-claude': '#a855f7',
  'managed-policy': '#ec4899',
  rules: '#f59e0b',
  memory: '#10b981',
  behavioral: '#14b8a6',
  'settings-hooks': '#6366f1',
  skill: '#22c55e',
  import: '#06b6d4',
  'mcp-tool-schema': '#ef4444',
  'system-baseline': '#64748b',
  unknown: '#9ca3af',
};

const MCP_COLOR = '#ef4444';

function fmt(n: number): string {
  return n.toLocaleString();
}

export default function ContextOverheadPanel(): JSX.Element {
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const openTab = useDashboardStore((s) => s.openTab);
  const [result, setResult] = useState<ScanOverheadResult | null>(null);
  const [loading, setLoading] = useState(false);

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
        {loading && !result && <div className="text-gray-400">Scanning…</div>}
        {result && !result.ok && (
          <div className="flex items-start gap-2 text-red-400">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>Scan failed: {result.error}</span>
          </div>
        )}
        {result?.ok && <ModelView model={result.model} openTab={openTab} />}
      </div>
    </div>
  );
}

function ModelView({
  model,
  openTab,
}: {
  model: OverheadModel;
  openTab: ReturnType<typeof useDashboardStore.getState>['openTab'];
}): JSX.Element {
  const maxTotal = Math.max(1, ...model.agents.map((a) => a.total.tokens));

  return (
    <>
      {/* Comparative chart */}
      <div className="space-y-2">
        {model.agents.map((agent) => (
          <ComparativeBar key={agent.id} agent={agent} maxTotal={maxTotal} />
        ))}
        {model.agents.length === 0 && (
          <div className="text-gray-400">No agents discovered in this workspace.</div>
        )}
      </div>

      {/* Per-agent drill-down */}
      <div className="space-y-3">
        {model.agents.map((agent) => (
          <AgentDrillDown key={agent.id} agent={agent} model={model} openTab={openTab} />
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

function segmentsFor(agent: AgentContextOverhead): Array<{ kind: OverheadSourceKind | 'mcp'; tokens: number }> {
  const byKind = new Map<OverheadSourceKind, number>();
  for (const s of agent.flatSources) {
    if (s.estimate.tokens <= 0) continue;
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

function ComparativeBar({ agent, maxTotal }: { agent: AgentContextOverhead; maxTotal: number }): JSX.Element {
  const segs = segmentsFor(agent);
  const widthPct = (agent.total.tokens / maxTotal) * 100;
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
              width: `${(seg.tokens / Math.max(agent.total.tokens, 1)) * 100}%`,
              backgroundColor: seg.kind === 'mcp' ? MCP_COLOR : KIND_COLOR[seg.kind],
            }}
            title={`${seg.kind}: ${fmt(seg.tokens)} tokens`}
          />
        ))}
      </div>
      <div className="w-20 shrink-0 text-right tabular-nums text-[12px]">{fmt(agent.total.tokens)}</div>
    </div>
  );
}

function AgentDrillDown({
  agent,
  model,
  openTab,
}: {
  agent: AgentContextOverhead;
  model: OverheadModel;
  openTab: ReturnType<typeof useDashboardStore.getState>['openTab'];
}): JSX.Element {
  const [open, setOpen] = useState(false);

  const openSource = (s: OverheadSource) => {
    if (!s.openable || !s.resolvedPath) return;
    openTab(s.resolvedPath, agent.workingDir, agent.pathType, agent.id, model.workspaceId);
  };
  const openServer = (srv: McpServerOverhead) => {
    if (!srv.configPath) return;
    openTab(srv.configPath, agent.workingDir, agent.pathType, agent.id, model.workspaceId);
  };

  return (
    <div className="rounded border dark:border-white/10 light:border-black/10">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">{agent.name}</span>
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-white/10 text-gray-300">{agent.lane}</span>
        <span
          className="text-[11px] px-1.5 py-0.5 rounded bg-white/10 text-gray-300"
          title="Confidence of the token counts"
        >
          {agent.exactness}
        </span>
        <span className="ml-auto tabular-nums text-[12px]">{fmt(agent.total.tokens)} tok</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          {/* Inheritance chain */}
          <div className="space-y-1">
            {agent.inheritanceChain.map((frame, i) => (
              <FrameRow key={i} frame={frame} onOpen={openSource} />
            ))}
          </div>

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
}: {
  frame: InheritanceFrame;
  onOpen: (s: OverheadSource) => void;
}): JSX.Element {
  return (
    <div className={frame.included ? '' : 'opacity-50'}>
      <div className="flex items-center gap-2 text-[11px] text-gray-400 py-0.5">
        <span className="px-1.5 py-0.5 rounded bg-white/5">{frame.scope}</span>
        <span>d={frame.distanceFromAgentCwd}</span>
        <span className="truncate" title={frame.dir}>{frame.dir}</span>
      </div>
      {frame.sources.map((s) => (
        <SourceRow key={s.id} source={s} depth={0} included={frame.included} onOpen={onOpen} />
      ))}
    </div>
  );
}

function SourceRow({
  source,
  depth,
  included,
  onOpen,
}: {
  source: OverheadSource;
  depth: number;
  included: boolean;
  onOpen: (s: OverheadSource) => void;
}): JSX.Element {
  const dedup = (source.warnings ?? []).some((w) => w.toLowerCase().includes('dedup'));
  const clickable = source.openable && !!source.resolvedPath;
  return (
    <>
      <div
        className={`flex items-center gap-2 py-0.5 ${clickable ? 'cursor-pointer hover:bg-white/5 rounded' : ''} ${
          included && !dedup ? '' : 'opacity-50 line-through'
        }`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => clickable && onOpen(source)}
        title={source.resolvedPath ?? source.label}
      >
        <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: KIND_COLOR[source.kind] }} />
        {clickable && <FileText size={12} className="text-gray-400 shrink-0" />}
        <span className="truncate flex-1">{source.label}</span>
        {!source.exists && <span className="text-[10px] text-gray-500">missing</span>}
        <span className="tabular-nums text-[12px] text-gray-300">{fmt(source.estimate.tokens)}</span>
      </div>
      {(source.children ?? []).map((c) => (
        <SourceRow key={c.id} source={c} depth={depth + 1} included={included} onOpen={onOpen} />
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
  return (
    <div className={srv.excludedByStrictMode ? 'opacity-50' : ''}>
      <div
        className={`flex items-center gap-2 py-0.5 ${clickable ? 'cursor-pointer hover:bg-white/5 rounded' : ''}`}
        onClick={() => clickable && onOpen(srv)}
        title={srv.configPath ?? 'Discovered name only — schema requires a live MCP connection (not sourced).'}
      >
        <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: MCP_COLOR }} />
        {clickable && <FileText size={12} className="text-gray-400 shrink-0" />}
        <span className="truncate flex-1">{srv.displayName}</span>
        {!srv.schemaSourced && (
          <span className="text-[10px] text-amber-400" title="Schema not sized">⚠</span>
        )}
        {srv.excludedByStrictMode && (
          <span className="text-[10px] px-1 rounded bg-white/10 text-gray-400">strict-excluded</span>
        )}
        <span className="tabular-nums text-[12px] text-gray-300">{fmt(srv.total.tokens)}</span>
      </div>
    </div>
  );
}
