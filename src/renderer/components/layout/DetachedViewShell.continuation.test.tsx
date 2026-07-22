// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { ContinuationPhaseSignal, ContinuationPhaseState } from '../../../shared/types';

// §2.3 / §4.5 — a DETACHED dashboard window must hydrate the live phases on
// mount and stay subscribed.
//
// Why hydration and not events alone: a torn-off window opened DURING the 180 s
// note wait would otherwise show a card with no label and no glow until the next
// transition — recreating, in a second window, the exact "nothing is happening"
// defect this rail exists to remove.
//
// The four center views are stubbed: this test is about the shell's data wiring,
// not about re-rendering the file viewer or a WebContentsView composite.
vi.mock('../agent/AgentGrid', () => ({ default: () => React.createElement('div', { 'data-testid': 'grid' }) }));
vi.mock('../fileviewer/FileViewerPanel', () => ({ default: () => null }));
vi.mock('../browser/BrowserPanel', () => ({ default: () => null }));
vi.mock('../plan/PlanSurfaceContainer', () => ({ default: () => null }));

import DetachedViewShell from './DetachedViewShell';

let container: HTMLDivElement;
let root: Root;
let listContinuationPhases: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
let emitPhase: (s: ContinuationPhaseSignal) => void;

const HYDRATED: ContinuationPhaseState[] = [
  { agentId: 'sup-1', phase: 'awaiting-note', attemptId: 'att-1', updatedAt: 7 },
];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  useDashboardStore.setState({ continuationPhases: {}, workspaces: [], agents: [] });
  listContinuationPhases = vi.fn(async () => HYDRATED);
  unsubscribe = vi.fn();
  emitPhase = () => { throw new Error('not subscribed'); };
  (window as unknown as { api: unknown }).api = {
    agents: {
      list: vi.fn(async () => []),
      listAll: vi.fn(async () => []),
      listContinuationPhases,
      onContinuationPhaseChanged: vi.fn((cb: (s: ContinuationPhaseSignal) => void) => {
        emitPhase = cb;
        return unsubscribe;
      }),
      onContextStatsChanged: vi.fn(() => () => {}),
    },
    onAgentStatusChanged: vi.fn(() => () => {}),
    onAgentDeleted: vi.fn(() => () => {}),
  };
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container.remove();
});

async function renderShell() {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(DetachedViewShell, {
      params: new URLSearchParams('view=dashboard&workspaceId=ws-1&label=Dash'),
    }));
  });
}

describe('DetachedViewShell — continuation phases', () => {
  it('hydrates the authoritative phase map on mount', async () => {
    await renderShell();
    expect(listContinuationPhases).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().continuationPhases['sup-1']?.phase).toBe('awaiting-note');
  });

  it('applies later broadcasts, including the clear', async () => {
    await renderShell();
    act(() => { emitPhase({ agentId: 'sup-1', phase: 'relaunching', updatedAt: 8 }); });
    expect(useDashboardStore.getState().continuationPhases['sup-1'].phase).toBe('relaunching');
    act(() => { emitPhase({ agentId: 'sup-1', phase: null }); });
    expect('sup-1' in useDashboardStore.getState().continuationPhases).toBe(false);
  });

  it('unsubscribes on unmount (no leaked listener per torn-off window)', async () => {
    await renderShell();
    act(() => { root.unmount(); });
    expect(unsubscribe).toHaveBeenCalled();
  });
});
