// @vitest-environment jsdom
//
// WP-P4B — the tabbed, folder-native plan document home (PlanDocumentTabs).
// Guarantees under test:
//   • Default tab is `overview`; the supervisor overview renders ABOVE `ARC.md`.
//   • Tabs switch on the stable `PlanTabKey`; only projected keys appear
//     (plan.json / .gitkeep never surface — they are simply absent).
//   • The Plan tab renders `plan.md`.
//   • Subdir tabs (deliberations) render a sibling list opened read-only BY
//     MANIFEST ID via `plans.readDocument`.
//   • A populated tab with no supervisor overview shows "overview pending".
//   • An empty subdir shows "no documents yet".
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlanDocumentTabs from './PlanDocumentTabs';
import type {
  PlanDocumentsModel,
  PlanDocumentReadResult,
  PlanTabOverview,
} from '../../../shared/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let documentsMock: ReturnType<typeof vi.fn>;
let readDocumentMock: ReturnType<typeof vi.fn>;
let getOverviewMock: ReturnType<typeof vi.fn>;

function overview(over?: Partial<PlanTabOverview>): PlanTabOverview {
  return {
    planId: 'plan-1',
    tab: 'overview',
    body: 'Supervisor summary of the plan.',
    revision: 1,
    updatedBy: 'sup-1',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

function model(): PlanDocumentsModel {
  return {
    planId: 'plan-1',
    warnings: [],
    tabs: [
      {
        key: 'overview',
        populated: true,
        documents: [{ ref: { source: 'folder', documentId: 'd-arc' }, name: 'ARC.md', kind: 'arc', sizeBytes: 100, mtimeMs: 1 }],
      },
      {
        key: 'plan',
        populated: true,
        documents: [{ ref: { source: 'folder', documentId: 'd-plan' }, name: 'plan.md', kind: 'plan', sizeBytes: 200, mtimeMs: 1 }],
      },
      {
        key: 'deliberations',
        populated: true,
        documents: [
          { ref: { source: 'folder', documentId: 'd-del1' }, name: 'attr.md', kind: 'deliberation', sizeBytes: 50, mtimeMs: 1 },
          { ref: { source: 'folder', documentId: 'd-del2' }, name: 'risk.md', kind: 'deliberation', sizeBytes: 60, mtimeMs: 1 },
        ],
      },
      {
        key: 'research',
        populated: false,
        documents: [],
      },
      {
        key: 'supplements',
        populated: true,
        documents: [
          {
            ref: { source: 'folder', documentId: 'd-invalid-machine' },
            name: 'work-packages.md',
            kind: 'supplement',
            sizeBytes: 300,
            mtimeMs: 1,
            machine: { kind: 'work-packages', status: 'invalid' },
          },
          {
            ref: { source: 'folder', documentId: 'd-human-supplement' },
            name: 'notes.md',
            kind: 'supplement',
            sizeBytes: 70,
            mtimeMs: 1,
          },
        ],
      },
    ],
  };
}

function readResult(over?: Partial<PlanDocumentReadResult>): PlanDocumentReadResult {
  return {
    ref: { source: 'folder', documentId: 'd-arc' },
    name: 'ARC.md',
    content: '# ARC\n\narc body',
    truncated: false,
    sizeBytes: 10,
    ...over,
  };
}

beforeEach(() => {
  documentsMock = vi.fn(async () => model());
  readDocumentMock = vi.fn(async (_planId: string, ref: { documentId: string }) => {
    const map: Record<string, string> = {
      'd-arc': '# ARC\n\narc body',
      'd-plan': '# Plan\n\nplan body',
      'd-del1': '# Attr\n\ndelib one',
      'd-del2': '# Risk\n\ndelib two',
      'd-invalid-machine': 'RAW MACHINE BODY MUST NOT RENDER',
      'd-human-supplement': '# Notes\n\nhuman supplement body',
    };
    return readResult({ ref: ref as PlanDocumentReadResult['ref'], name: `${ref.documentId}.md`, content: map[ref.documentId] ?? '' });
  });
  // Default: overview authored only for the `overview` tab; null elsewhere.
  getOverviewMock = vi.fn(async (_planId: string, tab: string) =>
    tab === 'overview' ? overview() : null,
  );
  (window as unknown as { api: unknown }).api = {
    plans: { documents: documentsMock, readDocument: readDocumentMock, getOverview: getOverviewMock },
  };
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

const tabButtons = () => [...document.querySelectorAll('[data-testid="plan-tab"]')] as HTMLButtonElement[];
const tabByKey = (key: string) => tabButtons().find((b) => b.getAttribute('data-tab-key') === key)!;
const body = () => document.querySelector('[data-testid="plan-tab-body"]') as HTMLElement;

describe('PlanDocumentTabs (WP-P4B tabbed document home)', () => {
  it('defaults to the overview tab and renders the supervisor overview ABOVE ARC.md', async () => {
    await render(<PlanDocumentTabs planId="plan-1" />);

    expect(documentsMock).toHaveBeenCalledWith('plan-1');
    // Default active tab = overview.
    expect(tabByKey('overview').getAttribute('aria-selected')).toBe('true');

    const ov = document.querySelector('[data-testid="plan-tab-overview-body"]');
    expect(ov?.textContent).toContain('Supervisor summary');

    // ARC read by manifest id, rendered in the read pane.
    expect(readDocumentMock).toHaveBeenCalledWith('plan-1', { source: 'folder', documentId: 'd-arc' });
    const reader = document.querySelector('[data-testid="proposal-reader-body"]');
    expect(reader?.textContent).toContain('arc body');

    // Overview element precedes the reader element in document order (overview-then-doc).
    const ovEl = document.querySelector('[data-testid="plan-tab-overview"]')!;
    const readerEl = document.querySelector('[data-testid="proposal-reader"]')!;
    expect(ovEl.compareDocumentPosition(readerEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a stale badge and withholds the ARC reader when freshness is stale', async () => {
    const staleModel = model();
    staleModel.tabs.find((tab) => tab.key === 'overview')!.documents[0].stale = true;
    documentsMock.mockResolvedValueOnce(staleModel);
    await render(<PlanDocumentTabs planId="plan-1" />);

    expect(document.querySelector('[data-testid="plan-arc-stale-badge"]')?.textContent).toContain('stale');
    expect(document.querySelector('[data-testid="plan-arc-stale-notice"]')?.textContent).toContain('ARC is stale');
    expect(document.querySelector('[data-testid="proposal-reader-body"]')).toBeNull();
  });

  it('renders only projected keys — no plan.json / .gitkeep tab', async () => {
    await render(<PlanDocumentTabs planId="plan-1" />);
    const keys = tabButtons().map((b) => b.getAttribute('data-tab-key'));
    expect(keys).toEqual(['overview', 'plan', 'deliberations', 'research', 'supplements']);
    expect(keys).not.toContain('plan.json');
    expect(keys).not.toContain('.gitkeep');
  });

  it('switches to the Plan tab and renders plan.md', async () => {
    await render(<PlanDocumentTabs planId="plan-1" />);
    await act(async () => {
      tabByKey('plan').click();
    });
    await flush();
    expect(tabByKey('plan').getAttribute('aria-selected')).toBe('true');
    expect(readDocumentMock).toHaveBeenCalledWith('plan-1', { source: 'folder', documentId: 'd-plan' });
    expect(document.querySelector('[data-testid="proposal-reader-body"]')?.textContent).toContain('plan body');
  });

  it('shows a populated tab with NO supervisor overview as "overview pending"', async () => {
    await render(<PlanDocumentTabs planId="plan-1" />);
    await act(async () => {
      tabByKey('plan').click();
    });
    await flush();
    // plan tab is populated but getOverview returned null for it.
    expect(document.querySelector('[data-testid="plan-overview-pending"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="plan-tab-overview-body"]')).toBeNull();
  });

  it('deliberations tab renders a sibling list; a sibling opens read-only by manifest id', async () => {
    await render(<PlanDocumentTabs planId="plan-1" />);
    await act(async () => {
      tabByKey('deliberations').click();
    });
    await flush();

    const siblings = document.querySelectorAll('[data-testid="plan-tab-sibling"]');
    expect(siblings.length).toBe(2);
    // Primary (first) auto-opened.
    expect(readDocumentMock).toHaveBeenCalledWith('plan-1', { source: 'folder', documentId: 'd-del1' });
    expect(body().textContent).toContain('delib one');

    // Click the second sibling → reads it by manifest id.
    await act(async () => {
      (siblings[1] as HTMLButtonElement).click();
    });
    await flush();
    expect(readDocumentMock).toHaveBeenLastCalledWith('plan-1', { source: 'folder', documentId: 'd-del2' });
    expect(body().textContent).toContain('delib two');
  });

  it('an empty subdir tab shows "no documents yet"', async () => {
    await render(<PlanDocumentTabs planId="plan-1" />);
    await act(async () => {
      tabByKey('research').click();
    });
    await flush();
    expect(document.querySelector('[data-testid="plan-tab-empty"]')?.textContent).toContain('no documents yet');
  });

  it('shows a diagnostic for an invalid machine supplement while human supplements render normally', async () => {
    await render(<PlanDocumentTabs planId="plan-1" />);
    await act(async () => {
      tabByKey('supplements').click();
    });
    await flush();

    const diagnostic = document.querySelector('[data-testid="plan-supplement-machine-diagnostic"]');
    expect(diagnostic?.textContent).toContain("couldn't be read");
    expect(body().textContent).not.toContain('RAW MACHINE BODY MUST NOT RENDER');
    expect(document.querySelector('[data-testid="proposal-reader"]')).toBeNull();

    const siblings = document.querySelectorAll('[data-testid="plan-tab-sibling"]');
    await act(async () => {
      (siblings[1] as HTMLButtonElement).click();
    });
    await flush();

    expect(document.querySelector('[data-testid="plan-supplement-machine-diagnostic"]')).toBeNull();
    expect(document.querySelector('[data-testid="proposal-reader-body"]')?.textContent).toContain('human supplement body');
  });

  it('renders "Plan not found" when the projection is null', async () => {
    documentsMock.mockResolvedValue(null);
    await render(<PlanDocumentTabs planId="ghost" />);
    expect(document.querySelector('[data-testid="plan-document-tabs-missing"]')?.textContent).toContain('Plan not found');
  });
});
