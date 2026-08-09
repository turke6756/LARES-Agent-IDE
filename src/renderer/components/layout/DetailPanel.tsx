import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ListEnd, Zap, Hexagon, Search } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDashboardStore } from '../../stores/dashboard-store';
import StatusBadge from '../agent/StatusBadge';
import AgentStrip from '../agent/AgentStrip';
import { UsageGauge } from '../agent/agent-card-bits';
import DetailPaneContext from '../detail/DetailPaneContext';
import DetailPaneProducts from '../detail/DetailPaneProducts';
import ChatPane from '../detail/ChatPane';
import QueryDialog from '../agent/QueryDialog';
import CollapseButton from './CollapseButton';
import type { AgentProvider, PathType, ContextStats } from '../../../shared/types';
import { PROVIDER_META } from '../../../shared/constants';
import { loadStaging, saveStaging } from '../../lib/prompt-staging';
import { restartNeedsAttention, stopNeedsAttention } from './agent-control-emphasis';

const TABS = [
  { label: 'Context', icon: '\u{1F4D6}' },
  { label: 'Outputs', icon: '\u{1F4E6}' },
  { label: 'Chat', icon: '\u{1F4AC}' },
] as const;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      className="ui-btn ml-2 min-h-0 px-2 py-1 text-[12px]"
      title="Copy to clipboard"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '---';
  const d = new Date(dateStr + 'Z');
  return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

interface DetailPanelProps {
  width: number;
}

export default function DetailPanel({ width }: DetailPanelProps) {
  const { agents, selectedAgentId, terminalAgentId, detailPane, workspaces, contextStats, panelLayout } = useDashboardStore(
    useShallow((s) => ({
      agents: s.agents,
      selectedAgentId: s.selectedAgentId,
      terminalAgentId: s.terminalAgentId,
      detailPane: s.detailPane,
      workspaces: s.workspaces,
      contextStats: s.contextStats,
      panelLayout: s.panelLayout,
    })),
  );
  const setTerminalAgent = useDashboardStore((s) => s.setTerminalAgent);
  const setDetailPane = useDashboardStore((s) => s.setDetailPane);
  const togglePanelCollapsed = useDashboardStore((s) => s.togglePanelCollapsed);
  const usageLimits = useDashboardStore((s) => s.usageLimits);
  const [contextCount, setContextCount] = useState(0);
  const [productsCount, setProductsCount] = useState(0);
  const [showMeta, setShowMeta] = useState(false);
  const [showQuery, setShowQuery] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [stagingOpen, setStagingOpen] = useState(false);
  const [watchGlass, setWatchGlass] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const collapsed = panelLayout.detailPanelCollapsed;

  const agent = agents.find((a) => a.id === selectedAgentId);
  const workspace = agent ? workspaces.find((w) => w.id === agent.workspaceId) : null;
  const pathType: PathType = workspace?.pathType || 'windows';

  useEffect(() => {
    setRestartPending(false);
    setStopPending(false);
  }, [agent?.id]);

  useEffect(() => {
    if (agent?.status !== 'done' && agent?.status !== 'crashed') setRestartPending(false);
    if (agent?.status === 'done' || agent?.status === 'crashed') setStopPending(false);
  }, [agent?.status]);

  // Hydrate the prompt-staging open/closed toggle when the selected agent
  // changes. Slot contents are loaded inside PromptStaging itself.
  useEffect(() => {
    if (!agent) return;
    setStagingOpen(loadStaging(agent.id).open);
  }, [agent?.id]);

  const toggleStaging = useCallback(() => {
    if (!agent) return;
    setStagingOpen((prev) => {
      const next = !prev;
      const cur = loadStaging(agent.id);
      saveStaging(agent.id, { ...cur, open: next });
      return next;
    });
  }, [agent?.id]);

  // Click-outside handler for the legacy-controls overflow menu.
  useEffect(() => {
    if (!showOverflow) return;
    const onDocClick = (e: MouseEvent) => {
      if (!overflowRef.current) return;
      if (!overflowRef.current.contains(e.target as Node)) setShowOverflow(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showOverflow]);

  // Fetch counts for tab badges — gated on visibility so a collapsed pane stops polling.
  useEffect(() => {
    if (!agent || collapsed) return;

    const fetchCounts = async () => {
      const reads = await window.api.agents.getFileActivities(agent.id, 'read');
      const writes = await window.api.agents.getFileActivities(agent.id);
      const uniqueReads = new Set(reads.map((a) => a.filePath)).size;
      const uniqueWrites = new Set(
        writes.filter((a) => a.operation === 'write' || a.operation === 'create').map((a) => a.filePath)
      ).size;
      setContextCount(uniqueReads);
      setProductsCount(uniqueWrites);
    };

    fetchCounts();
    const interval = setInterval(fetchCounts, 5000);

    const unsub = window.api.agents.onFileActivity((activity) => {
      if (activity.agentId === agent.id) {
        if (activity.operation === 'read') setContextCount((c) => c + 1);
        else setProductsCount((c) => c + 1);
      }
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [agent?.id, collapsed]);

  // Collapsed detail panel: thin strip with expand button
  if (collapsed) {
    return (
      <div
        className="panel-shell flex flex-col items-center z-20 py-2"
        style={{ width }}
      >
        <CollapseButton collapsed direction="right" onClick={() => togglePanelCollapsed('detailPanelCollapsed')} />
        <div className="mt-2 text-[13px] font-sans text-accent-blue" style={{ writingMode: 'vertical-rl' }}>
          Details
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div
        className="panel-shell flex flex-col z-20 font-sans"
        style={{ width }}
      >
        <div className="panel-header flex items-center justify-between p-3">
          <h3 className="font-semibold text-[13px] text-gray-100">
            Agents
            {agents.length > 0 && <span className="ml-1.5 text-gray-500 font-normal">{agents.length}</span>}
          </h3>
          <CollapseButton collapsed={false} direction="right" onClick={() => togglePanelCollapsed('detailPanelCollapsed')} />
        </div>
        <div className="p-3 overflow-y-auto scrollbar-thin">
          <AgentStrip defaultExpanded />
        </div>
        <div className="flex-1 flex items-center justify-center text-gray-500 text-[12px] p-4">
          Select an agent to attach
        </div>
      </div>
    );
  }

  const isAttached = terminalAgentId === agent.id;
  const tabCounts = [contextCount, productsCount, null];
  const emphasizeRestart = restartNeedsAttention(agent.status, restartPending);
  const emphasizeStop = stopNeedsAttention(agent.status, stopPending);

  const restartAgent = () => {
    setRestartPending(true);
    void window.api.agents.restart(agent.id).catch(() => setRestartPending(false));
  };

  const stopAgent = () => {
    setStopPending(true);
    void window.api.agents.stop(agent.id).catch(() => setStopPending(false));
  };

  return (
    <div
      className="panel-shell flex flex-col font-sans relative z-20"
      style={{ width }}
    >

      {/* Agent info header */}
      <div className="panel-header p-3 relative overflow-hidden">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-0.5 min-w-0">
            <h3 className="font-semibold text-[13px] truncate text-gray-100">{agent.title}</h3>
            <button
              onClick={() => setShowMeta(!showMeta)}
              aria-pressed={showMeta}
              aria-label={showMeta ? 'Hide agent details' : 'Show agent details'}
              title={showMeta ? 'Hide agent details' : 'Show agent details'}
              className={`ui-btn ui-btn-ghost min-h-0 shrink-0 px-1.5 py-0.5 text-[12px] ${
                showMeta ? 'text-accent-blue' : 'text-gray-500'
              }`}
            >
              &#x24D8;
            </button>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <UsageGauge usage={usageLimits} />
            <StatusBadge status={agent.status} />
            <CollapseButton collapsed={false} direction="right" onClick={() => togglePanelCollapsed('detailPanelCollapsed')} />
          </div>
        </div>

        {/* Compressed dashboard agents — same order as the grid, expandable */}
        <AgentStrip />

        {showMeta && (
          <div className="mt-2 space-y-1 text-[13px] text-gray-400 bg-surface-0/40 border border-gray-800 p-2 font-sans">
            <div className="flex items-center justify-between border- dark:border-white/10 light:border-black/10 pb-1 mb-1">
               <span className="text-accent-blue">System Info</span>
            </div>
            <div className="flex">
              <span className="text-gray-500 w-16 shrink-0">Directory</span>
              <span className="truncate text-gray-200">{agent.workingDirectory}</span>
            </div>
            <div className="flex">
              <span className="text-gray-500 w-16 shrink-0">Command</span>
              <span className="truncate text-gray-200">{agent.command}</span>
            </div>
            <div className="flex">
              <span className="text-gray-500 w-16 shrink-0">Session</span>
              <span className="truncate text-gray-200">{agent.tmuxSessionName || 'N/A'}</span>
            </div>
            <div className="flex items-center">
              <span className="text-gray-400 w-16 shrink-0">ID</span>
              <span className="truncate text-gray-300">{agent.id}</span>
              <CopyButton text={agent.id} />
            </div>
            {agent.pid && (
              <div className="flex items-center">
                <span className="text-gray-400 w-16 shrink-0">PID</span>
                <span className="text-accent-green">{agent.pid}</span>
              </div>
            )}
            <div className="flex items-center">
              <span className="text-gray-400 w-16 shrink-0">Created</span>
              <span>{formatDate(agent.createdAt)}</span>
            </div>
            <div className="flex items-center">
              <span className="text-gray-400 w-16 shrink-0">Last Op</span>
              <span>{formatDate(agent.lastOutputAt)}</span>
            </div>
            {agent.resumeSessionId && (
              <div className="flex items-center pt-1 border- dark:border-white/10 light:border-black/10 mt-1">
                <span className="text-accent-purple w-16 shrink-0">Resume</span>
                <span className="truncate text-accent-purple">{agent.resumeSessionId}</span>
                <CopyButton text={agent.resumeSessionId} />
              </div>
            )}
          </div>
        )}

        {showMeta && contextStats[agent.id] && (() => {
          const cs = contextStats[agent.id];
          const pct = cs.contextPercentage;
          const pctColor = pct > 85 ? 'text-accent-red' : pct > 60 ? 'text-accent-orange' : 'text-accent-blue';
          const barColor = pct > 85 ? 'bg-accent-red' : pct > 60 ? 'bg-accent-orange' : 'bg-accent-blue';
          const barGlow = pct > 85 ? 'shadow-[0_0_6px_rgba(239,68,68,0.6)]' : '';
          const fmt = (n: number) => {
            if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
            if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
            return String(n);
          };
          return (
            <div className="mt-2 space-y-1 text-[13px] text-gray-400 bg-surface-0/40 border border-gray-800 p-2 font-sans">
              <div className="flex items-center justify-between border- dark:border-white/10 light:border-black/10 pb-1 mb-1">
                <span className="text-accent-blue">Context Window</span>
                <span className={`px-1 text-[13px] font-bold ${pctColor} border ${pct > 85 ? 'border-accent-red/50' : pct > 60 ? 'border-accent-orange/50' : 'border-accent-blue/50'}`}>
                  {pct}%
                </span>
              </div>
              <div className="w-full h-[2px] bg-gray-800 rounded-full overflow-hidden mb-1">
                <div className={`h-full ${barColor} ${barGlow} transition-all duration-500`} style={{ width: `${pct}%` }} />
              </div>
              <div className="flex items-center">
                <span className="text-gray-400 w-16 shrink-0">Model</span>
                <span className="text-gray-300">{cs.model}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-400 w-16 shrink-0">Input</span>
                <span className="text-gray-300">{fmt(cs.inputTokens)}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-400 w-20 shrink-0">Cache Write</span>
                <span className="text-gray-300">{fmt(cs.cacheCreationTokens)}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-400 w-20 shrink-0">Cache Read</span>
                <span className="text-gray-300">{fmt(cs.cacheReadTokens)}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-400 w-16 shrink-0">Output</span>
                <span className="text-gray-300">{fmt(cs.totalOutputTokens)}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-400 w-16 shrink-0">Turns</span>
                <span className="text-gray-300">{cs.turnCount}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-400 w-16 shrink-0">Window</span>
                <span className="text-gray-300">{fmt(cs.totalContextTokens)}/{fmt(cs.contextWindowMax)}</span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Controls */}
      <div className="panel-header flex items-stretch gap-1 p-2">
        <button
          onClick={toggleStaging}
          className={`ui-btn ui-btn-primary min-w-0 flex-1 px-2 py-2 text-[12px] font-bold ${stagingOpen ? 'is-active' : ''}`}
          aria-pressed={stagingOpen}
          title="Prompt Staging"
        >
          <ListEnd size={13} className="shrink-0" />
          <span className="truncate">Prompt Staging</span>
        </button>
        <button
          onClick={restartAgent}
          className={`ui-btn ui-btn-ghost min-w-0 flex-1 px-2 py-2 text-[12px] font-bold ${
            emphasizeRestart ? 'text-accent-yellow' : 'text-gray-500'
          }`}
          title="Restart"
        >
          <Zap size={13} className="shrink-0" />
          <span className="truncate">Restart</span>
        </button>
        <button
          onClick={stopAgent}
          className={`ui-btn ui-btn-ghost min-w-0 flex-1 px-2 py-2 text-[12px] font-bold ${
            emphasizeStop ? 'text-accent-red' : 'text-gray-500'
          }`}
          title="Stop"
        >
          <Hexagon size={13} className="shrink-0" />
          <span className="truncate">Stop</span>
        </button>
        <button
          onClick={() => setWatchGlass((v) => !v)}
          aria-pressed={watchGlass}
          className={`ui-btn min-w-0 flex-1 px-2 py-2 text-[12px] font-bold ${
            watchGlass ? 'bg-accent-blue/20 text-accent-blue' : 'ui-btn-ghost text-accent-blue/80'
          }`}
          title="Watch Glass"
        >
          <Search size={13} className="shrink-0" />
          <span className="truncate">Watch Glass</span>
        </button>
        <div ref={overflowRef} className="relative">
          <button
            onClick={() => setShowOverflow((v) => !v)}
            aria-label="More agent actions"
            aria-haspopup="menu"
            aria-expanded={showOverflow}
            className="ui-btn ui-btn-ghost px-2 py-2 text-[15px] font-bold leading-none"
          >
            &#x22EF;
          </button>
          {showOverflow && (
            <div
              role="menu"
              className="absolute right-0 mt-1 w-48 z-30 border border-gray-800 bg-surface-1 shadow-lg py-1"
            >
              <button
                role="menuitem"
                onClick={() => {
                  setShowOverflow(false);
                  setTerminalAgent(isAttached ? null : agent.id);
                }}
                className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-surface-2 ${
                  isAttached ? 'text-accent-green' : 'text-accent-green/80'
                }`}
              >
                {isAttached ? 'Detach Terminal' : 'Attach Terminal'}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setShowOverflow(false);
                  setShowQuery(true);
                }}
                disabled={!agent.resumeSessionId}
                className="w-full text-left px-3 py-1.5 text-[13px] text-accent-purple disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-2"
              >
                Query Agent
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex bg-surface-0 border-b border-surface-3">
        {TABS.map((tab, index) => (
          <button
            key={tab.label}
            onClick={() => setDetailPane(index as 0 | 1 | 2)}
            className={`ui-tab flex-1 justify-center ${detailPane === index ? 'ui-tab-active' : ''}`}
          >
            <span>{tab.label}</span>
            {tabCounts[index] !== null && tabCounts[index]! > 0 && (
              <span className={`ml-1 text-[11px] ${detailPane === index ? 'text-accent-blue' : 'text-gray-600'}`}>
                {tabCounts[index]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Active pane */}
      <div className="flex-1 overflow-hidden flex flex-col relative">
        {detailPane === 0 && <DetailPaneContext agentId={agent.id} pathType={pathType} />}
        {detailPane === 1 && <DetailPaneProducts agentId={agent.id} pathType={pathType} />}
        {detailPane === 2 && (
          <ChatPane
            agentId={agent.id}
            agentStatus={agent.status}
            agentName={agent.title}
            stagingOpen={stagingOpen}
            watchGlass={watchGlass}
          />
        )}
      </div>

      {/* Query dialog */}
      {showQuery && agent && (
        <QueryDialog sourceAgent={agent} onClose={() => setShowQuery(false)} />
      )}
    </div>
  );
}
