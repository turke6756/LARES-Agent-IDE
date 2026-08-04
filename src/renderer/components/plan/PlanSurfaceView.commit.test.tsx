// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CommitCoordinatorConsumeResponse,
  SaveCardPreviewResponse,
} from '../../../shared/types';
import PlanSurfaceView from './PlanSurfaceView';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const selection = {
  selectedComponentIds: ['component-1'],
  selectedUnattributedEntryIds: [],
  finalizationIds: ['finalization-1'],
};

const preview: SaveCardPreviewResponse = {
  isCandidate: true,
  candidate: {
    candidateId: 'candidate-shared-1',
    contractVersion: 1,
    repository: {
      repositoryKey: 'repo-1',
      objectDatabaseKey: 'objects-1',
      gitObjectFormat: 'sha1',
      bareRepo: false,
      workspaces: [{ workspaceId: 'workspace-1', workspacePrefix: '' }],
    },
    componentIds: ['component-1'],
    selectedUnattributedEntryIds: [],
    members: [{
      entryId: 'entry-1',
      path: { pathBytesBase64: 'c3JjL3BsYW4udHM=', displayPath: 'src/plan.ts', utf8Clean: true },
      expectedWorktreeState: 'present',
      rawWorktreeBlobOid: 'raw-1',
      expectedCommitBlobOid: 'commit-1',
      expectedCommitMode: '100644',
      checkpointMode: '100644',
      coveringFinalizationIds: ['finalization-1'],
      packageVerification: 'verified-match',
      protection: 'checkpoint-protected',
    }],
    finalizations: [{
      finalizationId: 'finalization-1',
      packageId: 'package-1',
      packageRevision: 1,
      boundaryStatus: 'ready',
    }],
    eligibility: { eligible: true },
    token: {
      tokenId: 'token-shared-1',
      candidateId: 'candidate-shared-1',
      contractVersion: 1,
      issuedAt: 1,
      expiresAt: 2,
    },
  },
  laresTrailers: ['Lares-Plan: plan-1'],
  defaultMessageBody: 'Save finalized plan work',
  requiresOverlapAck: false,
  unacknowledgedUnattributedEntryIds: [],
};

let container: HTMLDivElement;
let root: Root;

async function renderAndCommit(response: CommitCoordinatorConsumeResponse): Promise<void> {
  const commit = vi.fn(async () => response);
  (window as unknown as { api: unknown }).api = {
    saveCard: { preview: vi.fn(async () => preview) },
    commitCoordinator: { commit },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[]}
        events={[]}
        workspaceId="workspace-1"
        candidateSelection={selection}
      />,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  const save = container.querySelector('[data-testid="candidate-preview-save"]') as HTMLButtonElement;
  expect(save.disabled).toBe(false);
  await act(async () => { save.click(); });

  expect(commit).toHaveBeenCalledWith({
    candidateId: 'candidate-shared-1',
    tokenId: 'token-shared-1',
    message: 'Save finalized plan work',
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  delete (window as unknown as { api?: unknown }).api;
});

describe('SC-WP-4L Plan-lens commit wiring', () => {
  const cases: Array<[string, CommitCoordinatorConsumeResponse]> = [
    ['saved', {
      kind: 'saved',
      outcome: { status: 'committed', commitOid: 'saved-oid', attemptId: 'attempt-1', indexIntegrity: 'verified' },
      finalizations: [],
    }],
    ['stale-refused', {
      kind: 'outcome',
      outcome: { status: 'aborted-stale', reason: 'candidate changed', attemptId: 'attempt-2' },
    }],
    ['integrity-incident', {
      kind: 'outcome',
      outcome: {
        status: 'committed-integrity-mismatch',
        commitOid: 'incident-oid',
        attemptId: 'attempt-3',
        mismatchedPaths: [],
        indexIntegrity: 'verified',
      },
    }],
    ['repository-uncertain', {
      kind: 'outcome',
      outcome: {
        status: 'repository-state-uncertain',
        pinnedHeadOid: 'head-before',
        resolvedHeadOid: 'head-after',
        attemptId: 'attempt-4',
      },
    }],
  ];

  it.each(cases)('consumes the shared token and renders the shared %s outcome', async (state, response) => {
    await renderAndCommit(response);
    expect(container.querySelector('[data-testid="commit-outcome"]')?.getAttribute('data-state')).toBe(state);
    expect(container.querySelector('[data-testid="plan-candidate-preview"]')).toBeNull();
  });

  it('re-previews a safely refused candidate through the same Plan-lens selection', async () => {
    await renderAndCommit({
      kind: 'outcome',
      outcome: { status: 'aborted-stale', reason: 'candidate changed', attemptId: 'attempt-5' },
    });
    act(() => {
      (container.querySelector('[data-testid="commit-outcome-repreview"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="plan-candidate-preview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="commit-outcome"]')).toBeNull();
  });
});
