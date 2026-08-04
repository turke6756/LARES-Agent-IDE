// @vitest-environment jsdom
//
// WP-P4F — the deep-link seam wired through PlanDocumentTabs. The IntentLifecycleStrip
// mounts above the tabs; clicking a resolved output cross-tab must switch to the
// matching tab AND open the SPECIFIC manifest doc (not the tab's primary) — the
// pending-open one-shot must survive the tab-change effect's primary auto-open.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlanDocumentTabs from './PlanDocumentTabs';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { PlanDocumentsModel, PlanIntentsProjection, PlanDocumentReadResult } from '../../../shared/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let readDocumentMock: ReturnType<typeof vi.fn>;

function model(): PlanDocumentsModel {
  return {
    planId: 'plan-1',
    warnings: [],
    tabs: [
      { key: 'overview', populated: true, documents: [{ ref: { source: 'folder', documentId: 'd-arc' }, name: 'ARC.md', kind: 'arc', sizeBytes: 1, mtimeMs: 1 }] },
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

// One intent whose single output resolves to risk.md (d-del2) — the NON-primary
// deliberations doc (attr.md/d-del1 is primary).
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
        integrationNote: null,
        ran: true,
        runs: [{ orchestrationId: 'o1', state: 'returned', orchestrationStatus: 'complete', returnedOutputExists: true }],
        returned: true,
        fullyFoldedIn: false,
        open: true,
        outputs: [{ relPath: 'deliberations/risk.md', orchestrationId: 'o1', presentOnDisk: true, disposition: 'active', foldedIn: false }],
      },
    ],
    confidence: { markedIntents: 1, satisfiedIntents: 0, openIntents: 1, deliberationsRun: 1, finalPlanExists: false },
  };
}

beforeEach(() => {
  readDocumentMock = vi.fn(async (_planId: string, ref: { documentId: string }) =>
    ({ ref: ref as PlanDocumentReadResult['ref'], name: `${ref.documentId}.md`, content: `body ${ref.documentId}`, truncated: false, sizeBytes: 1 }),
  );
  (window as unknown as { api: unknown }).api = {
    plans: {
      documents: vi.fn(async () => model()),
      readDocument: readDocumentMock,
      getOverview: vi.fn(async () => null),
      listIntents: vi.fn(async () => projection()),
    },
  };
  useDashboardStore.setState({ agents: [] as never, selectedWorkspaceId: null } as never);
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
const tabByKey = (key: string) =>
  [...document.querySelectorAll('[data-testid="plan-tab"]')].find((b) => b.getAttribute('data-tab-key') === key) as HTMLButtonElement;

describe('PlanDocumentTabs deep-link seam (WP-P4F)', () => {
  it('a cross-tab deep-link switches tabs and opens the SPECIFIC (non-primary) doc', async () => {
    await render(<PlanDocumentTabs planId="plan-1" />);
    // Start on overview.
    expect(tabByKey('overview').getAttribute('aria-selected')).toBe('true');

    // Expand the intent and click its resolved output (risk.md → d-del2).
    await act(async () => {
      (q('intent-expand') as HTMLButtonElement).click();
    });
    await flush();
    const link = q('intent-output-link') as HTMLButtonElement;
    expect(link).not.toBeNull();
    await act(async () => {
      link.click();
    });
    await flush();

    // Switched to deliberations and opened d-del2 (the deep-link target), NOT the
    // tab's primary d-del1.
    expect(tabByKey('deliberations').getAttribute('aria-selected')).toBe('true');
    expect(readDocumentMock).toHaveBeenLastCalledWith('plan-1', { source: 'folder', documentId: 'd-del2' });
    expect(q('proposal-reader-body')?.textContent).toContain('d-del2');
  });
});
