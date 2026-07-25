// @vitest-environment jsdom
//
// WP-G2.4 — the RestoreDialog. Three load-bearing rules:
//   1. A restore CANNOT be confirmed without a preview (the confirm button stays
//      disabled until a preview is fetched — it carries the anti-TOCTOU tokens).
//   2. The content-semantics warning shows when the turn's before-edge captured
//      filter-managed bytes as raw on-disk bytes (beforeRawFilterBypassed).
//   3. The raw window diff is shown but clearly LABELED "unattributed changes in
//      this window".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import RestoreDialog, { FILTER_BYPASS_WARNING } from './RestoreDialog';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { CheckpointTurnSummary } from '../../../shared/types';

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

const previewOk = {
  available: true, reason: null, turnId: 't1', witnessedSet: ['src/config.ts'],
  tokens: { 'src/config.ts': 'oid-abc' }, validatedPaths: ['src/config.ts'],
  rejectedPaths: [], contention: [],
};
const diffOk = {
  workspaceId: 'ws', turnId: 't1',
  witnessed: { available: true, reason: null, label: 'witnessed changes', text: 'W' },
  window: { available: true, reason: null, label: 'unattributed changes in this window', text: 'RAW' },
};
const restoreDone = {
  status: 'completed' as const, operationId: 'op1', kind: 'restore_paths' as const,
  preRef: 'refs/lares/x', preOid: 'pre1', requestedPaths: ['src/config.ts'],
  completedPaths: ['src/config.ts'], rejectedPaths: [], failures: [], contention: [], failureReason: null,
};

function mkApi() {
  return {
    checkpoints: {
      list: vi.fn(async () => ({ workspaceId: 'ws', turns: [turn()] })),
      diff: vi.fn(async () => diffOk),
      preview: vi.fn(async () => previewOk),
      restore: vi.fn(async () => restoreDone),
      revert: vi.fn(async () => ({ ...restoreDone, kind: 'revert_turn' as const })),
    },
  };
}

async function render(props: Partial<React.ComponentProps<typeof RestoreDialog>> = {}) {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <RestoreDialog
        workspaceId="ws"
        agentId="a1"
        turn={turn()}
        mode="restore"
        paths={['src/config.ts']}
        onClose={() => {}}
        {...props}
      />,
    );
  });
}

const confirmBtn = () => container.querySelector('[data-testid="confirm-restore"]') as HTMLButtonElement | null;
const previewBtn = () =>
  Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Preview')) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  (window as any).api = mkApi();
  useDashboardStore.setState({ checkpointTurns: {}, checkpointLoading: {} } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  useDashboardStore.setState({ checkpointTurns: {}, checkpointLoading: {} } as any);
});

describe('RestoreDialog — WP-G2.4', () => {
  it('BLOCKS a restore until a preview is fetched', async () => {
    await render();
    // No preview yet → confirm is disabled and clicking it does nothing.
    expect(confirmBtn()?.disabled).toBe(true);
    await act(async () => { confirmBtn()!.click(); });
    expect((window as any).api.checkpoints.restore).not.toHaveBeenCalled();

    // Fetch the preview → confirm unlocks.
    await act(async () => { previewBtn()!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect((window as any).api.checkpoints.preview).toHaveBeenCalledWith('ws', 't1', ['src/config.ts']);
    expect(confirmBtn()?.disabled).toBe(false);

    // Now a confirm goes through, echoing the preview token back.
    await act(async () => { confirmBtn()!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect((window as any).api.checkpoints.restore).toHaveBeenCalledTimes(1);
    const req = (window as any).api.checkpoints.restore.mock.calls[0][0];
    expect(req.paths).toEqual(['src/config.ts']);
    expect(req.previewTokens).toEqual({ 'src/config.ts': 'oid-abc' });
  });

  it('shows the filtered-content warning ONLY when before_raw_filter_bypassed', async () => {
    await render({ turn: turn({ beforeRawFilterBypassed: true }) });
    const warn = container.querySelector('[data-testid="filter-bypass-warning"]');
    expect(warn).toBeTruthy();
    expect(warn?.textContent).toContain(FILTER_BYPASS_WARNING);
  });

  it('does NOT show the filtered-content warning when the flag is unset', async () => {
    await render({ turn: turn({ beforeRawFilterBypassed: false }) });
    expect(container.querySelector('[data-testid="filter-bypass-warning"]')).toBeNull();
  });

  it('labels the raw window section as unattributed once previewed', async () => {
    await render();
    await act(async () => { previewBtn()!.click(); });
    await act(async () => { await Promise.resolve(); });
    const win = container.querySelector('[data-testid="unattributed-window"]');
    expect(win?.textContent).toContain('unattributed changes in this window');
    expect(win?.textContent).toContain('RAW');
  });
});
