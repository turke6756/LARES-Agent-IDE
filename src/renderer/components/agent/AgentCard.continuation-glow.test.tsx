// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentCard from './AgentCard';
import ContinuationPhaseLine from './ContinuationPhaseLine';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { Agent, ContinuationPhase, ContinuationPhaseState } from '../../../shared/types';

// THE evidence-(2) fix, pinned.
//
// `.agent-transfer-glow` is a 2.4 s animation (globals.css) that was bound to a
// flag set by the 'restarting'+continuation status event — the LAST second of a
// 30–150 s cycle — so it got a sub-second window and was never actually seen.
// Bound to the phase instead, it covers the whole cycle. No CSS changed; the
// binding did.

let container: HTMLDivElement;
let root: Root;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'sup-1', workspaceId: 'ws-1', title: 'Supervisor', status: 'idle',
    provider: 'claude', isSupervisor: true, continuationEnabled: true,
    roleDescription: 'coordinates workers', createdAt: '2026-07-21T00:00:00.000Z',
    workingDirectory: 'C:/ws/.dashboard/supervisor', pathType: 'windows',
    ...over,
  } as unknown as Agent;
}

function setPhase(state: ContinuationPhaseState | null) {
  useDashboardStore.setState({ continuationPhases: state ? { [state.agentId]: state } : {} });
}

function render(a: Agent) {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(AgentCard, { agent: a }));
  });
}

const card = () => container.querySelector('.agent-card') as HTMLElement;
const glowing = () => card().className.includes('agent-transfer-glow');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  useDashboardStore.setState({ continuationPhases: {}, contextStats: {} });
  (window as unknown as { api: unknown }).api = {
    agents: {
      getContextStats: vi.fn(async () => null),
      forceContinuationHandoff: vi.fn(async () => ({ ok: true })),
      setContinuationEnabled: vi.fn(async () => ({ ok: true })),
    },
  };
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container.remove();
});

describe('AgentCard — the gold glow follows the phase, not the status', () => {
  it('is dark when no handoff is running', () => {
    render(agent());
    expect(glowing()).toBe(false);
  });

  it('lights from the FIRST phase — the press, not the session swap', () => {
    setPhase({ agentId: 'sup-1', phase: 'queued', updatedAt: 1 });
    render(agent());
    expect(glowing()).toBe(true);
  });

  it('stays lit through every non-terminal phase, including the long ones', () => {
    const lit: ContinuationPhase[] = [
      'queued', 'opening', 'awaiting-note', 'note-committed',
      'waiting-for-idle', 'relaunching', 'launching', 'backoff',
    ];
    for (const phase of lit) {
      setPhase({ agentId: 'sup-1', phase, updatedAt: 1 });
      render(agent());
      expect(glowing(), phase).toBe(true);
      act(() => { root.unmount(); });
    }
  });

  it('goes dark on `failed` — an animation that never stops reads as "still working"', () => {
    setPhase({ agentId: 'sup-1', phase: 'failed', message: 'boom', updatedAt: 1 });
    render(agent());
    expect(glowing()).toBe(false);
  });

  it('is NOT lit merely because the agent is restarting for some other reason', () => {
    // An ordinary auto-restart must not borrow the continuation identity.
    render(agent({ status: 'restarting' }));
    expect(glowing()).toBe(false);
  });

  it('renders the phase label line, and drops it when the phase clears', () => {
    setPhase({ agentId: 'sup-1', phase: 'awaiting-note', updatedAt: 1 });
    render(agent());
    const line = container.querySelector('[data-continuation-phase]');
    expect(line?.textContent).toBe('Waiting for agent to save note…');
    act(() => {
      useDashboardStore.getState().applyContinuationPhase({ agentId: 'sup-1', phase: null });
    });
    expect(container.querySelector('[data-continuation-phase]')).toBeNull();
    expect(glowing()).toBe(false);
  });
});

describe('ContinuationPhaseLine', () => {
  it('counts down toward retryAt off a renderer-local timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      act(() => {
        root = createRoot(container);
        root.render(React.createElement(ContinuationPhaseLine, {
          state: { agentId: 'a', phase: 'backoff', retryAt: 10_000, message: 'busy', updatedAt: 0 },
        }));
      });
      expect(container.textContent).toBe('Retry in 10s — busy');
      act(() => { vi.advanceTimersByTime(3_000); });
      expect(container.textContent).toBe('Retry in 7s — busy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a failure in the error tone', () => {
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(ContinuationPhaseLine, {
        state: { agentId: 'a', phase: 'failed', message: 'CLI missing', updatedAt: 0 },
      }));
    });
    const line = container.querySelector('[data-continuation-phase]') as HTMLElement;
    expect(line.textContent).toBe('Continuation failed: CLI missing');
    expect(line.className).toContain('text-accent-red');
  });
});
