import { describe, it, expect } from 'vitest';
import type { ContinuationPhase, ContinuationPhaseState } from '../../../shared/types';
import {
  CONTINUATION_PHASE_LABELS,
  continuationPhaseLabel,
  formatRetryCountdown,
  isActivePhase,
  nextPhaseMap,
  prunePhasesForAgents,
} from './continuation-phase-view';

const ALL_PHASES: ContinuationPhase[] = [
  'queued', 'opening', 'awaiting-note', 'note-committed',
  'waiting-for-idle', 'relaunching', 'launching', 'backoff', 'failed',
];

function st(over: Partial<ContinuationPhaseState> & { phase: ContinuationPhase }): ContinuationPhaseState {
  return { agentId: 'a', updatedAt: 0, ...over };
}

describe('phase labels', () => {
  it('every one of the nine phases has a non-empty label', () => {
    for (const p of ALL_PHASES) {
      expect(CONTINUATION_PHASE_LABELS[p], p).toBeTruthy();
    }
    expect(Object.keys(CONTINUATION_PHASE_LABELS).sort()).toEqual([...ALL_PHASES].sort());
  });

  it('renders the plain phases verbatim (§4.5 table)', () => {
    const expected: Partial<Record<ContinuationPhase, string>> = {
      'queued': 'Continuation queued…',
      'opening': 'Opening handoff…',
      'awaiting-note': 'Waiting for agent to save note…',
      'note-committed': 'Continuation note saved',
      'waiting-for-idle': 'Finishing current response…',
      'relaunching': 'Switching sessions…',
      'launching': 'Starting fresh session…',
    };
    for (const [phase, label] of Object.entries(expected)) {
      expect(continuationPhaseLabel(st({ phase: phase as ContinuationPhase }), 0)).toBe(label);
    }
  });

  it('backoff renders a countdown plus the reason', () => {
    const label = continuationPhaseLabel(
      st({ phase: 'backoff', retryAt: 298_000, message: 'agent is busy' }),
      0,
    );
    expect(label).toBe('Retry in 4m 58s — agent is busy');
  });

  it('backoff without a message or a deadline still says something honest', () => {
    expect(continuationPhaseLabel(st({ phase: 'backoff', retryAt: 45_000 }), 0)).toBe('Retry in 45s…');
    expect(continuationPhaseLabel(st({ phase: 'backoff', message: 'nope' }), 0)).toBe('Retrying — nope');
  });

  it('a countdown past its deadline floors at 0s instead of going negative', () => {
    expect(formatRetryCountdown(-5_000)).toBe('0s');
    expect(continuationPhaseLabel(st({ phase: 'backoff', retryAt: 1_000 }), 9_000)).toBe('Retry in 0s…');
  });

  it('failed carries the launch error', () => {
    expect(continuationPhaseLabel(st({ phase: 'failed', message: 'CLI not found' }), 0))
      .toBe('Continuation failed: CLI not found');
    expect(continuationPhaseLabel(st({ phase: 'failed' }), 0)).toBe('Continuation failed');
  });
});

describe('isActivePhase — what lights the gold glow', () => {
  it('is true for every phase except failed', () => {
    for (const p of ALL_PHASES) {
      expect(isActivePhase(p), p).toBe(p !== 'failed');
    }
  });

  it('is false with no phase at all (the common case: nothing is happening)', () => {
    expect(isActivePhase(null)).toBe(false);
    expect(isActivePhase(undefined)).toBe(false);
  });

  it('includes backoff — the stretch the old status-derived flag left dark', () => {
    // A retry IS scheduled during backoff, so the card must not look idle.
    expect(isActivePhase('backoff')).toBe(true);
  });
});

describe('nextPhaseMap', () => {
  it('adds and overwrites by agent id', () => {
    const a = nextPhaseMap({}, st({ phase: 'queued' }));
    const b = nextPhaseMap(a, st({ phase: 'awaiting-note', attemptId: 'att-1' }));
    expect(b.a.phase).toBe('awaiting-note');
    expect(b.a.attemptId).toBe('att-1');
  });

  it('phase:null deletes the entry', () => {
    const withPhase = nextPhaseMap({}, st({ phase: 'launching' }));
    const cleared = nextPhaseMap(withPhase, { agentId: 'a', phase: null });
    expect('a' in cleared).toBe(false);
  });

  it('returns the SAME reference when a clear targets an agent with no phase', () => {
    const cur = nextPhaseMap({}, st({ phase: 'queued' }));
    expect(nextPhaseMap(cur, { agentId: 'other', phase: null })).toBe(cur);
  });

  it('leaves other agents untouched', () => {
    let m = nextPhaseMap({}, st({ agentId: 'a', phase: 'queued' }));
    m = nextPhaseMap(m, st({ agentId: 'b', phase: 'opening' }));
    m = nextPhaseMap(m, { agentId: 'a', phase: null });
    expect(Object.keys(m)).toEqual(['b']);
  });
});

describe('prunePhasesForAgents — narrow, absence-only', () => {
  const map = {
    a: st({ agentId: 'a', phase: 'awaiting-note' }),
    b: st({ agentId: 'b', phase: 'backoff' }),
  };

  it('drops only agents absent from the authoritative list', () => {
    const next = prunePhasesForAgents(map, new Set(['a']));
    expect(Object.keys(next)).toEqual(['a']);
  });

  it('does NOT drop a present agent regardless of its status', () => {
    // This is the whole point: the old reconcile cleared any agent that was not
    // currently 'restarting', which erased an in-flight handoff on every refresh.
    expect(prunePhasesForAgents(map, new Set(['a', 'b']))).toBe(map);
  });

  it('honours the in-scope predicate so a workspace-scoped refresh cannot touch other workspaces', () => {
    // 'b' is absent from this workspace's list but belongs to another one.
    const next = prunePhasesForAgents(map, new Set(['a']), (id) => id !== 'b');
    expect(Object.keys(next).sort()).toEqual(['a', 'b']);
  });
});
