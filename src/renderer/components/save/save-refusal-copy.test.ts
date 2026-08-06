import { describe, expect, it } from 'vitest';

import type { SaveRefusal } from '../../../shared/commit-candidates';
import { renderSaveRefusal } from './save-refusal-copy';

const refusalVectors: SaveRefusal[] = [
  { stage: 'saveability', code: 'save-card-no-repository', message: 'Mint stage rejected a candidate token.' },
  { stage: 'boundary-capture', code: 'boundary-capture-failed', message: 'Pin stage rejected a foreign candidate.' },
  { stage: 'freeze', code: 'freeze-boundary-unavailable', message: 'Re-pin the token.' },
  { stage: 'preview-verify', code: 'preview-ineligible', message: 'Candidate pin moved.' },
  { stage: 'mint', code: 'overlap-ack-missing', message: "Review another agent's foreign token." },
  { stage: 'mint', code: 'overlap-ack-stale', message: 'The foreign candidate changed.' },
  { stage: 'mint', code: 'unattributed-ack-incomplete', message: 'Mint token missing.' },
  { stage: 'mint', code: 'unattributed-ack-stale', message: 'Pinned candidate changed.' },
  { stage: 'mint', code: 'candidate-ack-stale', message: 'Candidate pin changed.' },
  { stage: 'mint', code: 'mint-ack-race', message: 'Mint token changed.' },
  { stage: 'mint', code: 'acknowledgement-stale', message: 'Candidate acknowledgement expired.' },
  { stage: 'mint', code: 'mint-refused', message: 'Mint stage refused.' },
  { stage: 'token-consume', code: 'token-unresolved-or-expired', message: 'Token-consume stage refused.' },
  { stage: 'commit', code: 'coordinator-stale', message: 'The package could not be saved: candidate token moved.' },
  { stage: 'reconciliation', code: 'tree-mismatch', message: 'Reconciliation stage rejected the token.' },
];

describe('save refusal copy', () => {
  it('renders every real refusal shape as one plain sentence without internal vocabulary', () => {
    for (const refusal of refusalVectors) {
      const copy = renderSaveRefusal(refusal);
      expect(copy).not.toMatch(/\b(?:mint|candidate|pin(?:ned|ning)?|token)\b/i);
      expect(copy.match(/[.!?](?:\s|$)/g)).toHaveLength(1);
    }
  });

  it('describes overlap truthfully as multi-owner or unattributed work', () => {
    const overlapVectors = refusalVectors.filter((refusal) => [
      'overlap-ack-missing',
      'overlap-ack-stale',
      'unattributed-ack-incomplete',
      'unattributed-ack-stale',
      'acknowledgement-stale',
    ].includes(refusal.code));

    for (const refusal of overlapVectors) {
      const copy = renderSaveRefusal(refusal);
      expect(copy).toMatch(/multi-owner|unattributed work/i);
      expect(copy).not.toMatch(/another agent's|foreign/i);
    }
  });
});
