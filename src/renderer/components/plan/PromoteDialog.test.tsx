// @vitest-environment jsdom
//
// WP-P3C′ — the Promote dialog. §P3-GAP guarantees under test:
//   • The picker lists EXACTLY the supervisors handed in (the caller filters to
//     privileged same-workspace agents; the server re-validates on confirm) and
//     there is NO document-selection UI anywhere.
//   • Cancel from the picking phase mints NOTHING (never calls `promote`).
//   • An `adopted` result resolves straight to the plan (no poll).
//   • A `promotion-pending` result resolves to the plan via BOUNDED
//     `promotionStatus` polling (not by blocking).
//   • Polling is BOUNDED — a never-adopting request lands in `still-promoting`
//     after the attempt budget, never an infinite poll.
//   • A single confirm calls `promote` exactly once (no double-mint).
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PromoteDialog, { type SupervisorChoice } from './PromoteDialog';
import type { Plan, PromoteProposalResult, PromotionStatus } from '../../../shared/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const SUPERVISORS: SupervisorChoice[] = [
  { id: 'sup-1', title: 'Alice (supervisor)' },
  { id: 'sup-2', title: 'Bob (privileged persona)' },
];

const PLAN: Plan = {
  id: 'plan-1',
  workspaceId: 'ws-1',
  path: '.lares/plans/2026-08-03-auth/plan.md',
  slug: null,
  format: 'structured',
  runState: 'hardening',
  mtimeMs: 0,
  sizeBytes: 0,
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T00:00:00Z',
  deletedAt: null,
};

function pendingStatus(over?: Partial<PromotionStatus>): PromotionStatus {
  return {
    promotionRequestId: 'req-1',
    state: 'pending',
    planArtifactId: 'plan_abc',
    plan: null,
    failureReason: null,
    attemptCount: 1,
    ...over,
  };
}

async function render(el: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(el); });
  await act(async () => { await Promise.resolve(); });
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** Poll the DOM until `predicate` is true or the wall-clock budget elapses. Uses
 *  real (short) timers so the dialog's backoff sleeps actually fire. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function props(over?: Partial<React.ComponentProps<typeof PromoteDialog>>) {
  return {
    proposalId: 'prop-1',
    proposalTitle: '2026-08-03-auth-revamp.md',
    supervisors: SUPERVISORS,
    promote: vi.fn<() => Promise<PromoteProposalResult>>(async () => ({ status: 'adopted', plan: PLAN })),
    promotionStatus: vi.fn<() => Promise<PromotionStatus>>(async () => pendingStatus()),
    onResolved: vi.fn(),
    onClose: vi.fn(),
    // Small, bounded poll budget so the tests run fast and prove boundedness.
    pollMaxAttempts: 3,
    pollBaseDelayMs: 5,
    pollMaxDelayMs: 5,
    ...over,
  };
}

describe('PromoteDialog', () => {
  it('lists exactly the supervisors passed and shows NO document-selection UI', async () => {
    const p = props();
    await render(<PromoteDialog {...p} />);

    const select = q('promote-supervisor-select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    const optionValues = [...select.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value);
    expect(optionValues).toEqual(['sup-1', 'sup-2']);

    // §P3-GAP — no document checklist / selectedDocRelPaths surface anywhere.
    expect(document.querySelector('[data-testid="promote-doc-checklist"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/selectedDocRelPaths/);
    expect(document.body.textContent?.toLowerCase()).not.toContain('document');
  });

  it('shows a no-eligible-supervisors state and disables confirm when the list is empty', async () => {
    const p = props({ supervisors: [] });
    await render(<PromoteDialog {...p} />);
    expect(q('promote-no-supervisors')).toBeTruthy();
    expect((q('promote-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('cancel from the picking phase mints NOTHING (never calls promote)', async () => {
    const p = props();
    await render(<PromoteDialog {...p} />);
    await act(async () => { (q('promote-cancel') as HTMLButtonElement).click(); });
    expect(p.promote).not.toHaveBeenCalled();
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('an adopted result resolves straight to the plan (no poll)', async () => {
    const p = props();
    await render(<PromoteDialog {...p} />);
    await act(async () => { (q('promote-confirm') as HTMLButtonElement).click(); });
    await flush();

    expect(p.promote).toHaveBeenCalledTimes(1);
    expect(p.promote).toHaveBeenCalledWith({ proposalId: 'prop-1', supervisorId: 'sup-1' });
    expect(p.onResolved).toHaveBeenCalledWith(PLAN);
    expect(p.promotionStatus).not.toHaveBeenCalled();
    expect(q('promote-adopted')).toBeTruthy();
  });

  it('a promotion-pending result resolves to the plan via bounded status polling', async () => {
    const promote = vi.fn<() => Promise<PromoteProposalResult>>(async () => ({
      status: 'promotion-pending', promotionRequestId: 'req-1', planArtifactId: 'plan_abc',
    }));
    // First poll still pending, second poll adopted with the plan row.
    const promotionStatus = vi.fn<() => Promise<PromotionStatus>>();
    promotionStatus
      .mockResolvedValueOnce(pendingStatus())
      .mockResolvedValue(pendingStatus({ state: 'adopted', plan: PLAN }));
    const p = props({ promote, promotionStatus });
    await render(<PromoteDialog {...p} />);

    await act(async () => { (q('promote-confirm') as HTMLButtonElement).click(); });
    await waitFor(() => q('promote-adopted') !== null);

    expect(promotionStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(promotionStatus).toHaveBeenCalledWith({ promotionRequestId: 'req-1' });
    expect(p.onResolved).toHaveBeenCalledWith(PLAN);
  });

  it('polling is BOUNDED — a never-adopting request lands in still-promoting, not an infinite loop', async () => {
    const promote = vi.fn<() => Promise<PromoteProposalResult>>(async () => ({
      status: 'promotion-pending', promotionRequestId: 'req-1', planArtifactId: 'plan_abc',
    }));
    const promotionStatus = vi.fn<() => Promise<PromotionStatus>>(async () => pendingStatus());
    const p = props({ promote, promotionStatus, pollMaxAttempts: 3 });
    await render(<PromoteDialog {...p} />);

    await act(async () => { (q('promote-confirm') as HTMLButtonElement).click(); });
    await waitFor(() => q('promote-still-promoting') !== null);

    // Exactly the attempt budget — bounded, never more.
    expect(promotionStatus).toHaveBeenCalledTimes(3);
    expect(p.onResolved).not.toHaveBeenCalled();
  });

  it('a failed status surfaces the failure reason', async () => {
    const promote = vi.fn<() => Promise<PromoteProposalResult>>(async () => ({
      status: 'promotion-pending', promotionRequestId: 'req-1', planArtifactId: 'plan_abc',
    }));
    const promotionStatus = vi.fn<() => Promise<PromotionStatus>>(async () =>
      pendingStatus({ state: 'failed', failureReason: 'scaffold write failed' }),
    );
    const p = props({ promote, promotionStatus });
    await render(<PromoteDialog {...p} />);

    await act(async () => { (q('promote-confirm') as HTMLButtonElement).click(); });
    await waitFor(() => q('promote-error') !== null);
    expect(q('promote-error')?.textContent).toContain('scaffold write failed');
  });
});
