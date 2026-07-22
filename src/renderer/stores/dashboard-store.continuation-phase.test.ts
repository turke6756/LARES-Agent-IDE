// @vitest-environment jsdom
//
// Slice 2 §4.5/§4.7 — the store side of the continuation phase rail.
//
// The regression that motivates most of this file: the old transfer flag was
// reconciled against every full agent refresh (`loadAgents` / `loadAllAgents`),
// so a generic list refresh — which happens constantly — erased an independent,
// minutes-long operation. Combined with the flag only being SET at the very end
// of the cycle, the gold glow it drove was effectively never visible.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useDashboardStore } from './dashboard-store';
import type { Agent, AgentStatus, ContinuationPhaseState } from '../../shared/types';

function agent(id: string, workspaceId: string, status: AgentStatus = 'idle'): Agent {
  return { id, workspaceId, status } as unknown as Agent;
}

function phase(agentId: string, over: Partial<ContinuationPhaseState> = {}): ContinuationPhaseState {
  return { agentId, phase: 'awaiting-note', updatedAt: 1, ...over };
}

const store = () => useDashboardStore.getState();

let listMock: ReturnType<typeof vi.fn>;
let listAllMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useDashboardStore.setState({
    agents: [],
    agentStatuses: {},
    workspaceHeat: {},
    continuationPhases: {},
    selectedWorkspaceId: null,
  });
  listMock = vi.fn(async () => [] as Agent[]);
  listAllMock = vi.fn(async () => [] as Agent[]);
  (window as unknown as { api: unknown }).api = {
    agents: { list: listMock, listAll: listAllMock },
  };
});

describe('hydration + broadcast', () => {
  it('hydrateContinuationPhases replaces the map wholesale, keyed by agent id', () => {
    store().hydrateContinuationPhases([phase('a'), phase('b', { phase: 'backoff' })]);
    expect(Object.keys(store().continuationPhases).sort()).toEqual(['a', 'b']);
    expect(store().continuationPhases.b.phase).toBe('backoff');
    // A second hydrate (e.g. a reload) is authoritative, not additive.
    store().hydrateContinuationPhases([phase('c')]);
    expect(Object.keys(store().continuationPhases)).toEqual(['c']);
  });

  it('applyContinuationPhase advances a phase in place', () => {
    store().applyContinuationPhase(phase('a', { phase: 'queued' }));
    store().applyContinuationPhase(phase('a', { phase: 'relaunching', attemptId: 'att-1' }));
    expect(store().continuationPhases.a.phase).toBe('relaunching');
    expect(store().continuationPhases.a.attemptId).toBe('att-1');
  });

  it('phase:null clears the entry (the completion signal)', () => {
    store().applyContinuationPhase(phase('a', { phase: 'launching' }));
    store().applyContinuationPhase({ agentId: 'a', phase: null });
    expect(store().continuationPhases).toEqual({});
  });

  it('a no-op signal does not write new state (reference stability)', () => {
    store().applyContinuationPhase(phase('a'));
    const before = store().continuationPhases;
    store().applyContinuationPhase({ agentId: 'ghost', phase: null });
    expect(store().continuationPhases).toBe(before);
  });
});

describe('a generic agent refresh must never erase an independent operation', () => {
  it('loadAgents does NOT clear the phase of an agent it still lists', async () => {
    store().applyContinuationPhase(phase('a', { phase: 'awaiting-note' }));
    // The agent is 'idle' during the 180 s note wait — the old reconcile cleared
    // anything not 'restarting', which is precisely the bug.
    listMock.mockResolvedValueOnce([agent('a', 'ws-1', 'idle')]);
    await store().loadAgents('ws-1');
    expect(store().continuationPhases.a?.phase).toBe('awaiting-note');
  });

  it('loadAllAgents does NOT clear a listed agent’s phase either', async () => {
    store().applyContinuationPhase(phase('a', { phase: 'backoff' }));
    listAllMock.mockResolvedValueOnce([agent('a', 'ws-1', 'idle')]);
    await store().loadAllAgents();
    expect(store().continuationPhases.a?.phase).toBe('backoff');
  });

  it('loadAgents DOES drop a phase whose agent vanished from this workspace', async () => {
    useDashboardStore.setState({ agentStatuses: { gone: { workspaceId: 'ws-1', status: 'done' } } });
    store().applyContinuationPhase(phase('gone'));
    listMock.mockResolvedValueOnce([agent('a', 'ws-1')]);
    await store().loadAgents('ws-1');
    expect('gone' in store().continuationPhases).toBe(false);
  });

  it('a workspace-scoped refresh cannot touch another workspace’s phase', async () => {
    useDashboardStore.setState({ agentStatuses: { other: { workspaceId: 'ws-2', status: 'idle' } } });
    store().applyContinuationPhase(phase('other'));
    listMock.mockResolvedValueOnce([agent('a', 'ws-1')]);
    await store().loadAgents('ws-1');
    expect(store().continuationPhases.other?.phase).toBe('awaiting-note');
  });

  it('loadAllAgents is authoritative across workspaces, so absence there does drop', async () => {
    store().applyContinuationPhase(phase('gone'));
    listAllMock.mockResolvedValueOnce([agent('a', 'ws-1')]);
    await store().loadAllAgents();
    expect('gone' in store().continuationPhases).toBe(false);
  });
});

describe('optimistic queued', () => {
  it('paints queued immediately and is then replaced by the authoritative event', () => {
    store().setOptimisticContinuationQueued('a');
    expect(store().continuationPhases.a.phase).toBe('queued');
    // Main's own `queued` lands milliseconds later, carrying its timestamp.
    store().applyContinuationPhase(phase('a', { phase: 'queued', updatedAt: 12345 }));
    expect(store().continuationPhases.a.updatedAt).toBe(12345);
    store().applyContinuationPhase(phase('a', { phase: 'opening' }));
    expect(store().continuationPhases.a.phase).toBe('opening');
  });

  it('clearOptimisticContinuationPhase rolls back a rejected press', () => {
    store().setOptimisticContinuationQueued('a');
    store().clearOptimisticContinuationPhase('a');
    expect('a' in store().continuationPhases).toBe(false);
  });

  it('the rollback is narrow: it never erases a phase that has already advanced', () => {
    // A slow IPC rejection must not blow away a real cycle that started
    // meanwhile (e.g. the automatic trigger fired for the same agent).
    store().setOptimisticContinuationQueued('a');
    store().applyContinuationPhase(phase('a', { phase: 'awaiting-note' }));
    store().clearOptimisticContinuationPhase('a');
    expect(store().continuationPhases.a?.phase).toBe('awaiting-note');
  });
});
