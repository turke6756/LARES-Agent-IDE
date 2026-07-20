import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentCard from './AgentCard';
import OwnerContainerBar from './OwnerContainerBar';
import TeamDialog from '../team/TeamDialog';
import { buildAgentForest, isOwnerContainer, hasActiveDescendant, collectSubtreeIds, type AgentTreeNode } from './agent-grouping';
import { useOwnerExpand, pruneOwnerExpandKeys } from '../../hooks/useOwnerExpand';
import { BULK_STOP_MAX, type BulkStopResult } from '../../../shared/types';
import { summarizeStopExclusions } from '../../lib/stop-exclusion-copy';

// Per-card props that are identical at every depth of the ownership forest —
// threaded through the recursive renderer so a nested child behaves exactly
// like a top-level card (selection, unread ring, context menu, etc.).
interface NodeContext {
  unreadIds: Set<string>;
  selectedIds: Set<string>;
  selectionCount: number;
  onTeam: (agentId: string) => void;
  onCardClick: (agentId: string, shiftKey: boolean) => void;
  onDeleteSelected: () => void;
}

// Render one owner subtree. A childless node is just its card — so the common
// (no-ownership) case is byte-for-byte the flat grid it was before. An owner
// node (≥1 child) renders as a full-width band: an OwnerContainerBar header above
// a bordered, scroll-bounded region holding its children, mapped recursively (a
// nested owner becomes a dimmer sub-band). `depth` attenuates nested accents.
function AgentNode({ node, ctx, depth }: { node: AgentTreeNode; ctx: NodeContext; depth: number }) {
  if (isOwnerContainer(node)) {
    return <OwnerContainerNode node={node} ctx={ctx} depth={depth} />;
  }
  return (
    <AgentCard
      agent={node.agent}
      onTeam={ctx.onTeam}
      unread={ctx.unreadIds.has(node.agent.id)}
      multiSelected={ctx.selectedIds.has(node.agent.id)}
      selectionCount={ctx.selectionCount}
      onCardClick={ctx.onCardClick}
      onDeleteSelected={ctx.onDeleteSelected}
    />
  );
}

// Owner-container: the bar + (when expanded) the bordered children region. Split
// into its own component so `useOwnerExpand` is called unconditionally (a childless
// node never reaches here, so the hook order stays stable). The wrapper has NO
// onClick — bar, collapse toggle, and each child card carry their own handlers.
function OwnerContainerNode({ node, ctx, depth }: { node: AgentTreeNode; ctx: NodeContext; depth: number }) {
  const { agent, children } = node;
  const [expanded, toggle] = useOwnerExpand(agent.id, children.length);
  const deleteAgent = useDashboardStore((s) => s.deleteAgent);
  // Every agent removed when this bar is deleted: the supervisor + all it owns,
  // at any nesting depth. Memoized so the bar's cascade label/count stay stable.
  const subtreeIds = useMemo(() => collectSubtreeIds(node), [node]);
  const handleDeleteCascade = useCallback(async () => {
    // Owned agents first (owner-first list reversed → deepest/children first),
    // supervisor last, so removing the owner can't momentarily orphan a child.
    for (const id of [...subtreeIds].reverse()) {
      await deleteAgent(id);
    }
  }, [subtreeIds, deleteAgent]);
  // True while this owner is running a groupthink (or other orchestration)
  // deliberation. A deliberation has idle gaps between turns where BOTH planner
  // agents are momentarily idle yet the run is still alive — without this the
  // descendant-status pulse below would flicker off during those gaps. Selected
  // as a boolean so this node only re-renders when its own deliberation flag
  // flips, not on every set change.
  const deliberating = useDashboardStore((s) => s.deliberatingSupervisorIds.includes(agent.id));
  // Pulse the border whenever something this owner owns is busy — the at-a-glance
  // signal that survives the bar being collapsed (the default) and this owner
  // itself being idle — OR while a deliberation it owns is mid-flight.
  const childrenActive = hasActiveDescendant(node) || deliberating;
  return (
    <div className="flex flex-col">
      <OwnerContainerBar
        agent={agent}
        childCount={children.length}
        expanded={expanded}
        onToggle={toggle}
        depth={depth}
        unread={ctx.unreadIds.has(agent.id)}
        multiSelected={ctx.selectedIds.has(agent.id)}
        childrenActive={childrenActive}
        onCardClick={ctx.onCardClick}
        onDeleteCascade={handleDeleteCascade}
        cascadeCount={subtreeIds.length}
      />
      {expanded && (
        // Flush under the bar (no top margin, shared side borders, square top
        // corners) so the owned-agents region reads as one container hanging off
        // the supervisor bar rather than a detached box. Faint blue tint echoes
        // the bar's fill to reinforce the "same band" grouping.
        <div className="max-h-[420px] overflow-y-auto grid grid-cols-2 gap-2 border border-t-0 border-surface-3 rounded-b p-2 bg-accent-blue/[0.04]">
          {children.map((child) => (
            <div key={child.agent.id} className={isOwnerContainer(child) ? 'col-span-2' : undefined}>
              <AgentNode node={child} ctx={ctx} depth={depth + 1} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AgentGrid() {
  const { agents, selectedWorkspaceId } = useDashboardStore();
  const deleteAgent = useDashboardStore((s) => s.deleteAgent);
  const [teamDialogAgentId, setTeamDialogAgentId] = useState<string | null>(null);
  // Agents that finished (working→idle) and haven't been clicked yet.
  // Local to this always-mounted container — intentionally NOT in the store.
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  // Shift+click multi-selection, also local.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Two-step confirm for the bulk-action bar.
  const [confirmBulk, setConfirmBulk] = useState(false);
  // Stop-selected (§B8) keeps its OWN confirm latch. Sharing one with delete
  // would let a click that armed "delete" fire a stop (or the reverse) — two
  // different destructive actions must never share a confirmation.
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopResult, setStopResult] = useState<BulkStopResult | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  // Detect working→idle transitions and mark those agents unread.
  useEffect(() => {
    const prev = prevStatusRef.current;
    const next = new Map<string, string>();
    const finished: string[] = [];
    for (const a of agents) {
      next.set(a.id, a.status);
      if (prev.get(a.id) === 'working' && a.status === 'idle') finished.push(a.id);
    }
    prevStatusRef.current = next;

    // Prune ids for agents that no longer exist, and add newly finished ones.
    const liveIds = new Set(agents.map((a) => a.id));
    // GC persisted owner-expand prefs the same way (keyed on ephemeral agent ids,
    // so they'd otherwise accumulate in localStorage as agents come and go).
    pruneOwnerExpandKeys(liveIds);
    setUnreadIds((cur) => {
      let changed = false;
      const out = new Set<string>();
      for (const id of cur) {
        if (liveIds.has(id)) out.add(id);
        else changed = true;
      }
      for (const id of finished) {
        if (!out.has(id)) {
          out.add(id);
          changed = true;
        }
      }
      return changed ? out : cur;
    });
    setSelectedIds((cur) => {
      let changed = false;
      const out = new Set<string>();
      for (const id of cur) {
        if (liveIds.has(id)) out.add(id);
        else changed = true;
      }
      return changed ? out : cur;
    });
  }, [agents]);

  const handleCardClick = useCallback((agentId: string, shiftKey: boolean) => {
    if (shiftKey) {
      // Toggle membership in the multi-selection.
      setSelectedIds((cur) => {
        const out = new Set(cur);
        if (out.has(agentId)) out.delete(agentId);
        else out.add(agentId);
        return out;
      });
      return;
    }
    // Plain click: the card has been "read" — clear its unread ring,
    // and drop any in-progress multi-selection.
    setUnreadIds((cur) => {
      if (!cur.has(agentId)) return cur;
      const out = new Set(cur);
      out.delete(agentId);
      return out;
    });
    setSelectedIds((cur) => (cur.size > 0 ? new Set<string>() : cur));
  }, []);

  const handleDeleteSelected = useCallback(async () => {
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    setConfirmBulk(false);
    // Same store action the single-card delete button uses.
    for (const id of ids) {
      await deleteAgent(id);
    }
  }, [selectedIds, deleteAgent]);

  // The ids a bulk stop would actually send: deduped, then capped — same order
  // as the main-side `normalizeBulkRequest`, so 300 selected agents can't push
  // the request past the cap and get silently truncated somewhere else.
  const stopIds = useMemo(() => [...new Set(selectedIds)].slice(0, BULK_STOP_MAX), [selectedIds]);
  const stopOverflow = selectedIds.size - stopIds.length;

  // Statuses in the selection, for the confirm copy. `launching` is called out
  // separately because it is the one status where stopping is not merely
  // interrupting work: the agent has no settled process yet, so a stop lands
  // mid-spawn and can leave a half-started CLI behind.
  const selectedLaunching = useMemo(
    () => agents.filter((a) => stopIds.includes(a.id) && a.status === 'launching'),
    [agents, stopIds],
  );
  const selectedLive = useMemo(
    () => agents.filter((a) => stopIds.includes(a.id) && !['done', 'crashed'].includes(a.status)),
    [agents, stopIds],
  );

  const handleStopSelected = useCallback(async () => {
    if (stopIds.length === 0) return;
    setStopBusy(true);
    setStopError(null);
    setStopResult(null);
    try {
      // `confirmActive: true` is what makes main EXECUTE on agents whose guards
      // came back as warnings — it is not a formality carried along, it is the
      // flag the human just supplied by passing the second confirm step. The
      // renderer never supplies a reason; main assigns `manual-selection`.
      const result = await window.api.agents.stopBulk({
        agentIds: stopIds,
        mode: 'explicit',
        confirmActive: true,
      });
      setStopResult(result);
      // Keep the selection so the per-agent results below stay attributable;
      // just disarm the confirm.
      setConfirmStop(false);
    } catch (e) {
      setStopError(String(e));
    } finally {
      setStopBusy(false);
    }
  }, [stopIds]);

  // Reset the confirm step whenever the selection empties so a stale
  // "confirm" can't apply to a new selection.
  useEffect(() => {
    if (selectedIds.size === 0) {
      setConfirmBulk(false);
      setStopResult(null);
      setStopError(null);
    }
  }, [selectedIds]);

  // Changing WHICH agents are selected disarms a primed stop — the confirm the
  // human just read described the old set, and its launching-agent warning may
  // not be true of the new one.
  useEffect(() => {
    setConfirmStop(false);
  }, [selectedIds]);

  // Keyboard: Delete removes the selection (with one confirm step), Escape
  // clears it. Ignored while typing in an input or the embedded terminal.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Escape') {
        setSelectedIds(new Set());
      } else if (e.key === 'Delete') {
        if (confirmBulk) void handleDeleteSelected();
        else setConfirmBulk(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds.size, confirmBulk, handleDeleteSelected]);

  // Bucket the flat list into an owner→children forest. Memoized on `agents`
  // so the common (no-owner) path stays cheap.
  const forest = useMemo(() => buildAgentForest(agents), [agents]);

  // Two-section split (plan §1): owner-roots render as full-width bands in a
  // dedicated vertical stack ABOVE the grid; childless roots stay in the
  // responsive grid. A separate section avoids the `col-span-full`
  // auto-placement hazard that would silently reorder the flat cards.
  const ownerRoots = useMemo(() => forest.filter(isOwnerContainer), [forest]);
  const childlessRoots = useMemo(() => forest.filter((n) => !isOwnerContainer(n)), [forest]);

  const nodeCtx: NodeContext = {
    unreadIds,
    selectedIds,
    selectionCount: selectedIds.size,
    onTeam: (agentId) => setTeamDialogAgentId(agentId),
    onCardClick: handleCardClick,
    onDeleteSelected: handleDeleteSelected,
  };

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <div className="text-center">
          <div className="text-2xl mb-2">No agents running</div>
          <div className="text-sm">Click "Launch Agent" to start one</div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Owner-containers: full-width vertical stack, read first. Plain divs (no
          framer `layout`) so an owner gaining/losing its first child doesn't jar
          — the responsive grid below keeps its layout animation for flat cards. */}
      {ownerRoots.length > 0 && (
        <div className="flex flex-col gap-4 mb-4">
          {ownerRoots.map((node) => (
            <AgentNode key={node.agent.id} node={node} ctx={nodeCtx} depth={0} />
          ))}
        </div>
      )}
      {/* Childless roots: the existing responsive grid. `items-start` keeps each
          card at its natural height instead of stretching to a tall neighbor. */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
        <AnimatePresence>
          {childlessRoots.map((node) => (
            <AgentNode key={node.agent.id} node={node} ctx={nodeCtx} depth={0} />
          ))}
        </AnimatePresence>
      </div>
      {/* Bulk-action bar — appears while a shift+click multi-selection is
          active. Sticky inside the grid's scroll container. */}
      {selectedIds.size > 0 && (
        <div className="sticky bottom-3 z-20 mt-4 flex justify-center pointer-events-none">
          <div className="ui-card pointer-events-auto flex flex-col gap-2 px-4 py-2 shadow-lg ring-1 ring-accent-purple/40 max-w-[560px]">
            {/* Stop confirm — step 2 of two. Deliberately a BLOCK of copy, not
                a re-labelled button: it names what is about to be interrupted,
                and calls out `launching` agents as their own risk. */}
            {confirmStop && (
              <div
                className="rounded border border-accent-red/40 bg-accent-red/[0.07] px-3 py-2 text-[12px] space-y-1"
                role="alertdialog"
                aria-label="Confirm stop selected agents"
              >
                <div className="text-gray-200 font-semibold">
                  Stop {stopIds.length} agent{stopIds.length === 1 ? '' : 's'}?
                </div>
                <div className="text-gray-400">
                  {selectedLive.length > 0
                    ? `${selectedLive.length} of them ${selectedLive.length === 1 ? 'is' : 'are'} still live — their process will be killed and any work in progress is lost. This is not a pause; there is no resume.`
                    : 'None of them are currently live; already-stopped agents are reported as such.'}
                </div>
                {selectedLaunching.length > 0 && (
                  <div className="text-accent-red">
                    {selectedLaunching.length} {selectedLaunching.length === 1 ? 'is' : 'are'} still
                    LAUNCHING ({selectedLaunching.map((a) => a.title).join(', ')}). Stopping mid-launch
                    hits an agent whose process has not settled yet — the CLI may be left
                    half-started, and the stop can fail to confirm.
                  </div>
                )}
                {stopOverflow > 0 && (
                  <div className="text-accent-yellow">
                    Only the first {BULK_STOP_MAX} selected agents will be sent; {stopOverflow} will
                    be left running.
                  </div>
                )}
              </div>
            )}

            {/* Per-agent outcome. Anything not `stopped` is named; `failed`
                means the process was NOT confirmed gone and is never counted
                as a success. */}
            {stopResult && (
              <div className="rounded border border-white/10 px-3 py-2 text-[11px] space-y-0.5" role="status">
                <div className="text-gray-300">
                  Stopped {stopResult.items.filter((i) => i.result === 'stopped').length} of{' '}
                  {stopResult.items.length}
                </div>
                {stopResult.items
                  .filter((i) => i.result !== 'stopped')
                  .map((i) => {
                    const title = agents.find((a) => a.id === i.agentId)?.title ?? i.agentId;
                    return (
                      <div
                        key={i.agentId}
                        className={i.result === 'failed' ? 'text-accent-red' : 'text-gray-500'}
                      >
                        {title} —{' '}
                        {i.result === 'failed'
                          ? 'stop could not be confirmed; it may still be running'
                          : i.result === 'not_found'
                            ? 'no longer exists'
                            : (summarizeStopExclusions(i.codes) ?? 'skipped')}
                      </div>
                    );
                  })}
              </div>
            )}
            {stopError && (
              <div className="text-[11px] text-accent-red" role="alert">{stopError}</div>
            )}

            <div className="flex items-center gap-3">
              <span className="text-[13px] text-gray-300">
                {selectedIds.size} agent{selectedIds.size === 1 ? '' : 's'} selected
              </span>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="ui-btn ui-btn-ghost px-2 py-1 text-[12px]"
                title="Clear selection (Esc)"
              >
                Clear
              </button>
              <button
                onClick={() => {
                  if (confirmStop) void handleStopSelected();
                  else setConfirmStop(true);
                }}
                disabled={stopBusy || stopIds.length === 0}
                className="ui-btn ui-btn-danger px-3 py-1 text-[12px]"
                title="Stop all selected agents"
              >
                {stopBusy
                  ? 'Stopping…'
                  : confirmStop
                    ? `Yes, stop ${stopIds.length}`
                    : 'Stop selected'}
              </button>
              {confirmStop && (
                <button
                  onClick={() => setConfirmStop(false)}
                  className="ui-btn ui-btn-ghost px-2 py-1 text-[12px]"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={() => {
                  if (confirmBulk) void handleDeleteSelected();
                  else setConfirmBulk(true);
                }}
                className="ui-btn ui-btn-danger px-3 py-1 text-[12px]"
                title="Delete all selected agents (Del)"
              >
                {confirmBulk
                  ? `Confirm delete ${selectedIds.size}`
                  : 'Delete selected'}
              </button>
            </div>
          </div>
        </div>
      )}
      {teamDialogAgentId && selectedWorkspaceId && (
        <TeamDialog
          workspaceId={selectedWorkspaceId}
          agents={agents}
          preSelectedAgentId={teamDialogAgentId}
          onClose={() => setTeamDialogAgentId(null)}
        />
      )}
    </>
  );
}
