// @vitest-environment jsdom
//
// WP2 (hook-absence-resilience) — the HOOKS OFF badge on the horizontal
// owner-container band. Same reuse pattern as AgentCard (agent-card-bits
// HooksOffBadge): the badge appears for broken/degraded hooks and never
// replaces the operational StatusBadge, so a dead-hook owner is visible in
// BOTH card surfaces.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import OwnerContainerBar from './OwnerContainerBar';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { Agent } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root | null;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'sup1',
    workspaceId: 'ws',
    title: 'Supervisor',
    slug: 'supervisor',
    roleDescription: '',
    workingDirectory: 'C:/ws',
    command: 'claude',
    provider: 'claude',
    isSupervisor: true,
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
    root.render(
      <OwnerContainerBar agent={a} childCount={2} expanded={true} onToggle={() => {}} depth={0} />,
    );
  });
}

function badge(): HTMLElement | null {
  return Array.from(container.querySelectorAll('span')).find(
    (s) => (s.textContent ?? '').trim() === 'HOOKS OFF',
  ) ?? null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  (window as any).api = { agents: { getContextStats: vi.fn(async () => null) } };
  useDashboardStore.setState({
    agents: [],
    selectedAgentId: null,
    terminalAgentId: null,
    contextStats: {},
    continuationPhases: {},
    selectAgent: () => {},
    setTerminalAgent: () => {},
  } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('OwnerContainerBar — HOOKS OFF badge', () => {
  it('does not badge a healthy-hook owner', async () => {
    await render(agent({ hookStatus: 'healthy', hooksUnavailable: false }));
    expect(badge()).toBeNull();
  });

  it('badges a broken-hook owner and keeps the operational status alongside it', async () => {
    await render(agent({ status: 'working', hookStatus: 'broken', hooksUnavailable: true, hooksUnavailableReason: 'canary-timeout' }));
    const b = badge();
    expect(b).toBeTruthy();
    expect(b?.getAttribute('title')).toContain('double-click');
    // Orthogonal: the operational StatusBadge is still rendered.
    expect(container.textContent?.toLowerCase()).toContain('working');
  });

  it('badges a degraded-hook owner with the instrumentation tooltip', async () => {
    await render(agent({ hookStatus: 'degraded', hooksUnavailable: true, hooksUnavailableReason: 'instrumentation-unavailable' }));
    expect(badge()?.getAttribute('title')).toContain("couldn't be instrumented");
  });
});
