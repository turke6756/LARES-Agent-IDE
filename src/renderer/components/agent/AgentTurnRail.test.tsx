// @vitest-environment jsdom
//
// WP-G2.4 — the checkpoint time rail. The rail must render each turn's WITNESSED
// touched paths first-class (attribution = witnessed write/create only), mark a path
// contended when another OPEN turn witnesses it, and — when a turn's diff is
// expanded — show the witnessed changes first-class alongside the SEPARATELY
// LABELED raw window ("unattributed changes in this window").
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentTurnRail from './AgentTurnRail';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { CheckpointTurnSummary, CheckpointDiffResult } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root | null;

function turn(over: Partial<CheckpointTurnSummary> = {}): CheckpointTurnSummary {
  return {
    turnId: 't1',
    turnSeq: 1,
    agentId: 'a1',
    agentTitle: 'Alpha',
    taskLabel: 'edit the config',
    status: 'completed',
    startedAt: 1000,
    endedAt: 2000,
    beforeReady: true,
    afterReady: true,
    beforeQuality: 'guaranteed',
    afterQuality: 'hook',
    witnessedPaths: ['src/config.ts'],
    failureReason: null,
    ...over,
  };
}

const diffResult: CheckpointDiffResult = {
  workspaceId: 'ws',
  turnId: 't1',
  witnessed: { available: true, reason: null, label: 'witnessed changes', text: 'WITNESSED-DIFF-BODY', provenance: 'witnessed' },
  window: {
    available: true,
    reason: null,
    label: 'unattributed changes in this window',
    text: 'RAW-WINDOW-DIFF-BODY',
    provenance: 'raw-window',
  },
};

async function render(agentId = 'a1') {
  await act(async () => {
    root = createRoot(container);
    root.render(<AgentTurnRail workspaceId="ws" agentId={agentId} />);
  });
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes(text),
    ) ?? null
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  (window as any).api = {
    checkpoints: {
      list: vi.fn(async () => ({ workspaceId: 'ws', turns: [turn()] })),
      diff: vi.fn(async () => diffResult),
      preview: vi.fn(async () => ({
        available: true, reason: null, turnId: 't1', witnessedSet: ['src/config.ts'],
        tokens: {}, validatedPaths: ['src/config.ts'], rejectedPaths: [], contention: [],
      })),
      restore: vi.fn(),
      revert: vi.fn(),
    },
  };
  useDashboardStore.setState({ checkpointTurns: {}, checkpointLoading: {} } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  useDashboardStore.setState({ checkpointTurns: {}, checkpointLoading: {} } as any);
});

describe('AgentTurnRail — WP-G2.4', () => {
  it('renders witnessed paths first-class for each turn', async () => {
    useDashboardStore.setState({ checkpointTurns: { a1: [turn()] } } as any);
    await render();
    const paths = container.querySelector('[data-testid="witnessed-paths"]');
    expect(paths).toBeTruthy();
    expect(paths?.textContent).toContain('src/config.ts');
  });

  it('shows the witnessed diff first-class AND the labeled unattributed window section', async () => {
    useDashboardStore.setState({ checkpointTurns: { a1: [turn()] } } as any);
    await render();

    await act(async () => {
      buttonByText('Show diff')!.click();
    });
    // Let the mocked diff promise resolve + re-render.
    await act(async () => { await Promise.resolve(); });

    const diffBlock = container.querySelector('[data-testid="turn-diff"]');
    expect(diffBlock).toBeTruthy();
    // Witnessed changes are rendered first-class.
    expect(diffBlock?.textContent).toContain('witnessed changes');
    expect(diffBlock?.textContent).toContain('WITNESSED-DIFF-BODY');
    // The raw window is present but SEPARATELY LABELED as unattributed.
    const label = container.querySelector('[data-testid="unattributed-label"]');
    expect(label?.textContent).toContain('unattributed changes in this window');
    expect(diffBlock?.textContent).toContain('RAW-WINDOW-DIFF-BODY');
    expect((window as any).api.checkpoints.diff).toHaveBeenCalledWith('ws', 't1');
  });

  it('marks a path contended when another OPEN turn witnesses it', async () => {
    const open1 = turn({ turnId: 't1', endedAt: null, status: 'open', witnessedPaths: ['src/shared.ts'] });
    const open2 = turn({ turnId: 't2', turnSeq: 2, endedAt: null, status: 'open', witnessedPaths: ['src/shared.ts'] });
    // The mount effect re-loads via the list channel, so the mock (not just the
    // seed) must carry the two open turns or the refresh would overwrite them.
    (window as any).api.checkpoints.list = vi.fn(async () => ({ workspaceId: 'ws', turns: [open1, open2] }));
    useDashboardStore.setState({ checkpointTurns: { a1: [open1, open2] } } as any);
    await render();
    await act(async () => { await Promise.resolve(); });
    const markers = container.querySelectorAll('[data-testid="contention-marker"]');
    expect(markers.length).toBeGreaterThan(0);
    expect(markers[0].textContent).toContain('contended');
  });

  it('loads the agent checkpoints on mount via the WP-G2.2 list channel', async () => {
    await render();
    expect((window as any).api.checkpoints.list).toHaveBeenCalledWith('ws', { agentId: 'a1' });
  });
});
