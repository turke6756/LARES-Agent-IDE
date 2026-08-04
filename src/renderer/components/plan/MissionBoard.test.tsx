// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MissionBoardCard } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useMissionBoardStore } from '../../stores/mission-board-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../checkpoints/FileHistoryView', () => ({
  default: ({ workspaceId, path }: { workspaceId: string; path: string }) => (
    <div data-testid="file-history-view" data-workspace-id={workspaceId} data-path={path} />
  ),
}));
vi.mock('../checkpoints/AttributionPanel', () => ({
  default: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="attribution-panel" data-workspace-id={workspaceId} />
  ),
}));
vi.mock('../checkpoints/RestoreDialog', () => ({ default: () => <div data-testid="restore-dialog" /> }));

import MissionBoard from './MissionBoard';
import PlanSurfaceView from './PlanSurfaceView';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let fileHistory: ReturnType<typeof vi.fn>;
let diff: ReturnType<typeof vi.fn>;
let boardList: ReturnType<typeof vi.fn>;

function activeCard(): MissionBoardCard {
  return {
    packageId: 'WP-P6C',
    workspaceId: 'ws-1',
    planId: 'plan-1',
    title: 'Mission board renderer',
    acceptanceCondition: null,
    state: 'executing',
    assigneeAgentId: 'agent-9',
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    plannedPaths: [],
    liveActivity: [{
      turnId: 'turn-9',
      workspaceId: 'ws-1',
      turnSeq: 9,
      agentId: 'agent-9',
      taskLabel: 'Renderer pass',
      startedAt: 100,
      planId: 'plan-1',
      planItemId: 'WP-P6C',
      planStampSource: 'prompt',
      planStampStatus: 'verified',
      touched: [{ path: 'src/renderer/components/plan/MissionBoard.tsx', op: 'write' }],
      association: 'package-stamp',
      isActive: true,
    }],
    durableTurns: [],
    recoveryOperations: [],
  };
}

async function renderBoard(listCards = vi.fn(async () => [activeCard()])): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MissionBoard planId="plan-1" paneVisible listCards={listCards} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  useMissionBoardStore.setState({ boards: {} });
  useDashboardStore.setState({ openTabs: [], activeTabId: null });
  fileHistory = vi.fn(async () => ({ workspaceId: 'ws-1', path: '', versions: [] }));
  diff = vi.fn(async () => ({
    workspaceId: 'ws-1',
    turnId: 'turn-9',
    witnessed: { available: true, reason: null, label: 'witnessed changes', text: 'diff' },
    window: { available: true, reason: null, label: 'unattributed changes in this window', text: '' },
  }));
  boardList = vi.fn(async () => [activeCard()]);
  (window as unknown as { api: unknown }).api = {
    checkpoints: { fileHistory, diff },
    plans: { boardList },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe('MissionBoard', () => {
  it('renders a polled live touch as activity without changing package completion', async () => {
    await renderBoard();
    const card = container!.querySelector('[data-testid="work-package-card-WP-P6C"]')!;
    expect(card.getAttribute('data-live-active')).toBe('true');
    expect(card.getAttribute('data-state')).toBe('executing');
    expect(card.getAttribute('data-state')).not.toBe('done');
  });

  it('opens FileHistoryView for the clicked path with the contributor selected', async () => {
    await renderBoard();
    act(() => {
      (container!.querySelector('.work-package-card__file') as HTMLButtonElement).click();
    });
    expect(fileHistory).toHaveBeenCalledWith(
      'ws-1',
      'src/renderer/components/plan/MissionBoard.tsx',
      { agentId: 'agent-9' },
    );
    const selected = container!.querySelector('[data-selected-turn-id="turn-9"]')!;
    const history = selected.querySelector('[data-testid="file-history-view"]')!;
    expect(history.getAttribute('data-path')).toBe('src/renderer/components/plan/MissionBoard.tsx');
  });

  it('uses a distinct secondary action for the turn-wide diff and AttributionPanel', async () => {
    await renderBoard();
    act(() => {
      (container!.querySelector('[data-testid="turn-diff-turn-9"]') as HTMLButtonElement).click();
    });
    expect(diff).toHaveBeenCalledWith('ws-1', 'turn-9');
    expect(fileHistory).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="attribution-panel"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="file-history-view"]')).toBeNull();
  });

  it('mounts from the Packages tab of PlanSurfaceView for the active plan', async () => {
    useDashboardStore.setState({
      openTabs: [{
        id: 'plan:plan-1',
        kind: 'plan',
        planId: 'plan-1',
        workspaceId: 'ws-1',
        rootDirectory: 'C:/workspace',
        filePath: '',
        pathType: 'windows',
        label: 'Plan',
      }],
      activeTabId: 'plan:plan-1',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <PlanSurfaceView
          projection={{ parseError: null, warnings: [], degradedFrom: null }}
          sections={[]}
          events={[]}
          workspaceId="ws-1"
        />,
      );
    });
    await act(async () => {
      (container!.querySelector('[data-testid="plan-view-packages"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(boardList).toHaveBeenCalledWith('plan-1');
    expect(container!.querySelector('[data-testid="mission-board"]')).not.toBeNull();
  });
});
