// @vitest-environment jsdom
//
// WP-G3.2 — the richer, workspace-scoped attribution UI. The component must:
//   • render an UNATTRIBUTED (witnessed-empty, shell-mediated) turn ONLY in the
//     labeled unattributed partition — never as attributed (§7 G3 gate);
//   • list EVERY contending open turn/agent for a shared path (cross-agent);
//   • narrow the turn list as filters change;
//   • show statistics that match the fixture;
//   • in the comparison, show witnessed (attributed) and raw-window (unattributed)
//     side-by-side, the window clearly labeled and never attributed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AttributionPanel from './AttributionPanel';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { CheckpointTurnSummary, CheckpointDiffResult } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root | null;

function turn(over: Partial<CheckpointTurnSummary> = {}): CheckpointTurnSummary {
  return {
    turnId: 't',
    turnSeq: 1,
    agentId: 'a1',
    agentTitle: 'Alpha',
    taskLabel: 'task',
    status: 'completed',
    startedAt: 1000,
    endedAt: 2000,
    beforeReady: true,
    afterReady: true,
    beforeQuality: 'guaranteed',
    afterQuality: 'hook',
    witnessedPaths: ['src/a.ts'],
    failureReason: null,
    ...over,
  };
}

// Two OPEN turns from DIFFERENT agents witnessing the same path → contention.
const openA = turn({ turnId: 'oA', agentId: 'a1', agentTitle: 'Alpha', endedAt: null, status: 'open', taskLabel: 'edit shared', witnessedPaths: ['src/shared.ts'] });
const openB = turn({ turnId: 'oB', agentId: 'a2', agentTitle: 'Beta', endedAt: null, status: 'open', taskLabel: 'also shared', witnessedPaths: ['src/shared.ts'] });
// A witnessed-empty, shell-mediated turn — must stay in the unattributed partition.
const shell = turn({ turnId: 'shell', agentId: 'a3', agentTitle: 'Gamma', endedAt: 3000, status: 'completed', taskLabel: 'run build script', witnessedPaths: [] });

const ALL_TURNS = [openA, openB, shell];

const diffResult: CheckpointDiffResult = {
  workspaceId: 'ws',
  turnId: 'shell',
  witnessed: { available: true, reason: null, label: 'witnessed changes', text: '', provenance: 'witnessed' },
  window: {
    available: true,
    reason: null,
    label: 'unattributed changes in this window',
    text: 'SHELL-WROTE-THIS-FILE',
    provenance: 'raw-window',
  },
};

async function render() {
  await act(async () => {
    root = createRoot(container);
    root.render(<AttributionPanel workspaceId="ws" onClose={() => {}} />);
  });
  // Let the mount-effect list load + re-render.
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  (window as any).api = {
    checkpoints: {
      list: vi.fn(async () => ({ workspaceId: 'ws', turns: ALL_TURNS })),
      diff: vi.fn(async () => diffResult),
      preview: vi.fn(),
      restore: vi.fn(),
      revert: vi.fn(),
    },
  };
  useDashboardStore.setState({ workspaceCheckpointTurns: {}, workspaceCheckpointLoading: {} } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  useDashboardStore.setState({ workspaceCheckpointTurns: {}, workspaceCheckpointLoading: {} } as any);
});

describe('AttributionPanel — WP-G3.2', () => {
  it('loads all workspace turns on mount (list with no agentId)', async () => {
    await render();
    expect((window as any).api.checkpoints.list).toHaveBeenCalledWith('ws');
  });

  it('renders the shell-mediated turn ONLY in the labeled unattributed partition', async () => {
    await render();
    const attributed = container.querySelector('[data-testid="attributed-partition"]')!;
    const unattributed = container.querySelector('[data-testid="unattributed-partition"]')!;

    // The shell turn's label appears in the unattributed partition, NOT the attributed one.
    expect(unattributed.textContent).toContain('run build script');
    expect(attributed.textContent).not.toContain('run build script');

    // The partition carries the explicit unattributed label (styled uppercase via
    // CSS; assert the phrase case-insensitively).
    const label = container.querySelector('[data-testid="unattributed-partition-label"]');
    expect(label?.textContent?.toLowerCase()).toContain('unattributed changes in this window');

    // The attributed partition holds the two witnessed turns.
    expect(attributed.textContent).toContain('edit shared');
    expect(attributed.textContent).toContain('also shared');
  });

  it('lists every contending open turn/agent for a shared path', async () => {
    await render();
    const section = container.querySelector('[data-testid="contention-section"]')!;
    expect(section).toBeTruthy();
    const paths = section.querySelectorAll('[data-testid="contended-path"]');
    expect(paths.length).toBe(1);
    expect(section.textContent).toContain('src/shared.ts');
    const contenders = section.querySelectorAll('[data-testid="contender"]');
    expect(contenders.length).toBe(2);
    expect(section.textContent).toContain('Alpha');
    expect(section.textContent).toContain('Beta');
    // Never implies a clean per-agent split.
    expect(section.textContent).toContain('not cleanly attributable');
  });

  it('statistics match the fixture', async () => {
    await render();
    expect(container.querySelector('[data-testid="stat-turns"]')?.textContent).toContain('3');
    expect(container.querySelector('[data-testid="stat-attributed"]')?.textContent).toContain('2');
    expect(container.querySelector('[data-testid="stat-unattributed"]')?.textContent).toContain('1');
    // distinct witnessed paths: only src/shared.ts (both open turns) → 1
    expect(container.querySelector('[data-testid="stat-files"]')?.textContent).toContain('1');
    expect(container.querySelector('[data-testid="stat-contended"]')?.textContent).toContain('1');
    // three agents in the per-agent table
    expect(container.querySelectorAll('[data-testid="agent-stat-row"]').length).toBe(3);
  });

  it('filters narrow the partitions (attributed-only hides the unattributed turn)', async () => {
    await render();
    const select = container.querySelector('[data-testid="filter-attribution"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'attributed';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const unattributed = container.querySelector('[data-testid="unattributed-partition"]')!;
    expect(unattributed.textContent).not.toContain('run build script');
    expect(unattributed.textContent).toContain('No unattributed turns match');
  });

  it('path filter narrows the attributed partition', async () => {
    await render();
    const input = container.querySelector('[data-testid="filter-path"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'nonexistent-path');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const attributed = container.querySelector('[data-testid="attributed-partition"]')!;
    expect(attributed.textContent).toContain('No attributed turns match');
  });

  it('comparison shows witnessed (attributed) and raw-window (unattributed) side-by-side, window never attributed', async () => {
    await render();
    // Expand the comparison on the shell (unattributed) turn — scope the button
    // lookup to the unattributed partition (attributed rows have the same button).
    const unattributedPartition = container.querySelector('[data-testid="unattributed-partition"]')!;
    const compareBtn = Array.from(unattributedPartition.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Compare attributed vs unattributed'),
    )!;
    await act(async () => { compareBtn.click(); });
    await act(async () => { await Promise.resolve(); });

    const comparison = container.querySelector('[data-testid="comparison"]')!;
    expect(comparison).toBeTruthy();
    // The witnessed (attributed) side shows the "attributed nothing" state for a shell turn.
    const attrCol = container.querySelector('[data-testid="comparison-attributed"]')!;
    expect(attrCol.textContent).toContain('attributed nothing');
    // The unattributed column shows the raw window bytes, clearly NOT attributed.
    const winCol = container.querySelector('[data-testid="comparison-unattributed"]')!;
    expect(winCol.textContent).toContain('SHELL-WROTE-THIS-FILE');
    const winLabel = container.querySelector('[data-testid="comparison-unattributed-label"]')!;
    expect(winLabel.textContent).toContain('unattributed changes in this window');
    expect(winLabel.textContent).toContain('not attributed');
    expect((window as any).api.checkpoints.diff).toHaveBeenCalledWith('ws', 'shell');
  });

  it('shows an honest empty state when the workspace has no checkpoints', async () => {
    (window as any).api.checkpoints.list = vi.fn(async () => ({ workspaceId: 'ws', turns: [] }));
    await render();
    expect(container.querySelector('[data-testid="attribution-empty"]')).toBeTruthy();
  });
});
