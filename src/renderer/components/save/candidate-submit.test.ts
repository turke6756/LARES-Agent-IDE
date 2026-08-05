import { describe, expect, it, vi } from 'vitest';
import type { SaveCardPreviewResponse } from '../../../shared/types';
import type { CandidatePreviewDraft } from './CandidatePreview';
import { createCandidateSubmitter } from './candidate-submit';

const selection = {
  selectedComponentIds: ['component-1'],
  selectedUnattributedEntryIds: [],
  finalizationIds: ['finalization-1'],
};

function preview(over: Partial<SaveCardPreviewResponse> = {}): SaveCardPreviewResponse {
  return {
    isCandidate: true,
    candidate: {
      candidateId: 'candidate-1', contractVersion: 1,
      repository: {
        repositoryKey: 'repo-1', objectDatabaseKey: 'odb-1', gitObjectFormat: 'sha1', bareRepo: false,
        workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
      },
      componentIds: ['component-1'], selectedUnattributedEntryIds: [], members: [],
      finalizations: [{ finalizationId: 'finalization-1', packageId: 'package-1', packageRevision: 1, boundaryStatus: 'ready' }],
      eligibility: { eligible: true }, token: null,
    },
    laresTrailers: ['Lares-Plan: plan-1'], defaultMessageBody: 'Save work',
    requiresOverlapAck: false, unacknowledgedUnattributedEntryIds: [],
    componentTopologyDigest: 'fresh-digest',
    selectionDrift: { added: [], missing: [], reAttributed: [], byteMoved: [] },
    selectionDriftDisplayPaths: {},
    pinnedSelection: { selectedComponentIds: ['component-1'], selectedUnattributedEntryIds: [], frozenMemberCount: 0 },
    ...over,
  } as SaveCardPreviewResponse;
}

function tokenful(): SaveCardPreviewResponse {
  const response = preview();
  return {
    ...response,
    candidate: {
      ...response.candidate,
      token: { tokenId: 'token-1', candidateId: 'candidate-1', contractVersion: 1, issuedAt: 1, expiresAt: 2 },
    },
  } as SaveCardPreviewResponse;
}

function draft(over: Partial<CandidatePreviewDraft> = {}): CandidatePreviewDraft {
  return {
    response: preview(), previewedCandidateId: 'candidate-1', componentTopologyDigest: 'reviewed-digest',
    checkedUnattributedEntryIds: [], overlapAcknowledged: false,
    messageBody: 'Editable body', userTrailers: 'Reviewed-by: Human', canSave: true,
    reservedTrailer: null, acknowledgedUnattributedEntryIds: [], ...over,
  };
}

function api() {
  return {
    preview: vi.fn(async () => preview()),
    mint: vi.fn(async () => tokenful()),
    commit: vi.fn(async () => ({
      kind: 'saved' as const,
      outcome: { status: 'committed' as const, commitOid: 'oid-1', attemptId: 'attempt-1', indexIntegrity: 'verified' as const },
      finalizations: [],
    })),
    refreshInventory: vi.fn(async () => undefined),
  };
}

describe('candidate submit transaction', () => {
  it('coalesces a double submit into exactly one preview, mint, consume, and refresh', async () => {
    const deps = api();
    const submitter = createCandidateSubmitter(deps);
    const first = submitter.submit({ workspaceId: 'ws-1', selection, draft: draft() });
    const second = submitter.submit({ workspaceId: 'ws-1', selection, draft: draft() });
    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({ kind: 'committed' });
    expect(deps.preview).toHaveBeenCalledTimes(1);
    expect(deps.mint).toHaveBeenCalledTimes(1);
    expect(deps.commit).toHaveBeenCalledTimes(1);
    expect(deps.refreshInventory).toHaveBeenCalledTimes(1);
    expect(deps.commit).toHaveBeenCalledWith({
      candidateId: 'candidate-1', tokenId: 'token-1',
      message: 'Editable body\n\nReviewed-by: Human',
    });
  });

  it('uses the fresh digest automatically when no human acknowledgement is required', async () => {
    const deps = api();
    await createCandidateSubmitter(deps).submit({ workspaceId: 'ws-1', selection });
    expect(deps.mint).toHaveBeenCalledWith(expect.objectContaining({
      acknowledgeTopologyDigest: 'fresh-digest', acknowledgeUnattributedEntryIds: [],
    }));
  });

  it('mints and commits an acknowledged overlap using the fresh preview digest', async () => {
    const deps = api();
    deps.preview.mockResolvedValue(preview({ requiresOverlapAck: true, componentTopologyDigest: 'fresh' }));
    const result = await createCandidateSubmitter(deps).submit({
      workspaceId: 'ws-1', selection,
      draft: draft({ overlapAcknowledged: true, componentTopologyDigest: 'fresh' }),
    });
    expect(deps.mint).toHaveBeenCalledWith(expect.objectContaining({ acknowledgeTopologyDigest: 'fresh' }));
    expect(result).toMatchObject({ kind: 'committed' });
  });

  it('refuses a fresh topology change locally and returns the fresh preview', async () => {
    const deps = api();
    const fresh = preview({ requiresOverlapAck: true, componentTopologyDigest: 'fresh-moved' });
    deps.preview.mockResolvedValue(fresh);
    const result = await createCandidateSubmitter(deps).submit({
      workspaceId: 'ws-1', selection,
      draft: draft({ overlapAcknowledged: true, componentTopologyDigest: 'reviewed-old' }),
    });
    expect(deps.mint).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'refused', refusal: { code: 'overlap-ack-stale' }, preview: fresh });
  });

  it('refuses a changed candidate identity before mint', async () => {
    const deps = api();
    const result = await createCandidateSubmitter(deps).submit({
      workspaceId: 'ws-1', selection, draft: draft({ previewedCandidateId: 'candidate-0' }),
    });
    expect(deps.mint).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'refused', refusal: { code: 'candidate-ack-stale' } });
  });

  it('refuses an incomplete unattributed acknowledgement before mint', async () => {
    const deps = api();
    deps.preview.mockResolvedValue(preview({ unacknowledgedUnattributedEntryIds: ['u-1', 'u-2'] }));
    const result = await createCandidateSubmitter(deps).submit({
      workspaceId: 'ws-1', selection,
      draft: draft({ acknowledgedUnattributedEntryIds: ['u-1'] }),
    });
    expect(deps.mint).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'refused', refusal: { code: 'unattributed-ack-incomplete' } });
  });

  it('refuses a removed unattributed acknowledgement before mint', async () => {
    const deps = api();
    deps.preview.mockResolvedValue(preview({ unacknowledgedUnattributedEntryIds: ['u-1'] }));
    const result = await createCandidateSubmitter(deps).submit({
      workspaceId: 'ws-1', selection,
      draft: draft({ acknowledgedUnattributedEntryIds: ['u-1', 'u-2'] }),
    });
    expect(deps.mint).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'refused', refusal: { code: 'unattributed-ack-stale' } });
  });

  it('mints an exactly acknowledged unattributed challenge', async () => {
    const deps = api();
    deps.preview.mockResolvedValue(preview({ unacknowledgedUnattributedEntryIds: ['u-1', 'u-2'] }));
    await createCandidateSubmitter(deps).submit({
      workspaceId: 'ws-1', selection,
      draft: draft({ acknowledgedUnattributedEntryIds: ['u-1', 'u-2'] }),
    });
    expect(deps.mint).toHaveBeenCalledWith(expect.objectContaining({
      acknowledgeUnattributedEntryIds: ['u-1', 'u-2'],
    }));
  });

  it('relabels a mint-time acknowledgement refusal as a race and retains P3', async () => {
    const deps = api();
    const mintResponse = preview({
      refusal: { stage: 'mint', code: 'acknowledgement-stale', message: 'stale' },
      candidate: { ...preview().candidate, eligibility: { eligible: false, reason: 'overlap-not-acknowledged' }, token: null },
    });
    deps.mint.mockResolvedValue(mintResponse);
    const result = await createCandidateSubmitter(deps).submit({ workspaceId: 'ws-1', selection });
    expect(result).toMatchObject({ kind: 'refused', refusal: { code: 'mint-ack-race' }, mint: mintResponse });
  });

  it('marks a consume transport loss uncertain and never retries automatically', async () => {
    const deps = api();
    deps.commit.mockRejectedValue(new Error('transport lost'));
    const submitter = createCandidateSubmitter(deps);
    await expect(submitter.submit({ workspaceId: 'ws-1', selection })).resolves.toMatchObject({
      kind: 'uncertain', code: 'repository-outcome-uncertain',
    });
    expect(deps.commit).toHaveBeenCalledTimes(1);
  });
});
