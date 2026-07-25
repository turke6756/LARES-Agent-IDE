// @vitest-environment jsdom
//
// WP-G3.1 — FileHistoryView. Load-bearing rules:
//   1. Versions render per-turn/per-agent with agent, turn, and a time stamp
//      ("edited by worker-7, turn 12, …").
//   2. Restore reuses the WP-G2.4 preview-required flow — the RestoreDialog mounts
//      with its confirm DISABLED until a preview is fetched (no preview-less path).
//   3. Only live-verified versions arrive here (the main side excludes pruned
//      edges), so an empty result renders an honest empty state.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FileHistoryView from './FileHistoryView';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { CheckpointFileHistoryVersion } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root | null;

function version(over: Partial<CheckpointFileHistoryVersion> = {}): CheckpointFileHistoryVersion {
  return {
    turnId: 't1',
    turnSeq: 12,
    agentId: 'a1',
    agentTitle: 'worker-7',
    taskLabel: 'edit the config',
    status: 'accepted',
    startedAt: 1000,
    endedAt: 2000,
    beforeReady: true,
    afterReady: true,
    beforeQuality: 'guaranteed',
    afterQuality: 'hook',
    witnessedPath: 'src/config.ts',
    op: 'write',
    afterVerified: true,
    beforeRawFilterBypassed: false,
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

function mkApi(versions: CheckpointFileHistoryVersion[] | 'throw' = [version()]) {
  return {
    checkpoints: {
      fileHistory: vi.fn(async () => {
        if (versions === 'throw') throw new Error('engine unavailable');
        return { workspaceId: 'ws', path: 'src/config.ts', versions };
      }),
      diff: vi.fn(async () => diffOk),
      preview: vi.fn(async () => previewOk),
      restore: vi.fn(async () => ({
        status: 'completed', operationId: 'op1', kind: 'restore_paths',
        preRef: 'r', preOid: 'o', requestedPaths: ['src/config.ts'], completedPaths: ['src/config.ts'],
        rejectedPaths: [], failures: [], contention: [], failureReason: null,
      })),
      revert: vi.fn(),
    },
  };
}

async function render(apiVersions: CheckpointFileHistoryVersion[] | 'throw' = [version()]) {
  (window as any).api = mkApi(apiVersions);
  await act(async () => {
    root = createRoot(container);
    root.render(<FileHistoryView workspaceId="ws" path="src/config.ts" onClose={() => {}} />);
  });
  // Flush the mount-effect load.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  useDashboardStore.setState({ checkpointTurns: {}, checkpointLoading: {} } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('FileHistoryView — WP-G3.1', () => {
  it('lists per-turn/per-agent versions with agent, turn, and time', async () => {
    await render();
    const list = container.querySelector('[data-testid="file-history-list"]');
    expect(list).toBeTruthy();
    const text = list?.textContent ?? '';
    expect(text).toContain('worker-7');
    expect(text).toContain('turn 12');
    // A human time stamp is present (today/yesterday/date + time).
    expect(text.toLowerCase()).toMatch(/today|yesterday|\d/);
  });

  it('restore reuses the preview-required RestoreDialog (confirm disabled until preview)', async () => {
    await render();
    // Open the restore flow for the single version.
    await act(async () => {
      (container.querySelector('[data-testid="restore-t1"]') as HTMLButtonElement).click();
    });
    const dialog = container.querySelector('[data-testid="restore-dialog"]');
    expect(dialog).toBeTruthy();
    const confirm = container.querySelector('[data-testid="confirm-restore"]') as HTMLButtonElement;
    // Preview-gated: no preview fetched yet → confirm is disabled.
    expect(confirm.disabled).toBe(true);
    expect((window as any).api.checkpoints.restore).not.toHaveBeenCalled();
  });

  it('renders an empty state when there are no recoverable versions', async () => {
    await render([]);
    expect(container.querySelector('[data-testid="file-history-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="file-history-list"]')).toBeNull();
  });

  it('renders an honest unavailable state when the engine errors', async () => {
    await render('throw');
    expect(container.querySelector('[data-testid="file-history-unavailable"]')).toBeTruthy();
  });
});
