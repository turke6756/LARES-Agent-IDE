import type { SaveRefusal } from '../../../shared/commit-candidates';
import type {
  CommitCoordinatorConsumeResponse,
  SaveCardMintResponse,
} from '../../../shared/types';

/** One plain-language renderer vocabulary for every Save/Plan surface. */
export function renderSaveRefusal(refusal: SaveRefusal): string {
  switch (refusal.stage) {
    case 'saveability':
      return 'This package cannot be saved from this workspace.';
    case 'boundary-capture':
      return refusal.paths?.length
        ? `Lares could not gather the current work for ${refusal.paths.join(', ')}.`
        : "Lares could not gather this package's current work.";
    case 'freeze':
      return 'This package is not ready to save.';
    case 'preview-verify':
      return 'This package changed since it was reviewed.';
    case 'mint': {
      const acknowledgementCopy: Record<string, string> = {
        'unattributed-ack-incomplete': 'This package contains unattributed work that needs your review.',
        'unattributed-ack-stale': 'The unattributed work changed and needs another review.',
        'candidate-ack-stale': 'This package changed since it was reviewed.',
        'mint-ack-race': 'This package changed, so review it and confirm the work again.',
      };
      if (acknowledgementCopy[refusal.code]) return acknowledgementCopy[refusal.code];
      if (refusal.code === 'acknowledgement-stale') {
        return "This package's unattributed work needs your review.";
      }
      return 'This package changed before Lares could save it.';
    }
    case 'token-consume':
      return 'This save is no longer current.';
    case 'commit': {
      const detail = refusal.message.startsWith('The package could not be saved: ')
        ? refusal.message.slice(32)
        : '';
      return detail && !/\b(?:mint|candidate|pin(?:ned|ning)?|token|stage|topology|acknowledgement)\b/i.test(detail)
        ? `Lares could not save this package because ${detail}`
        : 'Lares could not save this package.';
    }
    case 'reconciliation':
      return 'Lares saved this package but could not verify the result.';
  }
}

/** Compatibility derivation for renderer fixtures/older main instances. Current
 * main always supplies `refusal`; this keeps the unknown fallback stage-specific. */
export function mintRefusal(response: SaveCardMintResponse): SaveRefusal | null {
  if (response.refusal) return response.refusal;
  if (!response.isCandidate) {
    return { stage: 'mint', code: 'mint-refused', message: 'The package changed before it could be saved.' };
  }
  const eligibility = response.candidate.eligibility;
  if (!eligibility.eligible) {
    const acknowledgement = eligibility.reason === 'unattributed-not-acknowledged';
    return {
      stage: 'mint',
      code: acknowledgement ? 'acknowledgement-stale' : 'mint-refused',
      message: `The package is not ready to save: ${eligibility.reason}.`,
    };
  }
  if (!('token' in response.candidate) || !response.candidate.token) {
    return { stage: 'mint', code: 'mint-token-missing', message: 'The package could not be prepared for saving.' };
  }
  return null;
}

export function coordinatorRefusal(response: CommitCoordinatorConsumeResponse): SaveRefusal | null {
  if (response.kind === 'saved') return null;
  if (response.refusal) return response.refusal;
  if (response.kind === 'token-unresolved' || response.kind === 'compose-in-flight') {
    return { stage: 'token-consume', code: response.kind, message: 'This save is no longer current.' };
  }
  if (response.kind === 'reconciliation-error') {
    return { stage: 'reconciliation', code: response.error.code, message: 'The save could not be verified.' };
  }
  const detail = response.kind === 'invalid-message'
    ? response.reason
    : 'reason' in response.outcome ? response.outcome.reason : response.outcome.status;
  return { stage: 'commit', code: 'coordinator-stale', message: `The package could not be saved: ${detail}.` };
}
