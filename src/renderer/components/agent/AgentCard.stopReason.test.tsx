// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentCard, { STOP_REASON_BADGE } from './AgentCard';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { Agent, AgentStopReason, BulkStopResult } from '../../../shared/types';

// §B8 acceptance for the card:
//   1. the stopped-reason badge reflects the PERSISTED reason, and `restart`
//      never badges (a restarted agent was not killed by anyone);
//   2. an honest `failed` stop is reported as unconfirmed, never as success.

let container: HTMLDivElement;
let root: Root | null;
let stopResult: BulkStopResult;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    workspaceId: 'ws',
    title: 'Alpha',
    slug: 'alpha',
    roleDescription: '',
    workingDirectory: 'C:/ws',
    command: 'claude',
    provider: 'claude',
    isSupervisor: false,
    isSupervised: false,
    isWorker: false,
    isResearcher: false,
    tmuxSessionName: null,
    autoRestartEnabled: false,
    resumeSessionId: null,
    status: 'idle',
    ownerAgentId: null,
    restartCount: 0,
    createdAt: '2026-07-19 10:00:00',
    ...over,
  } as Agent;
}

async function render(a: Agent) {
  await act(async () => {
    root = createRoot(container);
    root.render(<AgentCard agent={a} />);
  });
}

function badge(): HTMLElement | null {
  return container.querySelector('[data-testid="stop-reason-badge"]');
}

async function openMenuAndStop() {
  const card = container.querySelector('.agent-card')!;
  await act(async () => {
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  });
  const stopBtn = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').startsWith('Stop Agent'),
  );
  expect(stopBtn, 'Stop Agent menu item').toBeTruthy();
  await act(async () => {
    stopBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return stopBtn!;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  stopResult = { items: [{ agentId: 'a1', result: 'stopped', codes: [] }] };
  (window as any).api = {
    agents: {
      getContextStats: vi.fn(async () => null),
      updateSupervised: vi.fn(async () => {}),
      stop: vi.fn(async () => stopResult),
    },
  };
  useDashboardStore.setState({ agents: [], selectedAgentId: null } as any);
});

afterEach(() => {
  // Not every case renders (the pure copy-table test does not), so unmount is
  // conditional rather than assumed.
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('AgentCard — stopped-reason badge', () => {
  it('has copy for every stop reason except restart', () => {
    const reasons = Object.keys(STOP_REASON_BADGE) as AgentStopReason[];
    for (const r of reasons) {
      if (r === 'restart') expect(STOP_REASON_BADGE[r]).toBeNull();
      else expect(STOP_REASON_BADGE[r]).toBeTruthy();
    }
  });

  it('renders the reason for a done agent', async () => {
    await render(agent({ status: 'done', lastStopReason: 'automatic-stale-idle', stoppedAt: '2026-07-20 09:00:00' }));
    expect(badge()?.textContent).toBe(STOP_REASON_BADGE['automatic-stale-idle']);
    expect(badge()?.getAttribute('title')).toContain('Stopped at');
  });

  it('distinguishes a supervisor stop from a manual one', async () => {
    await render(agent({ status: 'done', lastStopReason: 'supervisor' }));
    expect(badge()?.textContent).toContain('supervisor');
  });

  it('does not badge a restart', async () => {
    await render(agent({ status: 'done', lastStopReason: 'restart' }));
    expect(badge()).toBeNull();
  });

  it('does not badge a live agent, or one with no recorded reason', async () => {
    await render(agent({ status: 'idle', lastStopReason: 'manual-card' }));
    expect(badge()).toBeNull();
    await act(async () => root!.unmount());
    await render(agent({ status: 'done', lastStopReason: null }));
    expect(badge()).toBeNull();
  });
});

describe('AgentCard — stop outcome', () => {
  it('stops an idle agent in one step and shows no toast on success', async () => {
    await render(agent({ status: 'idle' }));
    await openMenuAndStop();
    expect((window as any).api.agents.stop).toHaveBeenCalledWith('a1');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('requires a second confirm for a working agent', async () => {
    await render(agent({ status: 'working' }));
    const btn = await openMenuAndStop();
    expect((window as any).api.agents.stop).not.toHaveBeenCalled();
    expect(btn.textContent).toContain('Confirm stop');
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect((window as any).api.agents.stop).toHaveBeenCalledTimes(1);
  });

  it('reports a failed stop as unconfirmed, never as stopped', async () => {
    stopResult = { items: [{ agentId: 'a1', result: 'failed', codes: [], outcome: 'failed' }] };
    await render(agent({ status: 'idle' }));
    await openMenuAndStop();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('could not be confirmed');
    expect(alert?.textContent).toContain('may still be running');
  });

  it('shows a skipped stop with its exclusion copy', async () => {
    stopResult = { items: [{ agentId: 'a1', result: 'skipped', codes: ['browser_lease'] }] };
    await render(agent({ status: 'idle' }));
    await openMenuAndStop();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Browser in use');
  });

  it('surfaces a rejected stop call', async () => {
    (window as any).api.agents.stop = vi.fn(async () => { throw new Error('ipc down'); });
    await render(agent({ status: 'idle' }));
    await openMenuAndStop();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('ipc down');
  });

  it('offers no Stop Agent action for an already-done agent', async () => {
    await render(agent({ status: 'done', lastStopReason: 'manual-card' }));
    const card = container.querySelector('.agent-card')!;
    await act(async () => {
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const stopBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').startsWith('Stop Agent'),
    );
    expect(stopBtn).toBeFalsy();
  });
});
