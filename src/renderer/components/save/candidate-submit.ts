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

  // Acknowledgements are evidence about the fresh preview. Work with no human
  // acknowledgement gate echoes the fresh server digest automatically; opening
  // the detail panel is never required merely to mint.
  const acknowledgeTopologyDigest = preview.requiresOverlapAck
    ? input.draft?.overlapAcknowledged
      ? input.draft.componentTopologyDigest
      : null
    : preview.componentTopologyDigest;
  const checked = new Set(input.draft?.checkedUnattributedEntryIds ?? []);
  const acknowledgeUnattributedEntryIds = preview.unacknowledgedUnattributedEntryIds.filter((id) => checked.has(id));

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
  if (refusal) return { kind: 'refused', refusal, preview, mint };
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
