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
});
