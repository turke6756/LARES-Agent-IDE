import { describe, expect, it } from 'vitest';

import type { SaveRefusal, SaveRefusalStage } from '../../../shared/commit-candidates';
import { renderSaveRefusal } from './save-refusal-copy';

describe('save refusal stage copy', () => {
  it('names every pipeline stage and keeps acknowledgement stale distinct', () => {
    const rows: Array<[SaveRefusalStage, string]> = [
      ['saveability', 'Saveability stage'],
      ['boundary-capture', 'Boundary-capture stage'],
      ['freeze', 'Freeze stage'],
      ['preview-verify', 'Preview verification stage'],
      ['mint', 'Mint stage'],
      ['token-consume', 'Token-consume stage'],
      ['commit', 'Commit stage'],
      ['reconciliation', 'Reconciliation stage'],
    ];
    for (const [stage, label] of rows) {
      const refusal: SaveRefusal = { stage, code: 'refused', message: 'state moved' };
      expect(renderSaveRefusal(refusal)).toContain(label);
    }
    expect(renderSaveRefusal({
      stage: 'mint', code: 'acknowledgement-stale', message: 'overlap-not-acknowledged',
    })).toContain('acknowledgement is stale or incomplete');
  });

  it.each([
    ['overlap-ack-missing', 'check the acknowledgement'],
    ['overlap-ack-stale', 'overlap topology changed'],
    ['unattributed-ack-incomplete', 'unattributed changes that were not acknowledged'],
    ['unattributed-ack-stale', 'unattributed selection changed'],
    ['candidate-ack-stale', 'candidate changed after the preview'],
    ['mint-ack-race', 'changed again while the save token was being minted'],
  ])('renders typed acknowledgement copy for %s', (code, copy) => {
    expect(renderSaveRefusal({ stage: 'mint', code, message: 'ignored' })).toContain(copy);
  });
});
