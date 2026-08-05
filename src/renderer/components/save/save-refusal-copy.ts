import type { SaveRefusal } from '../../../shared/commit-candidates';
import type {
  CommitCoordinatorConsumeResponse,
  SaveCardMintResponse,
} from '../../../shared/types';

/** One renderer vocabulary for every Save/Plan surface. Main supplies the
 * actionable detail; this switch guarantees the failed pipeline stage is named. */
export function renderSaveRefusal(refusal: SaveRefusal): string {
  switch (refusal.stage) {
    case 'saveability':
      return refusal.message.startsWith('Saveability stage') ? refusal.message : `Saveability stage refused: ${refusal.message}`;
    case 'boundary-capture':
      return refusal.message.startsWith('Boundary-capture stage') ? refusal.message : `Boundary-capture stage refused: ${refusal.message}`;
    case 'freeze':
      return refusal.message.startsWith('Freeze stage') ? refusal.message : `Freeze stage refused: ${refusal.message}`;
    case 'preview-verify':
      return refusal.message.startsWith('Preview verification stage') ? refusal.message : `Preview verification stage refused: ${refusal.message}`;
    case 'mint': {
      const ackCopy: Record<string, string> = {
        'overlap-ack-missing': 'This package fuses work from multiple agents or plans. Review the overlap in the preview below and check the acknowledgement to continue.',
        'overlap-ack-stale': 'The overlap topology changed after you acknowledged it. The refreshed preview is shown below — review it and acknowledge again.',
        'unattributed-ack-incomplete': 'The package contains unattributed changes that were not acknowledged. The refreshed preview is shown below — confirm each unattributed change, then submit again.',
        'unattributed-ack-stale': 'The unattributed selection changed after the preview. The current pinned selection is shown below — review and acknowledge again.',
        'candidate-ack-stale': 'The candidate changed after the preview even though the pinned files may still match. Review the refreshed candidate below before saving.',
        'mint-ack-race': 'The package changed again while the save token was being minted. The newest preview is shown below — review and acknowledge again.',
      };
      if (ackCopy[refusal.code]) return `Mint stage refused: ${ackCopy[refusal.code]}`;
      if (refusal.code === 'acknowledgement-stale') {
        return 'Mint stage refused because the package acknowledgement is stale or incomplete. The refreshed details are shown below — review and acknowledge again.';
      }
      return refusal.message.startsWith('Mint stage') ? refusal.message : `Mint stage refused: ${refusal.message}`;
    }
    case 'token-consume':
      return refusal.message.startsWith('Token-consume stage') ? refusal.message : `Token-consume stage refused: ${refusal.message}`;
    case 'commit':
      return refusal.message.startsWith('Commit stage') ? refusal.message : `Commit stage refused: ${refusal.message}`;
    case 'reconciliation':
      return refusal.message.startsWith('Reconciliation stage') ? refusal.message : `Reconciliation stage refused: ${refusal.message}`;
  }
}

/** Compatibility derivation for renderer fixtures/older main instances. Current
 * main always supplies `refusal`; this keeps the unknown fallback stage-specific. */
export function mintRefusal(response: SaveCardMintResponse): SaveRefusal | null {
  if (response.refusal) return response.refusal;
  if (!response.isCandidate) {
    return { stage: 'mint', code: 'mint-refused', message: 'Mint stage refused because the server returned a preview.' };
  }
  const eligibility = response.candidate.eligibility;
  if (!eligibility.eligible) {
    const acknowledgement = eligibility.reason === 'overlap-not-acknowledged'
      || eligibility.reason === 'unattributed-not-acknowledged';
    return {
      stage: 'mint',
      code: acknowledgement ? 'acknowledgement-stale' : 'mint-refused',
      message: `Mint stage refused: ${eligibility.reason}.`,
    };
  }
  if (!response.candidate.token) {
    return { stage: 'mint', code: 'mint-token-missing', message: 'Mint stage refused because the eligible candidate has no token.' };
  }
  return null;
}

export function coordinatorRefusal(response: CommitCoordinatorConsumeResponse): SaveRefusal | null {
  if (response.kind === 'saved') return null;
  if (response.refusal) return response.refusal;
  if (response.kind === 'token-unresolved' || response.kind === 'compose-in-flight') {
    return { stage: 'token-consume', code: response.kind, message: `Token-consume stage refused: ${response.kind}.` };
  }
  if (response.kind === 'reconciliation-error') {
    return { stage: 'reconciliation', code: response.error.code, message: `Reconciliation stage refused: ${response.error.message}` };
  }
  const detail = response.kind === 'invalid-message'
    ? response.reason
    : 'reason' in response.outcome ? response.outcome.reason : response.outcome.status;
  return { stage: 'commit', code: 'coordinator-stale', message: `Commit stage refused: ${detail}.` };
}
