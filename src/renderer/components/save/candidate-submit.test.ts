import { describe, expect, it, vi } from 'vitest';
import type { ReviewChallengeAtom } from '../../../shared/commit-candidates';
import type { SaveCardPreviewResponse, SaveSweepResponse } from '../../../shared/types';
import type { CandidatePreviewDraft } from './CandidatePreview';
import { createCandidateSubmitter } from './candidate-submit';

const selection = {
  selectedComponentIds: ['component-1'],
  selectedUnattributedEntryIds: [],
  finalizationIds: ['finalization-1'],
};

const overlapAtom: ReviewChallengeAtom = {
  kind: 'overlap', atomId: 'overlap-1', digest: 'atom-digest-1', reasonVersion: 1,
  memberPathBytesBase64: ['c3JjL2EudHM='], contributors: [], ownershipGroupKeys: ['owner-1'],
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
      finalizations: [{ finalizationId: 'finalization-1', packageId: 'package-1', packageRevision: 3, boundaryStatus: 'ready' }],
      eligibility: { eligible: true }, token: null,
    },
    laresTrailers: ['Lares-Plan: plan-1'], defaultMessageBody: 'Save work',
    requiresOverlapAck: false, unacknowledgedUnattributedEntryIds: [],
    componentTopologyDigest: 'operational-topology-only',
    selectionDrift: { added: [], missing: [], reAttributed: [], byteMoved: [] },
    selectionDriftDisplayPaths: {},
    pinnedSelection: { selectedComponentIds: ['component-1'], selectedUnattributedEntryIds: [], frozenMemberCount: 0 },
    reviewedManifest: {
      manifestVersion: 1, reviewedManifestDigest: 'review-digest-1', members: [],
      challengeVersion: 1, challengeAtoms: [],
    },
    durableFinalizationIntent: [{
      finalizationId: 'finalization-1', packageId: 'package-1', packageRevision: 3,
      boundaryStatus: 'ready', frozenMemberManifestDigest: 'frozen-digest-1',
    }],
    ...over,
  } as SaveCardPreviewResponse;
}

function draft(over: Partial<CandidatePreviewDraft> = {}): CandidatePreviewDraft {
  const response = preview();
  return {
    response,
    reviewedManifestDigest: 'review-digest-1',
    durableFinalizationIntent: response.durableFinalizationIntent!,
    acknowledgedChallengeAtoms: [],
    previewedCandidateId: 'candidate-1', componentTopologyDigest: 'old-operational-digest',
    checkedUnattributedEntryIds: [], overlapAcknowledged: false,
    messageBody: 'Editable body', userTrailers: 'Reviewed-by: Human', canSave: true,
    reservedTrailer: null, acknowledgedUnattributedEntryIds: [], ...over,
  };
}

function savedResponse(): SaveSweepResponse {
  return {
    halted: false, haltKind: null,
    results: [{
      kind: 'saved', repositoryKey: 'repo-1', finalizationId: 'finalization-1',
      packageId: 'package-1', packageRevision: 3, attemptId: 'attempt-1', commitOid: 'oid-1',
    }],
  };
}

function api() {
  return {
    preview: vi.fn(async () => preview()),
    sweep: vi.fn(async () => savedResponse()),
    refreshInventory: vi.fn(async () => undefined),
  };
}

describe('candidate submit sweep transaction', () => {
  it('coalesces a double submit into exactly one preview, sweep, and refresh', async () => {
    const deps = api();
    const submitter = createCandidateSubmitter(deps);
    const first = submitter.submit({ workspaceId: 'ws-1', selection });
    const second = submitter.submit({ workspaceId: 'ws-1', selection });
    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({ kind: 'completed', response: savedResponse() });
    expect(deps.preview).toHaveBeenCalledTimes(1);
    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(deps.refreshInventory).toHaveBeenCalledTimes(1);
  });

  it('sends only durable intents, the main-issued review digest, and structured atom evidence', async () => {
    const deps = api();
    await createCandidateSubmitter(deps).submit({
      workspaceId: 'ws-1', selection,
      draft: draft({ acknowledgedChallengeAtoms: [overlapAtom] }),
    });

    expect(deps.preview).not.toHaveBeenCalled();
    expect(deps.sweep).toHaveBeenCalledWith({
      intents: [{
        repositoryKey: 'repo-1', finalizationId: 'finalization-1', packageId: 'package-1',
        packageRevision: 3, frozenMemberManifestDigest: 'frozen-digest-1',
        reviewedManifestDigest: 'review-digest-1',
        message: 'Editable body\n\nReviewed-by: Human',
      }],
      reviewedManifestDigests: ['review-digest-1'],
      acknowledgedChallengeAtoms: [overlapAtom],
    });
  });

  it('does not compare candidate or topology identities and returns the server carry verdict unchanged', async () => {
    const deps = api();
    const serverResponse: SaveSweepResponse = {
      halted: false, haltKind: null,
      results: [{
        kind: 'needs-attention', repositoryKey: 'repo-1', finalizationId: 'finalization-1',
        packageId: 'package-1', packageRevision: 3, code: 'server-carry-refused',
        message: 'The reviewed effect changed.',
      }],
    };
    deps.sweep.mockResolvedValue(serverResponse);
    const result = await createCandidateSubmitter(deps).submit({
      workspaceId: 'ws-1', selection,
      draft: draft({ previewedCandidateId: 'obsolete-candidate', componentTopologyDigest: 'obsolete-topology' }),
    });
    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'completed', response: serverResponse });
  });

  it('preserves exactly one server terminal record per durable intent, including a halt tail', async () => {
    const deps = api();
    const response: SaveSweepResponse = {
      halted: true, haltKind: 'uncertain',
      results: [
        { kind: 'saved', repositoryKey: 'repo-1', finalizationId: 'f1', packageId: 'p1', packageRevision: 1, attemptId: 'a1', commitOid: 'c1' },
        { kind: 'already-saved', repositoryKey: 'repo-1', finalizationId: 'f2', packageId: 'p2', packageRevision: 1, provingCommitOids: ['c0'] },
        { kind: 'needs-attention', repositoryKey: 'repo-1', finalizationId: 'f3', packageId: 'p3', packageRevision: 1, code: 'changed', message: 'changed' },
        { kind: 'halted-uncertain', repositoryKey: 'repo-1', finalizationId: 'f4', packageId: 'p4', packageRevision: 1, code: 'unknown', message: 'unknown', attemptId: 'a4', commitOid: 'c4' },
        { kind: 'not-attempted', repositoryKey: 'repo-1', finalizationId: 'f5', packageId: 'p5', packageRevision: 1, haltedAfterFinalizationId: 'f4' },
      ],
    };
    deps.sweep.mockResolvedValue(response);
    await expect(createCandidateSubmitter(deps).submit({ workspaceId: 'ws-1', selection, draft: draft() }))
      .resolves.toMatchObject({ kind: 'completed', response });
  });

  it('saves nine unchanged packages sequentially with zero renderer refusals', async () => {
    const results = [];
    for (let index = 1; index <= 9; index++) {
      const deps = api();
      const response = preview({
        reviewedManifest: { ...preview().reviewedManifest!, reviewedManifestDigest: `review-${index}` },
        durableFinalizationIntent: [{
          finalizationId: `f-${index}`, packageId: `p-${index}`, packageRevision: 1,
          boundaryStatus: 'ready', frozenMemberManifestDigest: `frozen-${index}`,
        }],
      });
      deps.preview.mockResolvedValue(response);
      deps.sweep.mockResolvedValue({
        halted: false, haltKind: null,
        results: [{ kind: 'saved', repositoryKey: 'repo-1', finalizationId: `f-${index}`, packageId: `p-${index}`, packageRevision: 1, attemptId: `a-${index}`, commitOid: `c-${index}` }],
      });
      results.push(await createCandidateSubmitter(deps).submit({ workspaceId: 'ws-1', selection }));
    }
    expect(results).toHaveLength(9);
    expect(results.every((result) => result.kind === 'completed'
      && result.response.results.every((terminal) => terminal.kind === 'saved'))).toBe(true);
  });

  it('requires the review pane when the server returns challenge atoms', async () => {
    const deps = api();
    deps.preview.mockResolvedValue(preview({
      requiresOverlapAck: true,
      reviewedManifest: { ...preview().reviewedManifest!, challengeAtoms: [overlapAtom] },
    }));
    await expect(createCandidateSubmitter(deps).submit({ workspaceId: 'ws-1', selection }))
      .resolves.toMatchObject({ kind: 'refused', refusal: { code: 'acknowledgement-missing' } });
    expect(deps.sweep).not.toHaveBeenCalled();
  });

  it('marks sweep transport loss uncertain and never retries automatically', async () => {
    const deps = api();
    deps.sweep.mockRejectedValue(new Error('transport lost'));
    const submitter = createCandidateSubmitter(deps);
    await expect(submitter.submit({ workspaceId: 'ws-1', selection, draft: draft() })).resolves.toMatchObject({
      kind: 'uncertain', code: 'repository-outcome-uncertain',
    });
    expect(deps.sweep).toHaveBeenCalledTimes(1);
  });

  it('does not replace terminal verdicts when the renderer inventory refresh fails', async () => {
    const deps = api();
    deps.refreshInventory.mockRejectedValue(new Error('cache unavailable'));
    await expect(createCandidateSubmitter(deps).submit({ workspaceId: 'ws-1', selection, draft: draft() }))
      .resolves.toMatchObject({ kind: 'completed', response: savedResponse() });
  });
});
