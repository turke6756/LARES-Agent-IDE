import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import type { Agent } from '../../../shared/types';
import StatusBadge from './StatusBadge';
import { formatAgentToken } from '../../lib/agent-mention';
import { RoleChips, ContextStatsBar } from './agent-card-bits';
import ContinuationSplitButton from './ContinuationSplitButton';
import { isContinuationEligible } from './continuation-controls';
import { PROVIDER_META } from '../../../shared/constants';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useCursorMenuPosition } from '../../lib/floating/useCursorMenuPosition';

function getDisplayDirectory(agent: Agent): string {
  const dir = agent.workingDirectory.replace(/\\/g, '/');
  const stripped = agent.isSupervisor
    ? dir.replace(/\/\.claude\/agents\/[^/]+$/, '')
    : dir;
  return stripped.split('/').filter(Boolean).pop() || stripped;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'NEVER';
  const diff = Date.now() - new Date(dateStr + 'Z').getTime();
  if (diff < 60_000) return 'NOW';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}M AGO`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}H AGO`;
  return `${Math.floor(diff / 86400_000)}D AGO`;
}

function formatSpawnTime(dateStr: string): string {
  const d = new Date(dateStr + 'Z');
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const BORDER_COLORS: Record<string, string> = {
  working: 'border-l-accent-green',
  idle: 'border-l-accent-blue',
  waiting: 'border-l-accent-orange',
  crashed: 'border-l-accent-red',
  launching: 'border-l-accent-yellow',
  restarting: 'border-l-accent-yellow',
  done: 'border-l-gray-600',
};

export default function AgentCard({
  agent,
  onTeam,
  unread = false,
  multiSelected = false,
  selectionCount = 0,
  onCardClick,
  onDeleteSelected,
}: {
  agent: Agent;
  onTeam?: (agentId: string) => void;
  /** Finished (working→idle) and not yet viewed — renders a blue ring until clicked. */
  unread?: boolean;
  /** Part of the shift+click multi-selection — renders a purple ring. */
  multiSelected?: boolean;
  /** Size of the current multi-selection (for the context-menu label). */
  selectionCount?: number;
  /** Notifies the grid of clicks so it can clear unread / toggle selection. */
  onCardClick?: (agentId: string, shiftKey: boolean) => void;
  /** Deletes every agent in the current multi-selection. */
  onDeleteSelected?: () => void;
}) {
  // Each card subscribes only to its own agent's slice of contextStats —
  // a sibling agent's status update won't re-render this card.
  const isSelected = useDashboardStore((s) => s.selectedAgentId === agent.id);
  const isTerminalActive = useDashboardStore((s) => s.terminalAgentId === agent.id);
  // Gold "snake" border while this agent is mid context-brick continuation transfer.
  const transferring = useDashboardStore((s) => s.continuationTransferIds.has(agent.id));
  const cs = useDashboardStore((s) => s.contextStats[agent.id] ?? null);
  const selectAgent = useDashboardStore((s) => s.selectAgent);
  const setTerminalAgent = useDashboardStore((s) => s.setTerminalAgent);
  const deleteAgent = useDashboardStore((s) => s.deleteAgent);
  const forkAgent = useDashboardStore((s) => s.forkAgent);
  const queryAgent = useDashboardStore((s) => s.queryAgent);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
  const [forking, setForking] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [dragQuery, setDragQuery] = useState<{ sourceId: string } | null>(null);
  const [dragQueryText, setDragQueryText] = useState('');
  const [dragQueryResult, setDragQueryResult] = useState<string | null>(null);
  const [dragQuerying, setDragQuerying] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPosition = useCursorMenuPosition(menuRef, contextMenu, { width: 230, height: 190 }, confirmDeleteSelected);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.api.agents.getContextStats(agent.id).then(stats => {
      if (stats) {
        useDashboardStore.getState().updateContextStats(stats);
      }
    });
  }, [agent.id]);

  const borderColor = BORDER_COLORS[agent.status] || 'border-l-gray-600';

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  useEffect(() => {
    if (!dragQuery) return;
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        closeDragQuery();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDragQuery();
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [dragQuery]);

  const closeDragQuery = () => {
    setDragQuery(null);
    setDragQueryText('');
    setDragQueryResult(null);
    setDragQuerying(false);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await deleteAgent(agent.id);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirmDeleteSelected(false);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const [forkError, setForkError] = useState<string | null>(null);

  const handleFork = async () => {
    setContextMenu(null);
    setForking(true);
    setForkError(null);
    const result = await forkAgent(agent.id);
    setForking(false);
    if (!result) {
      setForkError('Fork failed — check console for details');
      setTimeout(() => setForkError(null), 5000);
    }
  };

  const handleToggleSupervised = async () => {
    setContextMenu(null);
    try {
      await window.api.agents.updateSupervised(agent.id, !agent.isSupervised);
      const { loadAgents } = useDashboardStore.getState();
      await loadAgents(agent.workspaceId);
    } catch (err) {
      console.error('Failed to toggle supervised:', err);
    }
  };

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    // Always draggable: every card can be dropped into a chat input to
    // mention the agent. The card-to-card query flow stays gated on
    // resumeSessionId via the text/agentId key below.
    el.setAttribute('draggable', 'true');

    const onDragStart = (e: DragEvent) => {
      // A shift-click with a few pixels of mouse travel must toggle the
      // multi-selection, not start a card drag.
      if (e.shiftKey) {
        e.preventDefault();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest('button, textarea, input, a')) {
        e.preventDefault();
        return;
      }
      // Card-to-card inter-agent query payload (requires a resumable session).
      if (agent.resumeSessionId) {
        e.dataTransfer?.setData('text/agentId', agent.id);
      }
      // Chat-input payload — mirrors the file-drag convention in
      // utils/drag-file.ts (dedicated MIME key + text/plain fallback). The
      // text/plain fallback uses the shared full-id token (formatAgentToken) so
      // the drag and "@"-mention paths emit exactly one format.
      e.dataTransfer?.setData(
        'application/x-agent-card',
        JSON.stringify({ id: agent.id, title: agent.title, provider: agent.provider || 'claude' }),
      );
      e.dataTransfer?.setData('text/plain', formatAgentToken(agent));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    };

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('text/agentid')) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }
    };

    const onDragLeave = () => setDragOver(false);

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const sourceId = e.dataTransfer?.getData('text/agentId');
      if (sourceId && sourceId !== agent.id && agent.resumeSessionId && (agent.provider || 'claude') === 'claude') {
        setDragQuery({ sourceId });
      }
    };

    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);

    return () => {
      el.removeEventListener('dragstart', onDragStart);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDrop);
    };
  }, [agent.id, agent.resumeSessionId, agent.title, agent.provider]);

  const handleDragQuerySubmit = async () => {
    if (!dragQueryText.trim() || !dragQuery) return;
    setDragQuerying(true);
    const result = await queryAgent(agent.id, dragQueryText.trim(), dragQuery.sourceId);
    setDragQuerying(false);
    setDragQueryResult(result?.result || 'No response');
  };

  return (
    <motion.div
      ref={cardRef}
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      whileHover={{ y: -3, transition: { duration: 0.15, ease: 'easeOut' } }}
      className={`ui-card agent-card relative p-3 cursor-pointer group
        border-l-[3px] ${isSelected ? borderColor : 'border-l-transparent'}
        ${isSelected ? 'agent-card-selected' : 'hover:bg-white/[0.03]'}
        ${isTerminalActive ? 'bg-accent-blue/[0.06] border-l-accent-blue' : ''}
        ${agent.status === 'working' ? 'bg-accent-green/[0.03]' : ''}
        ${dragOver ? 'bg-accent-purple/[0.06] border-l-accent-purple' : ''}
        ${multiSelected ? 'agent-card-multiselected' : unread ? 'agent-card-unread' : ''}
        ${transferring ? 'agent-transfer-glow' : ''}
      `}
      onMouseDown={(e) => {
        // Shift+click toggles multi-selection here, on mousedown: the card is
        // draggable, and Chromium treats shift+mousedown on draggable content
        // as a selection gesture, so the subsequent `click` never reliably
        // fires. preventDefault also stops the text-selection sweep.
        if (e.shiftKey && e.button === 0) {
          e.preventDefault();
          onCardClick?.(agent.id, true);
        }
      }}
      onClick={(e) => {
        if (e.shiftKey) return; // multi-selection handled on mousedown
        onCardClick?.(agent.id, false);
        selectAgent(agent.id);
      }}
      onDoubleClick={() => setTerminalAgent(agent.id)}
      onContextMenu={handleContextMenu}
    >
      {/* Header */}
      <div className="mb-2 relative z-10">
        {/* Row 1: id + role chips (left), status + delete (right) */}
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] text-gray-500 font-mono shrink-0">#{agent.id.substring(0,6)}</span>
            {/* Role / supervised / elevated chips — shared with OwnerContainerBar. */}
            <RoleChips agent={agent} />
          </div>

          <div className="flex items-center gap-2 shrink-0">
             {forking && <span className="text-[11px] text-accent-purple animate-pulse font-semibold">FORKING...</span>}
             {forkError && <span className="text-[11px] text-accent-red font-semibold">{forkError}</span>}
             {/* Context-brick continuation control — claude-provider supervisors only. */}
             {isContinuationEligible(agent) && <ContinuationSplitButton agent={agent} />}
             <StatusBadge status={agent.status} />

             {!confirmDelete && (
              <button
                onClick={handleDelete}
                className="ui-btn ui-btn-danger opacity-0 group-hover:opacity-100 min-h-0 px-1.5 py-1 text-gray-500 hover:text-accent-red"
                title="Terminate Agent"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
                  <path d="M1 1L9 9M9 1L1 9" strokeWidth="2" />
                </svg>
              </button>
             )}
          </div>
        </div>

        {/* Row 2: provider + title — full card width so long titles don't truncate early */}
        <div className="flex items-center gap-1.5 min-w-0">
          {(() => {
            const meta = PROVIDER_META[agent.provider || 'claude'];
            return (
              <span className={`text-[11px] font-semibold px-1.5 py-0.5 shrink-0 ${meta.bgClass} ${meta.textClass}`}>
                {meta.label}
              </span>
            );
          })()}
          <h4 className={`font-semibold text-[13px] truncate ${isSelected ? 'text-accent-blue' : 'text-gray-200 group-hover:text-gray-100'}`} title={agent.title}>
            {agent.title}
          </h4>
        </div>
      </div>

      {confirmDelete && (
        <div className="absolute inset-0 bg-surface-1/95 z-20 flex items-center justify-center flex-col p-4 border border-accent-red">
          <span className="text-accent-red font-semibold text-[13px] mb-3">Stop this agent?</span>
          <div className="flex gap-3">
            <button
              onClick={handleDelete}
              className="ui-btn ui-btn-danger px-4 py-1.5 text-[13px] font-semibold border-accent-red"
            >
              Confirm
            </button>
            <button
              onClick={handleCancelDelete}
              className="ui-btn ui-btn-ghost px-4 py-1.5 text-[13px] font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Role / Output Preview */}
      <div className="mb-2 h-14 relative overflow-hidden log-surface border border-surface-3 p-2 text-[12px]">
        {agent.roleDescription ? (
           <p className="line-clamp-3 leading-tight">&gt; {agent.roleDescription}</p>
        ) : (
           <p className="opacity-40 italic">No role assigned</p>
        )}
      </div>

      {/* Context Stats Bar — all providers emit usage events (claude jsonl,
          codex rollout token_count, gemini transcript); render whenever stats exist. */}
      {cs && <ContextStatsBar cs={cs} />}

      {/* Footer Meta */}
      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <div className="flex items-center gap-2">
            <span className="truncate max-w-[100px]" title={agent.workingDirectory}>
            ...{getDisplayDirectory(agent)}
            </span>
            {agent.restartCount > 0 && (
                <span className="text-accent-orange">Restarts: {agent.restartCount}</span>
            )}
        </div>
        <span className={isSelected ? 'text-accent-blue' : ''}>
            Active: {timeAgo(agent.lastOutputAt || agent.createdAt)}
        </span>
      </div>
      <div className="text-[11px] text-gray-500 mt-0.5">
        Spawned: {formatSpawnTime(agent.createdAt)}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="ui-menu fixed z-50"
          style={{ left: menuPosition.left, top: menuPosition.top, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }}
        >
          <div className="ui-menu-header">
             Agent Actions
          </div>
          <button
            onClick={handleFork}
            disabled={!agent.resumeSessionId || (agent.provider || 'claude') !== 'claude'}
            className="ui-menu-item"
          >
            Fork Agent {(agent.provider || 'claude') !== 'claude' ? '(Claude only)' : !agent.resumeSessionId ? '(no session)' : ''}
          </button>
          <button
            onClick={handleToggleSupervised}
            className="ui-menu-item"
          >
            {agent.isSupervised ? 'Disable Supervision' : 'Enable Supervision'}
          </button>
          {onTeam && !agent.isSupervisor && !['done', 'crashed'].includes(agent.status) && (
            <button
              onClick={() => { setContextMenu(null); onTeam(agent.id); }}
              className="ui-menu-item"
            >
              Create Team
            </button>
          )}
          {multiSelected && onDeleteSelected && selectionCount > 0 && (
            <button
              onClick={(e) => {
                // Don't bubble to the card's onClick — a plain card click
                // clears the multi-selection, which would cancel the delete.
                e.stopPropagation();
                if (!confirmDeleteSelected) {
                  setConfirmDeleteSelected(true);
                  return;
                }
                setContextMenu(null);
                setConfirmDeleteSelected(false);
                onDeleteSelected();
              }}
              className="ui-menu-item text-accent-red"
            >
              {confirmDeleteSelected
                ? `Confirm delete ${selectionCount} agent${selectionCount === 1 ? '' : 's'}`
                : `Delete all selected (${selectionCount})`}
            </button>
          )}
        </div>
      )}

      {/* Drag-to-query popover */}
      {dragQuery && (
        <div
          ref={popoverRef}
          className="panel-shell absolute inset-0 z-30 border-accent-purple p-3 flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[11px] text-accent-purple mb-2 font-semibold uppercase tracking-wider">Inter-Agent Query</div>
          <textarea
            value={dragQueryText}
            onChange={(e) => setDragQueryText(e.target.value)}
            placeholder="Ask this agent a question..."
            className="ui-textarea w-full resize-none flex-1 text-[13px]"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleDragQuerySubmit();
              }
            }}
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleDragQuerySubmit}
              disabled={dragQuerying || !dragQueryText.trim()}
              className="ui-btn ui-btn-purple flex-1 py-1 text-[13px] font-semibold border-accent-purple/40"
            >
              {dragQuerying ? 'Sending...' : 'Send'}
            </button>
            <button
              onClick={closeDragQuery}
              className="ui-btn ui-btn-ghost px-2 py-1 text-[13px]"
            >
              Cancel
            </button>
          </div>
          {dragQueryResult && (
            <div className="mt-2 p-2 bg-surface-0 border-t border-accent-purple/30 text-[13px] text-gray-300 max-h-24 overflow-y-auto whitespace-pre-wrap">
              {dragQueryResult}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
