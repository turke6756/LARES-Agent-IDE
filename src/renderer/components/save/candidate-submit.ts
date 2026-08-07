import type { SaveRefusal, SaveRefusalStage } from '../../../shared/commit-candidates';
import type {
  CommitCoordinatorConsumeResponse,
  SaveCardPreviewResponse,
  SaveSweepResponse,
} from '../../../shared/types';
import { useSaveCardStore } from '../../stores/save-card-store';
import type { CandidatePreviewDraft, CandidatePreviewSelection } from './CandidatePreview';

export type CandidateSubmitStage = 'reviewing' | 'sweeping';

export type CandidateSubmitResult =
  | {
      kind: 'completed';
      response: SaveSweepResponse;
      message: string;
    }
  | {
      /** Compatibility arm for plan-surface consumers while their presentation
       * migrates to sweep terminals. The sweep submitter never fabricates it. */
      kind: 'committed';
      response: Extract<CommitCoordinatorConsumeResponse, { kind: 'saved' }>;
    }
  | {
      kind: 'refused';
      refusal: SaveRefusal;
      preview?: SaveCardPreviewResponse;
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
  sweep: typeof window.api.saveCard.sweep;
  refreshInventory: (workspaceId: string) => Promise<unknown>;
}

function defaultApi(): CandidateSubmitApi {
  return {
    preview: (request) => window.api.saveCard.preview(request),
    sweep: (request) => window.api.saveCard.sweep(request),
    refreshInventory: async (workspaceId) => {
      await useSaveCardStore.getState().refreshInventory(workspaceId);
    },
  };
}

function localRefusal(
  stage: SaveRefusalStage,
  code: string,
  message: string,
  preview?: SaveCardPreviewResponse,
): CandidateSubmitResult {
  return { kind: 'refused', refusal: { stage, code, message }, ...(preview ? { preview } : {}) };
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
  let preview = input.draft?.response;
  if (!preview) {
    try {
      preview = await api.preview({ workspaceId: input.workspaceId, ...input.selection });
    } catch {
      return localRefusal(
        'preview-verify',
        'preview-transport-failed',
        'Preview verification stage failed before repository mutation began.',
      );
    }
  }

  if (preview.refusal) return { kind: 'refused', refusal: preview.refusal, preview };
  if (!preview.isCandidate || !('repository' in preview.candidate)
      || !preview.candidate.eligibility.eligible) {
    return localRefusal(
      'preview-verify',
      'preview-ineligible',
      'Preview verification stage refused because the reviewed package is not finalized and eligible.',
      preview,
    );
  }
  if (containsReservedTrailer(input.draft)) {
    return localRefusal(
      'preview-verify',
      'reserved-trailer',
      'Preview verification stage refused because user trailers may not use the reserved Lares- namespace.',
      preview,
    );
  }

  const reviewedManifestDigest = input.draft?.reviewedManifestDigest
    ?? preview.reviewedManifest?.reviewedManifestDigest;
  const durableFinalizationIntent = input.draft?.durableFinalizationIntent
    ?? preview.durableFinalizationIntent;
  const acknowledgedChallengeAtoms = input.draft?.acknowledgedChallengeAtoms ?? [];
  if (!reviewedManifestDigest || !durableFinalizationIntent?.length) {
    return localRefusal(
      'preview-verify',
      'review-evidence-missing',
      'The server did not return the durable review evidence required to save this package.',
      preview,
    );
  }
  if (!input.draft && (preview.reviewedManifest?.challengeAtoms.length ?? 0) > 0) {
    return localRefusal(
      'preview-verify',
      'acknowledgement-missing',
      'Review and acknowledge the highlighted items before saving this package.',
      preview,
    );
  }

  const repositoryKey = preview.candidate.repository.repositoryKey;
  const message = editableMessage(input.draft, preview);
  input.onTransition?.('submit-sweep');
  input.onStage?.('sweeping');
  let response: SaveSweepResponse;
  try {
    response = await api.sweep({
      intents: durableFinalizationIntent.map((intent) => ({
        repositoryKey,
        finalizationId: intent.finalizationId,
        packageId: intent.packageId,
        packageRevision: intent.packageRevision,
        frozenMemberManifestDigest: intent.frozenMemberManifestDigest,
        reviewedManifestDigest,
        message,
      })),
      reviewedManifestDigests: [reviewedManifestDigest],
      acknowledgedChallengeAtoms,
    });
  } catch {
    return {
      kind: 'uncertain',
      stage: 'commit',
      code: 'repository-outcome-uncertain',
      message: 'The save sweep outcome is uncertain. Lares will not claim failure or retry automatically.',
    };
  }

  // Main has already classified every intent. Refreshing the renderer cache is
  // best-effort presentation work and must never replace or reinterpret those
  // terminal verdicts.
  try {
    await api.refreshInventory(input.workspaceId);
  } catch {
    // Keep the server's terminal results visible; a later ordinary refresh heals
    // the renderer cache without risking a duplicate commit.
  }
  return {
    kind: 'completed',
    response,
    message: `Save sweep completed with ${response.results.map((result) => result.kind).join(', ')}.`,
  };
}

/** One single-flight submitter per mounted gesture. Concurrent calls share the
 * same promise, so a double click can produce only one main-owned sweep. */
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
