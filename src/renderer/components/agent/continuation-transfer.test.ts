import { describe, it, expect } from 'vitest';
import type { AgentStatus } from '../../../shared/types';
import {
  isContinuationTransferStart,
  nextTransferSet,
  reconcileTransferSet,
} from './continuation-transfer';

const start = (agentId: string) => ({ agentId, status: 'restarting' as AgentStatus, source: 'continuation' });

describe('isContinuationTransferStart', () => {
  it('is true only for restarting + continuation', () => {
    expect(isContinuationTransferStart({ agentId: 'a', status: 'restarting', source: 'continuation' })).toBe(true);
  });

  it('is false for an ordinary auto-restart (restarting + restart)', () => {
    expect(isContinuationTransferStart({ agentId: 'a', status: 'restarting', source: 'restart' })).toBe(false);
  });

  it('is false for a continuation-sourced non-restarting status', () => {
    // continuation-failed surfaces as status 'crashed' — an END, never a start.
    expect(isContinuationTransferStart({ agentId: 'a', status: 'crashed', source: 'continuation-failed' })).toBe(false);
  });

  it('is false when source is missing', () => {
    expect(isContinuationTransferStart({ agentId: 'a', status: 'restarting' })).toBe(false);
  });
});

describe('nextTransferSet', () => {
  it('adds the agent on a continuation restart', () => {
    const next = nextTransferSet(new Set(), start('a'));
    expect([...next]).toEqual(['a']);
  });

  it('clears the agent on its next status change (successor launching)', () => {
    const during = nextTransferSet(new Set(), start('a'));
    const after = nextTransferSet(during, { agentId: 'a', status: 'launching', source: 'launch' });
    expect(after.has('a')).toBe(false);
  });

  it('clears the agent on a failed swap (crashed)', () => {
    const during = nextTransferSet(new Set(), start('a'));
    const after = nextTransferSet(during, { agentId: 'a', status: 'crashed', source: 'continuation-failed' });
    expect(after.has('a')).toBe(false);
  });

  it('does NOT light up an ordinary auto-restart', () => {
    const next = nextTransferSet(new Set(), { agentId: 'a', status: 'restarting', source: 'restart' });
    expect(next.has('a')).toBe(false);
  });

  it('returns the same reference when a continuation restart repeats (no-op)', () => {
    const during = nextTransferSet(new Set(), start('a'));
    const again = nextTransferSet(during, start('a'));
    expect(again).toBe(during);
  });

  it('returns the same reference when an untracked agent changes status', () => {
    const cur = new Set<string>();
    expect(nextTransferSet(cur, { agentId: 'x', status: 'working', source: 'monitor' })).toBe(cur);
  });

  it('tracks agents independently', () => {
    let s: Set<string> = new Set();
    s = nextTransferSet(s, start('a'));
    s = nextTransferSet(s, start('b'));
    expect([...s].sort()).toEqual(['a', 'b']);
    s = nextTransferSet(s, { agentId: 'a', status: 'working', source: 'monitor' });
    expect([...s]).toEqual(['b']);
  });
});

describe('reconcileTransferSet', () => {
  const at = (id: string, status: AgentStatus) => ({ id, status });

  it('keeps a tracked agent that is still restarting', () => {
    const cur = new Set(['a']);
    expect(reconcileTransferSet(cur, [at('a', 'restarting')])).toBe(cur);
  });

  it('clears a tracked agent that is no longer restarting', () => {
    const cur = new Set(['a']);
    const next = reconcileTransferSet(cur, [at('a', 'working')]);
    expect(next.has('a')).toBe(false);
  });

  it('clears a tracked agent that vanished from the list', () => {
    const cur = new Set(['a']);
    const next = reconcileTransferSet(cur, [at('b', 'restarting')]);
    expect(next.has('a')).toBe(false);
  });

  it('returns the same reference on an empty set', () => {
    const cur = new Set<string>();
    expect(reconcileTransferSet(cur, [at('a', 'working')])).toBe(cur);
  });

  it('returns the same reference when every tracked agent is still restarting', () => {
    const cur = new Set(['a', 'b']);
    expect(reconcileTransferSet(cur, [at('a', 'restarting'), at('b', 'restarting')])).toBe(cur);
  });
});
