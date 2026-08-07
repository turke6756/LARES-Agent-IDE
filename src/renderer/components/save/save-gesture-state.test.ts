import { describe, expect, it } from 'vitest';
import { initialSaveGestureState, saveGestureReducer } from './save-gesture-state';

const pin = (packageId: string) => ({
  finalizationId: `fin-${packageId}`, packageId, finalizationKind: 'fleet-adhoc' as const,
  planId: null, planItemId: null, boundaryRef: `ref-${packageId}`, boundaryOid: 'oid',
  boundaryStatus: 'ready' as const, lifecycleStatus: 'active' as const,
  finalizedAt: 1, finalizedBy: 'human', checkpointTurnId: null, contractVersion: 1,
  outcome: 'created' as const, packageRevision: 1,
  pinnedSelection: { selectedComponentIds: [packageId], selectedUnattributedEntryIds: [], frozenMemberCount: 1 },
});

describe('save gesture state machine', () => {
  it('retains partial successful pins through an exact-package refusal', () => {
    let state = saveGestureReducer(initialSaveGestureState, { type: 'pin-started' });
    state = saveGestureReducer(state, { type: 'pins-updated', pins: [pin('package-a')], complete: false });
    state = saveGestureReducer(state, {
      type: 'refused',
      refusal: { stage: 'boundary-capture', code: 'boundary-capture-failed', message: 'package-b failed', paths: ['package-b'] },
    });
    expect(state.status).toBe('refused');
    expect(state.pins.map((item) => item.packageId)).toEqual(['package-a']);
    if (state.status === 'refused') expect(state.refusal.paths).toEqual(['package-b']);
  });

  it('retains the server terminal results until acknowledged', () => {
    let state = saveGestureReducer(initialSaveGestureState, { type: 'pins-updated', pins: [pin('package-a')], complete: true });
    state = saveGestureReducer(state, {
      type: 'completed',
      outcome: {
        halted: false, haltKind: null,
        results: [{
          kind: 'saved', repositoryKey: 'repo', finalizationId: 'fin-package-a',
          packageId: 'package-a', packageRevision: 1, commitOid: 'oid', attemptId: 'attempt',
        }],
      },
    });
    expect(state.status).toBe('completed');
    expect(state.pins).toHaveLength(1);
    if (state.status === 'completed') expect(state.outcome.results[0].kind).toBe('saved');
    state = saveGestureReducer(state, { type: 'acknowledged' });
    expect(state).toEqual(initialSaveGestureState);
  });
});
