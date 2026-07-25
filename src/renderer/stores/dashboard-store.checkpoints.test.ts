// @vitest-environment jsdom
//
// WP-G2.4 — the dashboard store's checkpoint actions. The load-bearing behavior:
// after a restore/revert the store MUST re-load the agent's turns (a restore always
// leaves a recoverable pre-restore checkpoint that should appear on the rail), and
// the refresh must go through the WP-G2.2 list channel AFTER the mutation resolves.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useDashboardStore } from './dashboard-store';
import type { CheckpointTurnSummary } from '../../shared/types';

function turn(over: Partial<CheckpointTurnSummary> = {}): CheckpointTurnSummary {
  return {
    turnId: 't1', turnSeq: 1, agentId: 'a1', agentTitle: 'Alpha', taskLabel: 'x',
    status: 'completed', startedAt: 1, endedAt: 2, beforeReady: true, afterReady: true,
    beforeQuality: 'guaranteed', afterQuality: 'hook', witnessedPaths: ['src/x.ts'],
    failureReason: null, ...over,
  };
}

const restoreDone = {
  status: 'completed' as const, operationId: 'op1', kind: 'restore_paths' as const,
  preRef: 'refs/lares/pre', preOid: 'pre1', requestedPaths: ['src/x.ts'],
  completedPaths: ['src/x.ts'], rejectedPaths: [], failures: [], contention: [], failureReason: null,
};

const callOrder: string[] = [];

beforeEach(() => {
  callOrder.length = 0;
  (window as any).api = {
    checkpoints: {
      list: vi.fn(async () => { callOrder.push('list'); return { workspaceId: 'ws', turns: [turn(), turn({ turnId: 't2', turnSeq: 2 })] }; }),
      restore: vi.fn(async () => { callOrder.push('restore'); return restoreDone; }),
      revert: vi.fn(async () => { callOrder.push('revert'); return { ...restoreDone, kind: 'revert_turn' as const }; }),
      preview: vi.fn(),
      diff: vi.fn(),
    },
  };
  useDashboardStore.setState({ checkpointTurns: {}, checkpointLoading: {} } as any);
});

afterEach(() => {
  useDashboardStore.setState({ checkpointTurns: {}, checkpointLoading: {} } as any);
});

describe('dashboard store — checkpoint actions (WP-G2.4)', () => {
  it('loadCheckpointTurns fills the per-agent slice from the list channel', async () => {
    await useDashboardStore.getState().loadCheckpointTurns('ws', 'a1');
    expect((window as any).api.checkpoints.list).toHaveBeenCalledWith('ws', { agentId: 'a1' });
    expect(useDashboardStore.getState().checkpointTurns['a1']).toHaveLength(2);
    expect(useDashboardStore.getState().checkpointLoading['a1']).toBe(false);
  });

  it('restoreCheckpointPaths refreshes the agent rail AFTER the mutation', async () => {
    const res = await useDashboardStore.getState().restoreCheckpointPaths(
      { workspaceId: 'ws', turnId: 't1', paths: ['src/x.ts'], previewTokens: { 'src/x.ts': 'oid' } },
      'a1',
    );
    expect(res.status).toBe('completed');
    expect((window as any).api.checkpoints.restore).toHaveBeenCalledTimes(1);
    // The refresh runs, and it runs AFTER the restore (never before).
    expect(callOrder).toEqual(['restore', 'list']);
    expect(useDashboardStore.getState().checkpointTurns['a1']).toHaveLength(2);
  });

  it('revertCheckpointTurn refreshes the agent rail AFTER the mutation', async () => {
    await useDashboardStore.getState().revertCheckpointTurn(
      { workspaceId: 'ws', turnId: 't1' },
      'a1',
    );
    expect(callOrder).toEqual(['revert', 'list']);
    expect(useDashboardStore.getState().checkpointTurns['a1']).toHaveLength(2);
  });

  it('a failed list load clears the spinner without throwing', async () => {
    (window as any).api.checkpoints.list = vi.fn(async () => { throw new Error('engine unavailable'); });
    await expect(useDashboardStore.getState().loadCheckpointTurns('ws', 'a1')).resolves.toBeUndefined();
    expect(useDashboardStore.getState().checkpointLoading['a1']).toBe(false);
  });
});
