// @vitest-environment jsdom
//
// WP-P4F — the intent-lifecycle strip. Guarantees under test:
//   • No projection (IPC absent / returns null) → the strip renders NOTHING, so
//     the document home is untouched pre-ledger.
//   • A present projection renders a compact strip with the DERIVED confidence
//     readout and one row per intent showing its rung ladder.
//   • `ran` is authoritative only from the ledger join: false → "ran: unavailable";
//     a running run → "in service of this marked part". A self-declared
//     orchestration id on an output is never treated as authority.
//   • Expanding a row shows per-output detail IN PLACE; each output is independent.
//   • Ruling 12: an unfolded, present, active output is OPEN, never complete.
//   • Deep-link: an output whose relPath cross-indexes to the manifest is
//     clickable (calls onOpenDocument with the manifest id + tab); a history-only
//     output (no match) and a missing output stay visible but non-clickable.
//   • withdrawn / superseded intents are surfaced.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import IntentLifecycleStrip, { crossIndexOutput, outputStatus } from './IntentLifecycleStrip';
import type { PlanDocumentsModel, PlanIntentsProjection } from '../../../shared/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let listIntentsMock: ReturnType<typeof vi.fn>;
let onOpenDocument: ReturnType<typeof vi.fn>;

function model(): PlanDocumentsModel {
  return {
    planId: 'plan-1',
    warnings: [],
    tabs: [
      { key: 'plan', populated: true, documents: [{ ref: { source: 'folder', documentId: 'd-plan' }, name: 'plan.md', kind: 'plan', sizeBytes: 1, mtimeMs: 1 }] },
      {
        key: 'deliberations',
        populated: true,
        documents: [
          { ref: { source: 'folder', documentId: 'd-del1' }, name: 'attr.md', kind: 'deliberation', sizeBytes: 1, mtimeMs: 1 },
          { ref: { source: 'folder', documentId: 'd-del2' }, name: 'risk.md', kind: 'deliberation', sizeBytes: 1, mtimeMs: 1 },
        ],
      },
    ],
  };
}

function projection(): PlanIntentsProjection {
  return {
    planId: 'plan-1',
    intents: [
      {
        intentId: 'intent-A',
        status: 'active',
        withdrawn: false,
        superseded: false,
        rung: 'returned',
        integrationNote: 'folded the attribution result into the plan',
        ran: true,
        runs: [{ orchestrationId: 'orch-1', state: 'running', orchestrationStatus: 'running', returnedOutputExists: true }],
        returned: true,
        fullyFoldedIn: false,
        open: true,
        outputs: [
          // present, active, not folded → OPEN; cross-indexes to d-del1 → clickable.
          { relPath: 'deliberations/attr.md', orchestrationId: 'orch-1', presentOnDisk: true, disposition: 'active', foldedIn: false },
          // present but NOT in the current manifest → history-only, non-clickable.
          { relPath: 'deliberations/ghost.md', orchestrationId: 'orch-1', presentOnDisk: true, disposition: 'active', foldedIn: false },
          // missing on disk → non-clickable.
          { relPath: 'deliberations/gone.md', orchestrationId: null, presentOnDisk: false, disposition: 'active', foldedIn: false },
        ],
      },
      {
        intentId: 'intent-B',
        status: 'withdrawn',
        withdrawn: true,
        superseded: false,
        rung: 'marked',
        integrationNote: null,
        ran: false,
        runs: [],
        returned: false,
        fullyFoldedIn: false,
        open: false,
        outputs: [{ relPath: 'deliberations/risk.md', orchestrationId: null, presentOnDisk: true, disposition: 'active', foldedIn: true }],
      },
    ],
    confidence: { markedIntents: 2, satisfiedIntents: 1, openIntents: 1, deliberationsRun: 1, finalPlanExists: false },
  };
}

beforeEach(() => {
  listIntentsMock = vi.fn(async () => projection());
  onOpenDocument = vi.fn();
  (window as unknown as { api: unknown }).api = { plans: { listIntents: listIntentsMock } };
});

async function render(el: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(el);
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
const rowById = (id: string) => qa('intent-row').find((r) => r.getAttribute('data-intent-id') === id)!;
const strip = () => (
  <IntentLifecycleStrip
    planId="plan-1"
    model={model()}
    onOpenDocument={onOpenDocument as unknown as React.ComponentProps<typeof IntentLifecycleStrip>['onOpenDocument']}
  />
);

describe('crossIndexOutput (deep-link resolution)', () => {
  it('resolves a folder-relative path to the matching manifest id + tab', () => {
    expect(crossIndexOutput(model(), 'deliberations/attr.md')).toEqual({
      key: 'deliberations',
      ref: { source: 'folder', documentId: 'd-del1' },
    });
  });
  it('returns null for a path with no current manifest match (history-only)', () => {
    expect(crossIndexOutput(model(), 'deliberations/ghost.md')).toBeNull();
    expect(crossIndexOutput(null, 'deliberations/attr.md')).toBeNull();
  });
});

describe('outputStatus (ruling 12)', () => {
  it('present + active + unfolded is OPEN, never complete', () => {
    expect(outputStatus({ relPath: 'x', orchestrationId: null, presentOnDisk: true, disposition: 'active', foldedIn: false })).toBe('open');
  });
  it('surfaces folded-in, missing, superseded, withdrawn distinctly', () => {
    expect(outputStatus({ relPath: 'x', orchestrationId: null, presentOnDisk: true, disposition: 'active', foldedIn: true })).toBe('folded-in');
    expect(outputStatus({ relPath: 'x', orchestrationId: null, presentOnDisk: false, disposition: 'active', foldedIn: false })).toBe('missing');
    expect(outputStatus({ relPath: 'x', orchestrationId: null, presentOnDisk: true, disposition: 'superseded', foldedIn: false })).toBe('superseded');
    expect(outputStatus({ relPath: 'x', orchestrationId: null, presentOnDisk: true, disposition: 'withdrawn', foldedIn: false })).toBe('withdrawn');
  });
});

describe('IntentLifecycleStrip', () => {
  it('renders NOTHING when the projection is null (IPC returns null)', async () => {
    listIntentsMock.mockResolvedValue(null);
    await render(strip());
    expect(q('intent-strip')).toBeNull();
  });

  it('renders NOTHING when the listIntents binding is absent', async () => {
    (window as unknown as { api: unknown }).api = { plans: {} };
    await render(strip());
    expect(q('intent-strip')).toBeNull();
  });

  it('renders the derived confidence readout and one row per intent', async () => {
    await render(strip());
    expect(listIntentsMock).toHaveBeenCalledWith('plan-1');
    expect(q('intent-strip')).not.toBeNull();
    const conf = q('intent-confidence');
    expect(conf?.textContent).toContain('derived');
    expect(conf?.textContent).toContain('marked 2');
    expect(conf?.textContent).toContain('open 1');
    expect(conf?.textContent).toContain('final plan no');
    expect(qa('intent-row').length).toBe(2);
  });

  it('shows the rung ladder with reached rungs and the ran readout', async () => {
    await render(strip());
    const a = rowById('intent-A');
    // rung 'returned' → marked/ran/returned reached, folded-in not.
    const rungs = [...a.querySelectorAll('[data-testid="intent-rung"]')] as HTMLElement[];
    const reached = Object.fromEntries(rungs.map((r) => [r.getAttribute('data-rung'), r.getAttribute('data-reached')]));
    expect(reached.marked).toBe('true');
    expect(reached.returned).toBe('true');
    expect(reached['folded-in']).toBe('false');
    // ran = true with a running run.
    expect(a.querySelector('[data-testid="intent-ran"]')?.textContent).toContain('in service of this marked part');
    // intent-B ran = false → unavailable.
    expect(rowById('intent-B').querySelector('[data-testid="intent-ran"]')?.textContent).toContain('ran: unavailable');
  });

  it('surfaces a withdrawn intent', async () => {
    await render(strip());
    const b = rowById('intent-B');
    expect(b.getAttribute('data-status')).toBe('withdrawn');
    expect(b.querySelector('[data-testid="intent-lifecycle-tag"]')?.textContent).toContain('withdrawn');
  });

  it('expands in place to per-output detail; each output independent; ruling 12 OPEN', async () => {
    await render(strip());
    const a = rowById('intent-A');
    await act(async () => {
      (a.querySelector('[data-testid="intent-expand"]') as HTMLButtonElement).click();
    });
    await flush();

    const outputs = [...rowById('intent-A').querySelectorAll('[data-testid="intent-output"]')] as HTMLElement[];
    // All three results listed independently — none collapsed away.
    expect(outputs.length).toBe(3);
    const statuses = outputs.map((o) => o.getAttribute('data-status'));
    expect(statuses).toEqual(['open', 'open', 'missing']);
    // Integration note surfaced.
    expect(rowById('intent-A').querySelector('[data-testid="intent-integration-note"]')?.textContent).toContain('attribution');
  });

  it('deep-links a present manifest-matched output; history-only + missing are non-clickable', async () => {
    await render(strip());
    await act(async () => {
      (rowById('intent-A').querySelector('[data-testid="intent-expand"]') as HTMLButtonElement).click();
    });
    await flush();

    const links = [...rowById('intent-A').querySelectorAll('[data-testid="intent-output-link"]')] as HTMLButtonElement[];
    const statics = rowById('intent-A').querySelectorAll('[data-testid="intent-output-static"]');
    // Only attr.md resolves against the manifest → exactly one clickable link;
    // ghost.md (history-only) + gone.md (missing) are static.
    expect(links.length).toBe(1);
    expect(statics.length).toBe(2);
    expect(links[0].textContent).toContain('deliberations/attr.md');

    await act(async () => {
      links[0].click();
    });
    expect(onOpenDocument).toHaveBeenCalledWith('deliberations', { source: 'folder', documentId: 'd-del1' });
  });

  it('renders the strip with an empty-but-present projection (confidence still shown)', async () => {
    listIntentsMock.mockResolvedValue({
      planId: 'plan-1',
      intents: [],
      confidence: { markedIntents: 0, satisfiedIntents: 0, openIntents: 0, deliberationsRun: 0, finalPlanExists: false },
    } satisfies PlanIntentsProjection);
    await render(strip());
    expect(q('intent-strip')).not.toBeNull();
    expect(q('intent-empty')?.textContent).toContain('no intents marked yet');
    expect(q('intent-confidence')).not.toBeNull();
  });
});
