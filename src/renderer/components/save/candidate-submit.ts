import type { SaveRefusal, SaveRefusalStage } from '../../../shared/commit-candidates';
import type {
  CommitCoordinatorConsumeResponse,
  SaveCardMintResponse,
  SaveCardPreviewResponse,
} from '../../../shared/types';
import { useSaveCardStore } from '../../stores/save-card-store';
import type { CandidatePreviewDraft, CandidatePreviewSelection } from './CandidatePreview';
import { coordinatorRefusal, mintRefusal } from './save-refusal-copy';

export type CandidateSubmitStage = 'reviewing' | 'minting' | 'committing';

export type CandidateSubmitResult =
  | {
      kind: 'committed';
      response: Extract<CommitCoordinatorConsumeResponse, { kind: 'saved' }>;
    }
  | {
      kind: 'refused';
      refusal: SaveRefusal;
      preview?: SaveCardPreviewResponse;
      mint?: SaveCardMintResponse;
      response?: CommitCoordinatorConsumeResponse;
    }
  | {
      kind: 'uncertain';
      stage: Extract<SaveRefusalStage, 'token-consume' | 'commit' | 'reconciliation'>;
      code: 'repository-outcome-uncertain';
      message: string;
    };

export interface CandidateSubmitInput {
  workspaceId: string;
  selection: CandidatePreviewSelection;
  draft?: CandidatePreviewDraft | null;
  onStage?: (stage: CandidateSubmitStage) => void;
  onTransition?: (event: string) => void;
}

export interface CandidateSubmitApi {
  preview: typeof window.api.saveCard.preview;
  mint: typeof window.api.commitCoordinator.mint;
  commit: typeof window.api.commitCoordinator.commit;
  refreshInventory: (workspaceId: string) => Promise<unknown>;
}

function defaultApi(): CandidateSubmitApi {
  return {
    preview: (request) => window.api.saveCard.preview(request),
    mint: (request) => window.api.commitCoordinator.mint(request),
    commit: (request) => window.api.commitCoordinator.commit(request),
    refreshInventory: async (workspaceId) => {
      await useSaveCardStore.getState().refreshInventory(workspaceId);
    },
  };
}

function localRefusal(stage: SaveRefusalStage, code: string, message: string): CandidateSubmitResult {
  return { kind: 'refused', refusal: { stage, code, message } };
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const x = sortedIds(a); const y = sortedIds(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
function freshCandidateId(preview: SaveCardPreviewResponse): string | null {
  return preview.isCandidate && 'candidateId' in preview.candidate
    ? preview.candidate.candidateId : null;
}
function staleRefusal(code: string, message: string, preview: SaveCardPreviewResponse): CandidateSubmitResult {
  return { kind: 'refused', refusal: { stage: 'mint', code, message }, preview };
}

function editableMessage(draft: CandidatePreviewDraft | null | undefined, preview: SaveCardPreviewResponse): string {
  const body = draft?.messageBody ?? preview.defaultMessageBody;
  const trailers = draft?.userTrailers.trim() ?? '';
  return trailers ? `${body.trimEnd()}\n\n${trailers}` : body;
}

function containsReservedTrailer(draft: CandidatePreviewDraft | null | undefined): boolean {
  if (draft?.reservedTrailer) return true;
  return draft?.userTrailers.split('\n').some((line) => /^lares-/i.test(line.trim())) ?? false;
}

async function runCandidateSubmit(
  input: CandidateSubmitInput,
  api: CandidateSubmitApi,
): Promise<CandidateSubmitResult> {
  input.onStage?.('reviewing');
  let preview: SaveCardPreviewResponse;
  try {
    preview = await api.preview({ workspaceId: input.workspaceId, ...input.selection });
  } catch {
    return localRefusal(
      'preview-verify',
      'preview-transport-failed',
      'Preview verification stage failed before repository mutation began.',
    );
  }

  if (preview.refusal) return { kind: 'refused', refusal: preview.refusal, preview };
  if (!preview.isCandidate || !preview.candidate.eligibility.eligible) {
    return {
      kind: 'refused',
      refusal: {
        stage: 'preview-verify',
        code: 'preview-ineligible',
        message: 'Preview verification stage refused because the fresh selection is not finalized and eligible.',
      },
      preview,
    };
  }
  if (containsReservedTrailer(input.draft)) {
    return {
      kind: 'refused',
      refusal: {
        stage: 'preview-verify',
        code: 'reserved-trailer',
        message: 'Preview verification stage refused because user trailers may not use the reserved Lares- namespace.',
      },
      preview,
    };
  }

  // The human acknowledged the challenge shown in the card (input.draft, bound to
  // an earlier preview). Submit just recomputed a FRESH preview mint will validate
  // against. Only forward the fresh values when the reviewed challenge still holds.
  const draftCandidateId = input.draft?.previewedCandidateId ?? null;
  if (input.draft && draftCandidateId !== freshCandidateId(preview)) {
    input.onTransition?.('submit-ack-candidate-changed');
    return staleRefusal(
      'candidate-ack-stale',
      'Mint stage refused because the candidate changed after you reviewed it. The refreshed candidate is shown below — review it before saving.',
      preview,
    );
  }
  if (preview.requiresOverlapAck) {
    if (!input.draft?.overlapAcknowledged) {
      input.onTransition?.('submit-ack-missing');
      return staleRefusal(
        'overlap-ack-missing',
        'Mint stage refused because this package fuses work from multiple agents or plans. Review the overlap in the preview below and check the acknowledgement, then submit again.',
        preview,
      );
    }
    if (input.draft.componentTopologyDigest !== preview.componentTopologyDigest) {
      input.onTransition?.('submit-ack-topology-changed');
      return staleRefusal(
        'overlap-ack-stale',
        'Mint stage refused because the overlap topology changed after you acknowledged it. The refreshed preview is shown below — review it and acknowledge again.',
        preview,
      );
    }
  }
  const draftAcked = input.draft?.acknowledgedUnattributedEntryIds ?? [];
  const freshUnattributed = preview.unacknowledgedUnattributedEntryIds;
  if (!sameIds(draftAcked, freshUnattributed)) {
    input.onTransition?.('submit-ack-unattributed-changed');
    const added = sortedIds(freshUnattributed).filter((id) => !draftAcked.includes(id));
    const code = added.length > 0 ? 'unattributed-ack-incomplete' : 'unattributed-ack-stale';
    const message = added.length > 0
      ? `Mint stage refused because ${added.length} unattributed change${added.length === 1 ? '' : 's'} in this package ${added.length === 1 ? 'was' : 'were'} not acknowledged. Confirm each unattributed change in the preview below, then submit again.`
      : 'Mint stage refused because the unattributed selection changed after the preview. The current pinned selection is shown below — review and acknowledge again.';
    return staleRefusal(code, message, preview);
  }
  const acknowledgeTopologyDigest = preview.componentTopologyDigest;
  const acknowledgeUnattributedEntryIds = [...freshUnattributed];
  input.onTransition?.('submit-ack-ok');

  input.onStage?.('minting');
  let mint: SaveCardMintResponse;
  try {
    mint = await api.mint({
      workspaceId: input.workspaceId,
      ...input.selection,
      acknowledgeTopologyDigest,
      acknowledgeUnattributedEntryIds,
    });
  } catch {
    return localRefusal('mint', 'mint-transport-failed', 'Mint stage failed before a token was issued.');
  }

  const refusal = mintRefusal(mint);
  if (refusal) {
    const remapped = refusal.code === 'acknowledgement-stale'
      ? { ...refusal, code: 'mint-ack-race' }
      : refusal;
    if (remapped.code === 'mint-ack-race') input.onTransition?.('mint-ack-race');
    return { kind: 'refused', refusal: remapped, preview, mint };
  }
  if (!mint.isCandidate || !mint.candidate.eligibility.eligible || !mint.candidate.token) {
    return {
      kind: 'refused',
      refusal: {
        stage: 'mint',
        code: 'mint-token-missing',
        message: 'Mint stage refused because the eligible candidate did not receive a token.',
      },
      preview,
      mint,
    };
  }

  input.onStage?.('committing');
  let response: CommitCoordinatorConsumeResponse;
  try {
    // Consume receives only the minted identity and editable message. The
    // authoritative Lares-* trailers remain server-owned in the token snapshot.
    response = await api.commit({
      candidateId: mint.candidate.candidateId,
      tokenId: mint.candidate.token.tokenId,
      message: editableMessage(input.draft, preview),
    });
  } catch {
    return {
      kind: 'uncertain',
      stage: 'commit',
      code: 'repository-outcome-uncertain',
      message: 'Commit stage outcome is uncertain. Lares will not claim success or retry automatically.',
    };
  }

  const consumeRefusal = coordinatorRefusal(response);
  if (consumeRefusal) return { kind: 'refused', refusal: consumeRefusal, preview, mint, response };
  if (response.kind !== 'saved') {
    return localRefusal('reconciliation', 'save-not-verified', 'Reconciliation stage did not verify the save.');
  }

  // A save is not complete in the renderer until the inventory cache has been
  // invalidated and replaced by a fresh authoritative read.
  try {
    await api.refreshInventory(input.workspaceId);
  } catch {
    return {
      kind: 'uncertain',
      stage: 'reconciliation',
      code: 'repository-outcome-uncertain',
      message: 'The commit completed, but refreshed repository state could not be verified. Lares will not retry automatically.',
    };
  }
  return { kind: 'committed', response };
}

/** One single-flight submitter per mounted gesture. Concurrent calls share the
 * same promise, so a double click can produce only one preview/mint/consume chain. */
export function createCandidateSubmitter(api: CandidateSubmitApi = defaultApi()) {
  let inFlight: Promise<CandidateSubmitResult> | null = null;
  return {
    submit(input: CandidateSubmitInput): Promise<CandidateSubmitResult> {
      if (inFlight) return inFlight;
      inFlight = runCandidateSubmit(input, api).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
