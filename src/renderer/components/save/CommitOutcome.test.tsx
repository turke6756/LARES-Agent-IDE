// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { CommitCoordinatorConsumeResponse } from '../../../shared/types';
import CommitOutcome, { classifyCommitOutcome } from './CommitOutcome';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const committed = {
  status: 'committed' as const,
  commitOid: 'abc123',
  attemptId: 'attempt-1',
  indexIntegrity: 'verified' as const,
};

const mounted: Array<() => void> = [];
function render(response: CommitCoordinatorConsumeResponse, onRepreview?: () => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<CommitOutcome response={response} onRepreview={onRepreview} />));
  mounted.push(() => { act(() => root.unmount()); container.remove(); });
  return container;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

describe('CommitOutcome states', () => {
  it('renders the deliberate saved payoff only from the verified integrated envelope', () => {
    const container = render({ kind: 'saved', outcome: committed, finalizations: [] });
    expect(container.querySelector('[data-state="saved"]')).toBeTruthy();
    expect(container.textContent).toContain('committed, verified, and recorded');
    expect(container.textContent).toContain('abc123');
  });

  it('renders aborted-stale as stale-refused with moved paths/reason and explicit re-preview', () => {
    const repreview = vi.fn();
    const container = render({
      kind: 'outcome',
      outcome: { status: 'aborted-stale', reason: 'src/a.ts and src/b.ts changed', attemptId: 'attempt-2' },
    }, repreview);
    expect(container.querySelector('[data-state="stale-refused"]')).toBeTruthy();
    expect(container.textContent?.toLowerCase()).toContain('changed since you approved it');
    expect(container.textContent).toContain('src/a.ts and src/b.ts changed');
    act(() => (container.querySelector('[data-testid="commit-outcome-repreview"]') as HTMLButtonElement).click());
    expect(repreview).toHaveBeenCalledOnce();
  });

  it('renders aborted-error as a calm refusal, never as saved', () => {
    const container = render({
      kind: 'outcome',
      outcome: { status: 'aborted-error', reason: 'The commit hook declined the message.', attemptId: 'attempt-3' },
    });
    expect(container.querySelector('[data-state="stale-refused"]')).toBeTruthy();
    expect(container.textContent).toContain('Nothing was committed');
    expect(container.querySelector('[data-state="saved"]')).toBeNull();
  });

  it('renders committed-integrity-mismatch as an honest retained-commit incident with paths', () => {
    const container = render({
      kind: 'outcome',
      outcome: {
        status: 'committed-integrity-mismatch', commitOid: 'bad456', attemptId: 'attempt-4',
        mismatchedPaths: [{ pathBytesBase64: 'YQ==', displayPath: 'src/moved.ts', utf8Clean: true }],
        indexIntegrity: 'verified',
      },
    });
    expect(container.querySelector('[data-state="integrity-incident"]')).toBeTruthy();
    expect(container.textContent).toContain('commit was retained');
    expect(container.textContent).toContain('src/moved.ts');
    expect(container.textContent).toContain('bad456');
  });

  it('renders repository-state-uncertain with preserved HEAD evidence and no rollback affordance', () => {
    const container = render({
      kind: 'outcome',
      outcome: {
        status: 'repository-state-uncertain', pinnedHeadOid: 'head-before',
        resolvedHeadOid: 'head-after', attemptId: 'attempt-5',
      },
    });
    expect(container.querySelector('[data-state="repository-uncertain"]')).toBeTruthy();
    expect(container.textContent).toContain('head-before');
    expect(container.textContent).toContain('head-after');
    expect(container.querySelector('button')).toBeNull();
  });

  it('preserves an identified commit OID and post-commit HEAD drift without calling it saved', () => {
    const container = render({
      kind: 'saved',
      outcome: { ...committed, currentHeadDrift: { resolvedHeadOid: 'head-after-commit' } },
      finalizations: [],
    });
    expect(container.querySelector('[data-state="repository-uncertain"]')).toBeTruthy();
    expect(container.textContent).toContain('abc123');
    expect(container.textContent).toContain('head-after-commit');
    expect(container.querySelector('[data-state="saved"]')).toBeNull();
  });
});

describe('saved is unreachable from non-verified response shapes', () => {
  const cases: Array<[string, CommitCoordinatorConsumeResponse]> = [
    ['raw committed-integrity-mismatch', {
      kind: 'outcome', outcome: {
        status: 'committed-integrity-mismatch', commitOid: 'bad', attemptId: 'a', mismatchedPaths: [], indexIntegrity: 'verified',
      },
    }],
    ['reconciliation failure', {
      kind: 'reconciliation-error', outcome: committed, error: { code: 'ledger', message: 'ledger unavailable' },
    }],
    ['index mismatch', {
      kind: 'saved', outcome: { ...committed, indexIntegrity: 'mismatch' }, finalizations: [],
    }],
    ['index unavailable', {
      kind: 'saved', outcome: { ...committed, indexIntegrity: 'unavailable' }, finalizations: [],
    }],
    ['post-commit HEAD drift', {
      kind: 'saved', outcome: { ...committed, currentHeadDrift: { resolvedHeadOid: 'new-head' } }, finalizations: [],
    }],
    ['repository uncertainty', {
      kind: 'outcome', outcome: {
        status: 'repository-state-uncertain', pinnedHeadOid: 'old', resolvedHeadOid: 'new', attemptId: 'a',
      },
    }],
  ];

  it.each(cases)('%s does not classify or render as saved', (_label, response) => {
    expect(classifyCommitOutcome(response)).not.toBe('saved');
    const container = render(response);
    expect(container.querySelector('[data-state="saved"]')).toBeNull();
  });
});
