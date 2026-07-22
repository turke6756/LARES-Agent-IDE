import { describe, it, expect } from 'vitest';
import type { Agent } from '../../../shared/types';
import {
  isContinuationEligible,
  getContinuationEnabled,
  forceErrorMessage,
  continuationForceBlockedReason,
} from './continuation-controls';

// Minimal Agent stub — the helpers only read `provider` / `isSupervisor` /
// `continuationEnabled`. Default to a claude SUPERVISOR (the eligible case).
const agent = (over: Partial<Agent> & Record<string, unknown> = {}): Agent =>
  ({ id: 'a', provider: 'claude', isSupervisor: true, ...over } as unknown as Agent);

describe('isContinuationEligible', () => {
  it('is true for a claude supervisor', () => {
    expect(isContinuationEligible(agent({ provider: 'claude', isSupervisor: true }))).toBe(true);
  });

  it('defaults to claude when provider is missing (supervisor still eligible)', () => {
    expect(isContinuationEligible({ provider: undefined, isSupervisor: true } as unknown as Pick<Agent, 'provider' | 'isSupervisor'>)).toBe(true);
  });

  it('is false for a non-supervisor claude worker', () => {
    expect(isContinuationEligible(agent({ provider: 'claude', isSupervisor: false }))).toBe(false);
  });

  it("is true for a claude privilegeLane:'supervisor' persona (#19 — isSupervisor false)", () => {
    expect(isContinuationEligible(agent({ provider: 'claude', isSupervisor: false, privilegeLane: 'supervisor' }))).toBe(true);
  });

  it('is false for a codex privilege-lane persona (claude-only feature)', () => {
    expect(isContinuationEligible(agent({ provider: 'codex', isSupervisor: false, privilegeLane: 'supervisor' }))).toBe(false);
  });

  it('is false for codex / gemini supervisors', () => {
    expect(isContinuationEligible(agent({ provider: 'codex', isSupervisor: true }))).toBe(false);
    expect(isContinuationEligible(agent({ provider: 'gemini', isSupervisor: true }))).toBe(false);
  });
});

describe('getContinuationEnabled', () => {
  it('defaults to on (true) when the field is absent (pre-contract build)', () => {
    expect(getContinuationEnabled(agent())).toBe(true);
  });

  it('reads an explicit false', () => {
    expect(getContinuationEnabled(agent({ continuationEnabled: false }))).toBe(false);
  });

  it('reads an explicit true', () => {
    expect(getContinuationEnabled(agent({ continuationEnabled: true }))).toBe(true);
  });
});

describe('forceErrorMessage', () => {
  it('returns null on success', () => {
    expect(forceErrorMessage({ ok: true })).toBeNull();
  });

  it('reports the server error string when present', () => {
    expect(forceErrorMessage({ ok: false, error: 'no session' })).toBe('Transfer failed — no session');
  });

  it('falls back to a generic message when ok:false with no error', () => {
    expect(forceErrorMessage({ ok: false })).toBe('Transfer failed');
  });

  it('treats a null/absent result as unavailable', () => {
    expect(forceErrorMessage(null)).toBe('Transfer unavailable');
    expect(forceErrorMessage(undefined)).toBe('Transfer unavailable');
  });

  it('surfaces a thrown Error message (IPC rejection)', () => {
    expect(forceErrorMessage(undefined, new Error('bridge down'))).toBe('Transfer failed — bridge down');
  });

  it('surfaces a non-Error throw as a string', () => {
    expect(forceErrorMessage(undefined, 'boom')).toBe('Transfer failed — boom');
  });

  it('uses the generic message for an empty thrown message', () => {
    expect(forceErrorMessage(undefined, new Error('   '))).toBe('Transfer failed');
  });

  it('prefers the stable code copy over the server prose', () => {
    expect(forceErrorMessage({ ok: false, code: 'continuation-not-watched', error: 'long main-process prose' }))
      .toBe('Transfer failed — this agent is not being watched (needs a running Claude supervisor)');
    expect(forceErrorMessage({ ok: false, code: 'continuation-disabled', error: 'x' }))
      .toBe('Transfer failed — auto context transfer is off for this agent');
    expect(forceErrorMessage({ ok: false, code: 'continuation-watcher-unavailable' }))
      .toBe('Transfer failed — the continuation watcher is not running');
  });
});

describe('continuationForceBlockedReason', () => {
  const withStatus = (status: string) =>
    continuationForceBlockedReason({ status } as unknown as Pick<Agent, 'status'>);

  // The main-process watcher tick only visits getActiveAgents() ∩ eligible, and
  // getActiveAgents excludes done/crashed. A live-looking button on one of those
  // cards IS the "I clicked the arrow and nothing happened" report.
  it('blocks a finished agent', () => {
    expect(withStatus('done')).toBe('Agent has finished — there is no session to hand off');
  });

  it('blocks a crashed agent', () => {
    expect(withStatus('crashed')).toBe('Agent has crashed — restart it before transferring context');
  });

  it('blocks a starting agent (launching / restarting share one reason)', () => {
    const reason = 'Agent is still starting — transfer available once it is running';
    expect(withStatus('launching')).toBe(reason);
    expect(withStatus('restarting')).toBe(reason);
  });

  it('allows every live status', () => {
    expect(withStatus('working')).toBeNull();
    expect(withStatus('idle')).toBeNull();
    expect(withStatus('waiting')).toBeNull();
    // Projection-only overlay while a send is being typed in — still a live agent.
    expect(withStatus('receiving')).toBeNull();
  });
});
