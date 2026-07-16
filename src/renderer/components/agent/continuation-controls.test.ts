import { describe, it, expect } from 'vitest';
import type { Agent } from '../../../shared/types';
import {
  isContinuationEligible,
  getContinuationEnabled,
  forceErrorMessage,
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
});
