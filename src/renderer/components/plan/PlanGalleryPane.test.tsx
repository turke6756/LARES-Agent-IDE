// @vitest-environment jsdom
//
// WP-P2D — the Plans GALLERY pane. Guarantees under test:
//   • The three durable row kinds (proposal / structured / legacy) render,
//     date-grouped, with type / state / owner / author chips.
//   • Clicking a proposal reads it via `proposal:read` into the right reader
//     pane; a Promote button is present but INERT (P3C).
//   • Clicking a structured (hasFolder) row opens the reused WP-P1B folder
//     reader overlay.
//   • Clicking a legacy row opens the legacy plan surface via onOpenLegacyPlan.
//   • The archived / promoted toggles re-query the projection with opts.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlanGalleryPane from './PlanGalleryPane';
import type { PlanGalleryRow, PlanGalleryResult, ProposalReadResult } from '../../../shared/types';

vi.mock('../browser/useBrowserSuspension', () => ({
  suspendBrowserPane: vi.fn(),
  resumeBrowserPane: vi.fn(),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let galleryMock: ReturnType<typeof vi.fn>;
let readMock: ReturnType<typeof vi.fn>;
let planningList: ReturnType<typeof vi.fn>;
let planningRead: ReturnType<typeof vi.fn>;
let paneSetVisible: ReturnType<typeof vi.fn>;
let onOpenLegacyPlan: ReturnType<typeof vi.fn>;

const PROPOSAL: PlanGalleryRow = {
  id: 'prop-1',
  type: 'proposal',
  typeLabel: 'Proposal',
  title: 'auth-revamp',
  state: 'proposal',
  dateGroup: '2026-08-03',
  createdAt: 0,
  updatedAt: 0,
  mtimeMs: 0,
  sizeBytes: 100,
  folderRelPath: null,
  hasFolder: false,
  author: { role: 'worker', display: 'edward' },
  owner: null,
};

const STRUCTURED: PlanGalleryRow = {
  id: 'plan-1',
  type: 'structured',
  typeLabel: 'Plan',
  title: 'billing-plan',
  state: 'hardening',
  dateGroup: '2026-08-02',
  createdAt: 0,
  updatedAt: 0,
  mtimeMs: 0,
  sizeBytes: null,
  folderRelPath: '.lares/plans/2026-08-02-billing',
  hasFolder: true,
  author: { role: 'unknown', display: null },
  owner: { display: 'super-1', agentId: 'a-1', source: 'manual-skill' },
};

const LEGACY: PlanGalleryRow = {
  id: 'legacy-1',
  type: 'legacy',
  typeLabel: 'Legacy Plan',
  title: 'old-auth.html',
  state: 'active',
  dateGroup: '2026-08-01',
  createdAt: 0,
  updatedAt: 0,
  mtimeMs: 0,
  sizeBytes: 200,
  folderRelPath: null,
  hasFolder: false,
  author: { role: 'unknown', display: null },
  owner: null,
};

function galleryResult(over?: Partial<PlanGalleryResult>): PlanGalleryResult {
  return { rows: [PROPOSAL, STRUCTURED, LEGACY], warnings: [], ...over };
}

function readResult(over?: Partial<ProposalReadResult>): ProposalReadResult {
  return { id: 'prop-1', name: '2026-08-03-auth-revamp.md', content: '# Auth\n\nbody-here', truncated: false, sizeBytes: 10, ...over };
}

beforeEach(() => {
  galleryMock = vi.fn(async () => galleryResult());
  readMock = vi.fn(async () => readResult());
  planningList = vi.fn(async () => ({ entries: [], warnings: [] }));
  planningRead = vi.fn(async () => ({ error: 'none' }));
  paneSetVisible = vi.fn(async () => {});
  onOpenLegacyPlan = vi.fn();
  (window as unknown as { api: unknown }).api = {
    plans: { gallery: galleryMock, readProposal: readMock, paneSetVisible },
    planningReader: { list: planningList, read: planningRead },
    demandProbe: { record: vi.fn(async () => ({ appended: true, duplicate: false })) },
  };
});

async function render(el: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(el); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

const pane = () => document.querySelector('[data-testid="plan-gallery-pane"]') as HTMLElement;
const rows = () => document.querySelectorAll('[data-testid="gallery-row"]');

function base(): React.ReactElement {
  return (
    <PlanGalleryPane
      workspaceId="ws-1"
      workspaceRoot="/ws"
      pathType="windows"
      onOpenLegacyPlan={onOpenLegacyPlan}
    />
  );
}

describe('PlanGalleryPane', () => {
  it('queries the gallery on mount and renders the three row types with chips', async () => {
    await render(base());
    expect(galleryMock).toHaveBeenCalledWith('ws-1', { includeArchived: false, includePromoted: false });
    expect(rows().length).toBe(3);

    const types = [...document.querySelectorAll('[data-testid="gallery-type-chip"]')].map(
      (c) => c.getAttribute('data-row-type'),
    );
    expect(types).toEqual(expect.arrayContaining(['proposal', 'structured', 'legacy']));

    // State chips present; owner chip on the structured row; author on proposal.
    expect(document.querySelectorAll('[data-testid="gallery-state-chip"]').length).toBe(3);
    expect(document.querySelector('[data-testid="gallery-owner-chip"]')?.textContent).toContain('super-1');
    expect(document.querySelector('[data-testid="gallery-author-chip"]')?.textContent).toContain('edward');
  });

  it('clicking a proposal reads it into the reader pane; Promote is present but inert', async () => {
    readMock.mockResolvedValue(readResult({ content: '# Auth\n\nbody-here' }));
    await render(base());
    const propRow = [...rows()].find((r) => r.getAttribute('data-row-type') === 'proposal') as HTMLElement;
    const openBtn = propRow.querySelector('[data-testid="gallery-row-open"]') as HTMLButtonElement;
    await act(async () => { openBtn.click(); });
    await flush();

    expect(readMock).toHaveBeenCalledWith('prop-1');
    expect(pane().textContent).toContain('body-here');

    // Promote button: proposals only, disabled (behavior is P3C).
    const promote = propRow.querySelector('[data-testid="gallery-promote"]') as HTMLButtonElement;
    expect(promote).toBeTruthy();
    expect(promote.disabled).toBe(true);
  });

  it('a structured (hasFolder) row opens the reused WP-P1B folder reader overlay', async () => {
    await render(base());
    const structRow = [...rows()].find((r) => r.getAttribute('data-row-type') === 'structured') as HTMLElement;
    const openBtn = structRow.querySelector('[data-testid="gallery-row-open"]') as HTMLButtonElement;
    await act(async () => { openBtn.click(); });
    await flush();

    // The WP-P1B reader overlay mounted; it does NOT read the proposal inline.
    expect(document.querySelector('[data-testid="proposal-reader-pane"]')).toBeTruthy();
    expect(readMock).not.toHaveBeenCalled();
  });

  it('a legacy row opens the legacy plan surface via onOpenLegacyPlan', async () => {
    await render(base());
    const legacyRow = [...rows()].find((r) => r.getAttribute('data-row-type') === 'legacy') as HTMLElement;
    const openBtn = legacyRow.querySelector('[data-testid="gallery-row-open"]') as HTMLButtonElement;
    await act(async () => { openBtn.click(); });
    await flush();

    expect(onOpenLegacyPlan).toHaveBeenCalledWith('legacy-1', 'old-auth.html', 'ws-1');
    expect(readMock).not.toHaveBeenCalled();
  });

  it('the archived / promoted toggles re-query the projection with opts', async () => {
    await render(base());
    const archived = document.querySelector('[data-testid="gallery-toggle-archived"] input') as HTMLInputElement;
    await act(async () => { archived.click(); });
    await flush();
    expect(galleryMock).toHaveBeenLastCalledWith('ws-1', { includeArchived: true, includePromoted: false });

    const promoted = document.querySelector('[data-testid="gallery-toggle-promoted"] input') as HTMLInputElement;
    await act(async () => { promoted.click(); });
    await flush();
    expect(galleryMock).toHaveBeenLastCalledWith('ws-1', { includeArchived: true, includePromoted: true });
  });

  it('renders an empty state when the workspace has no rows', async () => {
    galleryMock.mockResolvedValue(galleryResult({ rows: [] }));
    await render(base());
    expect(document.querySelector('[data-testid="gallery-empty"]')).toBeTruthy();
  });
});
