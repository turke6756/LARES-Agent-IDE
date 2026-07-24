// @vitest-environment jsdom
//
// WP2 (hook-absence-resilience) — the HOOKS OFF card badge. Hook health is
// orthogonal to operational status, so the badge appears for broken/degraded
// hooks (with the matching tooltip), stays hidden for healthy/unknown, and
// NEVER replaces the operational StatusBadge.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentCard from './AgentCard';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { Agent } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root | null;

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
  return Array.from(container.querySelectorAll('span')).find(
    (s) => (s.textContent ?? '').trim() === 'HOOKS OFF',
  ) ?? null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  (window as any).api = {
    agents: {
      getContextStats: vi.fn(async () => null),
      updateSupervised: vi.fn(async () => {}),
      stop: vi.fn(async () => ({ items: [] })),
    },
  };
  useDashboardStore.setState({ agents: [], selectedAgentId: null } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('AgentCard — HOOKS OFF badge', () => {
  it('does not badge an agent whose hooks are healthy', async () => {
    await render(agent({ hookStatus: 'healthy', hooksUnavailable: false }));
    expect(badge()).toBeNull();
  });

  it('does not badge an agent whose hook status is still unknown', async () => {
    await render(agent({ hookStatus: 'unknown', hooksUnavailable: false }));
    expect(badge()).toBeNull();
  });

  it('badges a broken-hook agent with the canary-timeout (Node on PATH) tooltip', async () => {
    await render(agent({ hookStatus: 'broken', hooksUnavailable: true, hooksUnavailableReason: 'canary-timeout' }));
    const b = badge();
    expect(b).toBeTruthy();
    expect(b?.getAttribute('title')).toContain('no status hook');
    expect(b?.getAttribute('title')).toContain('double-click');
  });

  it('badges a degraded-hook agent with the instrumentation-unavailable tooltip', async () => {
    await render(agent({ hookStatus: 'degraded', hooksUnavailable: true, hooksUnavailableReason: 'instrumentation-unavailable' }));
    const b = badge();
    expect(b).toBeTruthy();
    expect(b?.getAttribute('title')).toContain("couldn't be instrumented");
  });

  it('keeps the operational StatusBadge alongside the hook badge (orthogonal, not a replacement)', async () => {
    await render(agent({ status: 'working', hookStatus: 'broken', hooksUnavailable: true, hooksUnavailableReason: 'canary-timeout' }));
    expect(badge()).toBeTruthy();
    // The operational status text is still present on the card.
    expect(container.textContent?.toLowerCase()).toContain('working');
  });

  it('recovery: clears the badge once hooks report healthy again', async () => {
    await render(agent({ hookStatus: 'broken', hooksUnavailable: true, hooksUnavailableReason: 'canary-timeout' }));
    expect(badge()).toBeTruthy();
    await act(async () => {
      root!.render(<AgentCard agent={agent({ hookStatus: 'healthy', hooksUnavailable: false })} />);
    });
    expect(badge()).toBeNull();
  });
});
