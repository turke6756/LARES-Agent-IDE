// @vitest-environment jsdom
//
// Cross-workspace "agent waiting" heat derivation (plan:
// plans/workspace-waiting-indicator.md §7). These exercise the real store: the
// `agentStatuses` index is the sole source of `workspaceHeat`, so a background
// (non-selected) workspace's `waiting` agent must light up its heat without ever
// touching the workspace-scoped `agents` array.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useDashboardStore } from './dashboard-store';
import type { Agent, AgentStatus } from '../../shared/types';

// The heat path only reads id / workspaceId / status off each agent; the rest of
// the Agent shape is irrelevant here, so build a minimal stand-in.
function agent(id: string, workspaceId: string, status: AgentStatus): Agent {
  return { id, workspaceId, status } as unknown as Agent;
}

const store = () => useDashboardStore.getState();

beforeEach(() => {
  // Reset only the slice the heat derivation touches; other state keeps its
  // create() defaults.
  useDashboardStore.setState({
    agents: [],
    agentStatuses: {},
    workspaceHeat: {},
    selectedWorkspaceId: null,
  });
  // Minimal window.api stub for the startup paths (loadAgentStatuses / loadAgents).
  (window as unknown as { api: unknown }).api = {
    agents: {
      listAll: vi.fn(async () => [] as Agent[]),
      list: vi.fn(async () => [] as Agent[]),
    },
  };
});

describe('workspace heat — cross-workspace agentStatuses index', () => {
  // Case 1
  it('seeds heat for every workspace present in the index (two workspaces)', () => {
    store().seedAgentStatuses([
      agent('a1', 'ws-1', 'working'),
      agent('a2', 'ws-2', 'idle'),
    ]);
    const heat = store().workspaceHeat;
    expect(heat['ws-1']).toEqual({ activeCount: 1, workingCount: 1, waitingCount: 0 });
    expect(heat['ws-2']).toEqual({ activeCount: 1, workingCount: 0, waitingCount: 0 });
  });

  // Case 2
  it('sets waitingCount for a background workspace without mutating the scoped agents array', () => {
    useDashboardStore.setState({ selectedWorkspaceId: 'ws-selected', agents: [] });
    store().updateAgentStatusSnapshot(agent('a1', 'ws-bg', 'waiting'));
    expect(store().workspaceHeat['ws-bg']).toEqual({ activeCount: 1, workingCount: 0, waitingCount: 1 });
    // The scoped (selected-workspace-only) array is untouched — the whole point of PATH B.
    expect(store().agents).toEqual([]);
  });

  // Case 3
  it('clears waiting when the same agent flips to working', () => {
    store().updateAgentStatusSnapshot(agent('a1', 'ws-1', 'waiting'));
    expect(store().workspaceHeat['ws-1'].waitingCount).toBe(1);
    store().updateAgentStatusSnapshot(agent('a1', 'ws-1', 'working'));
    expect(store().workspaceHeat['ws-1'].waitingCount).toBe(0);
    expect(store().workspaceHeat['ws-1'].workingCount).toBe(1);
  });

  // Case 4
  it('drops the workspace from heat when its only agent finishes (done)', () => {
    store().updateAgentStatusSnapshot(agent('a1', 'ws-1', 'waiting'));
    store().updateAgentStatusSnapshot(agent('a1', 'ws-1', 'done'));
    expect(store().workspaceHeat['ws-1']).toBeUndefined();
  });

  // Case 5
  it('removeAgent clears a stale waiting entry (agent:deleted path)', () => {
    store().updateAgentStatusSnapshot(agent('a1', 'ws-1', 'waiting'));
    expect(store().workspaceHeat['ws-1'].waitingCount).toBe(1);
    store().removeAgent('a1');
    expect(store().agentStatuses['a1']).toBeUndefined();
    expect(store().workspaceHeat['ws-1']).toBeUndefined();
  });

  // Case 6
  it('removeAgentStatusesForWorkspace clears all heat for a deleted workspace', () => {
    store().seedAgentStatuses([
      agent('a1', 'ws-1', 'waiting'),
      agent('a2', 'ws-1', 'working'),
      agent('b1', 'ws-2', 'working'),
    ]);
    store().removeAgentStatusesForWorkspace('ws-1');
    expect(store().workspaceHeat['ws-1']).toBeUndefined();
    expect(store().workspaceHeat['ws-2']).toEqual({ activeCount: 1, workingCount: 1, waitingCount: 0 });
  });
});
