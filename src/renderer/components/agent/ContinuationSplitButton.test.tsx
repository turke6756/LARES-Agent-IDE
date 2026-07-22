// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ContinuationSplitButton from './ContinuationSplitButton';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { Agent, ForceContinuationResult } from '../../../shared/types';

// Slice 2 §4.5/§4.7 — the press paints the authoritative-shaped `queued` phase
// BEFORE awaiting IPC.
//
// The bug this pins: `forcing` cleared the instant the IPC promise resolved —
// milliseconds into an operation that runs for minutes — so the button gave the
// user a flicker and then nothing. Rendered via the createRoot-on-jsdom probe
// pattern used elsewhere in the renderer suite (no React Testing Library).

let container: HTMLDivElement;
let root: Root;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'sup-1', workspaceId: 'ws-1', title: 'Supervisor', status: 'idle',
    provider: 'claude', isSupervisor: true, continuationEnabled: true,
    ...over,
  } as unknown as Agent;
}

/** A force whose promise we resolve by hand, so "before it resolves" is a real
 *  observable moment rather than a race. */
function deferredForce() {
  let settle: (r: ForceContinuationResult) => void = () => {};
  const promise = new Promise<ForceContinuationResult>((r) => { settle = r; });
  const forceContinuationHandoff = vi.fn(() => promise);
  (window as unknown as { api: unknown }).api = {
    agents: { forceContinuationHandoff, setContinuationEnabled: vi.fn(async () => ({ ok: true })) },
  };
  return { settle, forceContinuationHandoff };
}

function render(a: Agent) {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(ContinuationSplitButton, { agent: a }));
  });
}

function pressMain() {
  const btn = container.querySelector('button.csplit-main') as HTMLButtonElement;
  expect(btn, 'main press button should render').toBeTruthy();
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const phases = () => useDashboardStore.getState().continuationPhases;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  useDashboardStore.setState({ continuationPhases: {} });
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container.remove();
});

describe('ContinuationSplitButton — optimistic queued', () => {
  it('shows `queued` BEFORE the force promise resolves', async () => {
    const { settle } = deferredForce();
    render(agent());
    pressMain();
    // Still in flight — this is the window the old `forcing` flag covered and
    // the minutes after it that nothing covered.
    expect(phases()['sup-1']?.phase).toBe('queued');
    await act(async () => { settle({ ok: true }); });
    // Success leaves the optimistic entry standing; the authoritative event
    // replaces it (and only the launch tail ever clears it).
    expect(phases()['sup-1']?.phase).toBe('queued');
  });

  it('is replaced, not duplicated, by the authoritative event', async () => {
    const { settle } = deferredForce();
    render(agent());
    pressMain();
    await act(async () => { settle({ ok: true }); });
    act(() => {
      useDashboardStore.getState().applyContinuationPhase({
        agentId: 'sup-1', phase: 'awaiting-note', attemptId: 'att-1', updatedAt: 42,
      });
    });
    expect(Object.keys(phases())).toEqual(['sup-1']);
    expect(phases()['sup-1'].phase).toBe('awaiting-note');
    expect(phases()['sup-1'].attemptId).toBe('att-1');
  });

  it('a rejected press rolls the optimistic phase back and shows the reason', async () => {
    const { settle } = deferredForce();
    render(agent());
    pressMain();
    expect(phases()['sup-1']?.phase).toBe('queued');
    await act(async () => {
      settle({ ok: false, code: 'continuation-not-watched', error: 'not watched' });
    });
    expect('sup-1' in phases()).toBe(false);
    expect(container.querySelector('.csplit-error')?.textContent)
      .toContain('not being watched');
  });

  it('a status-blocked agent never fires the IPC at all (Slice 1 gate still holds)', () => {
    const { forceContinuationHandoff } = deferredForce();
    render(agent({ status: 'done' }));
    const btn = container.querySelector('button.csplit-main') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    pressMain();
    expect(forceContinuationHandoff).not.toHaveBeenCalled();
    expect(phases()).toEqual({});
  });

  it('a press while a handoff is already in flight is inert', () => {
    const { forceContinuationHandoff } = deferredForce();
    useDashboardStore.setState({
      continuationPhases: { 'sup-1': { agentId: 'sup-1', phase: 'awaiting-note', updatedAt: 1 } },
    });
    render(agent());
    pressMain();
    expect(forceContinuationHandoff).not.toHaveBeenCalled();
  });

  it('the Slice-1 "Handoff queued…" local notice is gone (the card owns the label now)', async () => {
    const { settle } = deferredForce();
    render(agent());
    pressMain();
    await act(async () => { settle({ ok: true }); });
    expect(container.textContent).not.toContain('Handoff queued');
  });
});
