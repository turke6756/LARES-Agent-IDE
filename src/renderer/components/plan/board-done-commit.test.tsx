// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CommitCoordinatorConsumeResponse,
  MissionBoardCard,
  MissionBoardPackageTimeline,
  SaveCardPreviewResponse,
} from '../../../shared/types';
import { useMissionBoardStore } from '../../stores/mission-board-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../checkpoints/FileHistoryView', () => ({ default: () => null }));
vi.mock('../checkpoints/AttributionPanel', () => ({ default: () => null }));
vi.mock('../checkpoints/RestoreDialog', () => ({ default: () => null }));

import MissionBoard from './MissionBoard';

const timeline: MissionBoardPackageTimeline[] = [{
  packageId: 'WP-P6D',
  events: [{
    source: 'lifecycle', eventId: 'life-1', packageId: 'WP-P6D', occurredAt: 10,
    fromState: 'ready', toState: 'executing', actor: 'supervisor', reason: 'started',
  }, {
    source: 'finalization', eventId: 'fin-1', packageId: 'WP-P6D', occurredAt: 20,
    toState: 'done', actor: 'human-ipc', packageRevision: 1, checkpointTurnId: 'turn-1',
    boundaryStatus: 'ready', lifecycleStatus: 'active',
  }],
}];

function card(state: MissionBoardCard['state']): MissionBoardCard {
  return {
    packageId: 'WP-P6D', workspaceId: 'ws-1', planId: 'plan-1', title: 'Done and commit',
    acceptanceCondition: null, state, assigneeAgentId: 'agent-1', revision: 1,
    createdAt: 1, updatedAt: 2, plannedPaths: [], durableTurns: [], recoveryOperations: [],
    liveActivity: [{
      turnId: 'turn-live', workspaceId: 'ws-1', turnSeq: 2, agentId: 'agent-1',
      taskLabel: 'Still working', startedAt: 30, planId: 'plan-1', planItemId: 'WP-P6D',
      planStampSource: 'prompt', planStampStatus: 'verified', association: 'package-stamp',
      touched: [{ path: 'src/renderer/board.tsx', op: 'write' }], isActive: true,
    }],
  };
}

const savePreview: SaveCardPreviewResponse = {
  isCandidate: true,
  candidate: {
    candidateId: 'candidate-1', contractVersion: 1,
    repository: {
      repositoryKey: 'repo-1', objectDatabaseKey: 'objects-1', gitObjectFormat: 'sha1',
      bareRepo: false, workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
    },
    componentIds: ['component-1'], selectedUnattributedEntryIds: [],
    members: [{
      entryId: 'entry-1',
      path: { pathBytesBase64: 'c3JjL2JvYXJkLnRzeA==', displayPath: 'src/board.tsx', utf8Clean: true },
      expectedWorktreeState: 'present', rawWorktreeBlobOid: 'raw', expectedCommitBlobOid: 'blob',
      expectedCommitMode: '100644', checkpointMode: '100644', coveringFinalizationIds: ['fin-1'],
      packageVerification: 'verified-match', protection: 'checkpoint-protected',
    }],
    finalizations: [{ finalizationId: 'fin-1', packageId: 'plan-package:WP-P6D', packageRevision: 1, boundaryStatus: 'ready' }],
    eligibility: { eligible: true },
    token: null,
  },
  laresTrailers: ['Lares-Plan: plan-1'], defaultMessageBody: 'Save WP-P6D',
  requiresOverlapAck: false, unacknowledgedUnattributedEntryIds: [], componentTopologyDigest: 'topo-1',
  selectionDrift: { added: [], missing: [], reAttributed: [], byteMoved: [] },
  selectionDriftDisplayPaths: {},
  pinnedSelection: { selectedComponentIds: ['component-1'], selectedUnattributedEntryIds: [], frozenMemberCount: 1 },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let finalizeItemDone: ReturnType<typeof vi.fn>;
let previewCandidate: ReturnType<typeof vi.fn>;
let commit: ReturnType<typeof vi.fn>;

async function renderBoard(state: MissionBoardCard['state'], outcome?: CommitCoordinatorConsumeResponse) {
  finalizeItemDone = vi.fn(async () => ({ outcome: 'created' }));
  previewCandidate = vi.fn(async () => ({
    candidate: savePreview.candidate,
    isCandidate: true,
    selection: {
      selectedComponentIds: ['component-1'], selectedUnattributedEntryIds: [], finalizationIds: ['fin-1'],
    },
  }));
  commit = vi.fn(async () => outcome ?? ({
    kind: 'saved',
    outcome: { status: 'committed', commitOid: 'oid-1', attemptId: 'attempt-1', indexIntegrity: 'verified' },
    finalizations: [],
  }));
  (window as unknown as { api: unknown }).api = {
    plans: { finalizeItemDone, previewCandidate },
    saveCard: { preview: vi.fn(async () => savePreview) },
    commitCoordinator: {
      mint: vi.fn(async () => ({
        ...savePreview,
        candidate: {
          ...savePreview.candidate,
          token: { tokenId: 'token-1', candidateId: 'candidate-1', contractVersion: 1, issuedAt: 1, expiresAt: 2 },
        },
      })),
      commit,
    },
    checkpoints: {},
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MissionBoard
        planId="plan-1"
        paneVisible
        listCards={vi.fn(async () => [card(state)])}
        listTimeline={vi.fn(async () => timeline)}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(selector: string): Promise<void> {
  await act(async () => {
    (container!.querySelector(selector) as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => useMissionBoardStore.setState({ boards: {} }));
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  delete (window as unknown as { api?: unknown }).api;
  vi.clearAllMocks();
});

describe('WP-P6D board done + commit integration', () => {
  it('routes done only through SC-WP-3D and never infers it from live activity', async () => {
    await renderBoard('executing');
    const cardElement = container!.querySelector('[data-testid="work-package-card-WP-P6D"]')!;
    expect(cardElement.getAttribute('data-live-active')).toBe('true');
    expect(cardElement.getAttribute('data-state')).toBe('executing');
    await click('[data-testid="mark-done-WP-P6D"]');
    expect(finalizeItemDone).toHaveBeenCalledTimes(1);
    expect(finalizeItemDone).toHaveBeenCalledWith({ planItemId: 'WP-P6D' });
    expect(cardElement.getAttribute('data-state')).not.toBe('done');
  });

  it('renders lifecycle and authoritative finalization events in backend order', async () => {
    await renderBoard('done');
    const events = [...container!.querySelectorAll('[aria-label="Package timeline"] li')];
    expect(events.map((event) => event.getAttribute('data-source'))).toEqual(['lifecycle', 'finalization']);
    expect(events[0].textContent).toContain('ready → executing');
    expect(events[1].textContent).toContain('Done (revision 1)');
  });

  const outcomes: Array<[string, CommitCoordinatorConsumeResponse]> = [
    ['saved', { kind: 'saved', outcome: { status: 'committed', commitOid: 'oid', attemptId: 'a1', indexIntegrity: 'verified' }, finalizations: [] }],
    ['stale-refused', { kind: 'outcome', outcome: { status: 'aborted-stale', reason: 'changed', attemptId: 'a2' } }],
    ['integrity-incident', { kind: 'outcome', outcome: { status: 'committed-integrity-mismatch', commitOid: 'oid', attemptId: 'a3', mismatchedPaths: [], indexIntegrity: 'verified' } }],
    ['repository-uncertain', { kind: 'outcome', outcome: { status: 'repository-state-uncertain', pinnedHeadOid: 'before', resolvedHeadOid: 'after', attemptId: 'a4' } }],
  ];

  it.each(outcomes)('uses Plan resolution, the shared coordinator, and shared %s outcome', async (state, outcome) => {
    await renderBoard('done', outcome);
    await click('[data-testid="commit-package-WP-P6D"]');
    expect(previewCandidate).toHaveBeenCalledWith({
      workspaceId: 'ws-1', planId: 'plan-1', selectedComponentIds: [],
      selectedUnattributedEntryIds: [], finalizationIds: ['fin-1'],
    });
    await click('[data-testid="candidate-preview-save"]');
    expect(commit).toHaveBeenCalledWith({ candidateId: 'candidate-1', tokenId: 'token-1', message: 'Save WP-P6D' });
    expect(container!.querySelector('[data-testid="commit-outcome"]')?.getAttribute('data-state')).toBe(state);
  });
});
