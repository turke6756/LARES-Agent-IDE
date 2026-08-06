// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardStore } from '../../stores/dashboard-store';
import PlansPane from './PlansPane';

vi.mock('../fileviewer/MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => React.createElement('article', { 'data-testid': 'shared-markdown-reader' }, content),
}));
vi.mock('./PromoteToPlanPanel', () => ({
  default: ({ proposalArtifactId, proposalDocumentId }: { proposalArtifactId?: string | null; proposalDocumentId: string }) => React.createElement('div', {
    'data-testid': 'promote-plan-panel',
    'data-proposal-artifact-id': proposalArtifactId ?? '',
    'data-proposal-document-id': proposalDocumentId,
  }),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = {
  id: 'ws-1',
  title: 'Workspace',
  path: 'C:\\work',
  pathType: 'windows' as const,
  description: '',
  defaultCommand: '',
  createdAt: '',
  updatedAt: '',
  lastOpenedAt: null,
};

const documents = [
  { docId: 'new', name: '2026-08-03-new.md', category: 'proposal' as const, sizeBytes: 10, mtimeMs: 30 },
  { docId: 'old', name: '2026-07-01-old.md', category: 'proposal' as const, sizeBytes: 10, mtimeMs: 40 },
  { docId: 'promoted', name: '2026-08-05-promoted.md', category: 'proposal' as const, sizeBytes: 10, mtimeMs: 50 },
];

const galleryRows = [
  {
    id: 'proposal-new', type: 'proposal', artifactId: 'prop_1234abcd',
    author: { role: 'supervisor', display: 'Save Card Execution', agentId: 'f57ca63c-1111-2222-3333-444444444444' },
  },
  {
    id: 'proposal-promoted', type: 'proposal', artifactId: 'prop_0e1425af',
    author: { role: 'worker', display: 'Witnessed Worker', agentId: 'abcd1234-1111-2222-3333-444444444444' },
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(selector: string): void {
  const element = container!.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  act(() => element!.click());
}

beforeEach(() => {
  (window as unknown as { api: unknown }).api = {
    planningReader: {
      list: vi.fn(async () => ({
        entries: documents.map((document) => ({
          entryId: document.docId,
          kind: 'proposal',
          title: document.name,
          documents: [document],
          mtimeMs: document.mtimeMs,
        })),
        warnings: [],
      })),
      read: vi.fn(async (docId: string) => ({
        docId,
        name: `${docId}.md`,
        content: docId === 'promoted'
          ? `---\nartifact_id: prop_0e1425af\nauthor: "Planning Supervisor" (supervisor, AgentDashboard)\nauthor_agent_id: deadbeef-1111-2222-3333-444444444444\nauthor_role: supervisor\nauthored_at: 2026-08-05T10:00:00Z\npromoted_to: 2026-08-05-split-the-proposal-lifecycle-an-authoring-skill--0e1425af\npromoted_at: 2026-08-05\n---\n# Promoted proposal\n\nPromoted history description.`
          : `${docId === 'new' ? '---\nartifact_id: prop_1234abcd\nauthor: "Save Card Execution" (supervisor, AgentDashboard)\nauthor_agent_id: f57ca63c-1111-2222-3333-444444444444\nauthor_role: supervisor\nauthored_at: 2026-08-03T12:00:00Z\n---\n' : ''}# ${docId === 'new' ? 'Newest proposal' : 'Older proposal'}\n\nDescription for ${docId}.`,
        truncated: false,
        sizeBytes: 10,
      })),
    },
    plans: {
      gallery: vi.fn(async () => ({ rows: galleryRows, warnings: [] })),
    },
  };
  useDashboardStore.setState({
    workspaces: [workspace],
    selectedWorkspaceId: workspace.id,
    plansOpen: true,
    fileViewerOpen: false,
    browserOpen: false,
    saveCardOpen: false,
    openTabs: [],
    activeTabId: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('ProposalCardGallery', () => {
  it('orders cards by timeline and expands/collapses through the shared markdown reader', async () => {
    await render(<PlansPane />);
    const cards = [...container!.querySelectorAll('[data-testid="proposal-card"]')];
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('Newest proposal'),
      expect.stringContaining('Older proposal'),
    ]);
    expect(cards[0].querySelector('[data-testid="proposal-card-date"]')?.textContent).toBe('Aug 3, 2026');
    expect(cards[0].querySelector('[data-testid="proposal-card-declared-author"]')?.textContent)
      .toContain('by Save Card Execution · supervisor · f57ca63c · Aug 3, 2026');
    expect(cards[0].querySelector('[data-testid="proposal-card-witnessed-author"]')?.textContent)
      .toContain('Save Card Execution · f57ca63c');
    expect(cards[1].querySelector('[data-testid="proposal-card-declared-author"]')).toBeNull();
    expect(cards[1].querySelector('[data-testid="proposal-card-witnessed-author"]')?.textContent)
      .toContain('unavailable');

    click('[data-testid="proposal-card"]');
    expect(container!.querySelector('[data-testid="proposal-expanded-reader"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="shared-markdown-reader"]')?.textContent).toContain('Newest proposal');
    expect(container!.querySelector('[data-testid="plans-promoted-region"]')).toBeNull();
    expect(container!.querySelector('[data-testid="plans-pane"]')?.getAttribute('data-proposal-expanded')).toBe('true');

    click('[data-testid="proposal-collapse"]');
    expect(container!.querySelectorAll('[data-testid="proposal-card"]')).toHaveLength(2);
    expect(container!.querySelector('[data-testid="plans-promoted-region"]')).not.toBeNull();
  });

  it('installs native horizontal wheel scrolling on the card row', async () => {
    await render(<PlansPane />);
    const row = container!.querySelector<HTMLElement>('[data-testid="proposal-card-row"]')!;
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 800 });
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 300 });
    row.scrollLeft = 20;

    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 75 });
    act(() => row.dispatchEvent(event));
    expect(row.scrollLeft).toBe(95);
    expect(event.defaultPrevented).toBe(true);
  });

  it('moves a fixture-stamped proposal into a collapsed group with its full card metadata', async () => {
    await render(<PlansPane />);

    expect(container!.querySelectorAll('[data-testid="proposal-card-row"] [data-testid="proposal-card"]')).toHaveLength(2);
    const group = container!.querySelector('[data-testid="proposal-promoted-group"]')!;
    expect(group.querySelector('[data-testid="proposal-promoted-card-row"]')).toBeNull();
    expect(group.textContent).toContain('Promoted (1)');

    click('[data-testid="proposal-promoted-toggle"]');
    const promotedCard = group.querySelector('[data-testid="proposal-card"]')!;
    expect(promotedCard.textContent).toContain('Promoted proposal');
    expect(promotedCard.textContent).toContain('Promoted history description.');
    expect(promotedCard.querySelector('[data-testid="proposal-card-date"]')?.textContent).toBe('Aug 5, 2026');
    expect(promotedCard.querySelector('[data-testid="proposal-card-declared-author"]')?.textContent)
      .toContain('by Planning Supervisor · supervisor · deadbeef · Aug 5, 2026');
    expect(promotedCard.querySelector('[data-testid="proposal-card-witnessed-author"]')?.textContent)
      .toContain('Witnessed Worker · abcd1234');
    expect(promotedCard.querySelector('[data-testid="proposal-card-author-mismatch"]')?.textContent)
      .toContain('byline unwitnessed');
  });

  it('keeps top-level navigation reachable while a proposal is expanded', async () => {
    function NavigationHarness(): React.ReactElement {
      const plansOpen = useDashboardStore((state) => state.plansOpen);
      const showDashboard = useDashboardStore((state) => state.showDashboard);
      return (
        <>
          <button data-testid="dashboard-nav" onClick={showDashboard}>Dashboard</button>
          {plansOpen ? <PlansPane /> : <div data-testid="dashboard-view">Dashboard view</div>}
        </>
      );
    }

    await render(<NavigationHarness />);
    click('[data-testid="proposal-card"]');
    expect(container!.querySelector('[data-testid="proposal-expanded-reader"]')).not.toBeNull();

    click('[data-testid="proposal-promote"]');
    expect(container!.querySelector('[data-testid="promote-plan-panel"]')).not.toBeNull();
    expect(container!.querySelector('[aria-modal="true"]')).toBeNull();

    click('[data-testid="dashboard-nav"]');
    expect(useDashboardStore.getState().plansOpen).toBe(false);
    expect(container!.querySelector('[data-testid="dashboard-view"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="proposal-expanded-reader"]')).toBeNull();
  });

  it('threads the selected card artifact id into the promotion panel', async () => {
    await render(<PlansPane />);
    click('[data-testid="proposal-card"]');
    click('[data-testid="proposal-promote"]');

    expect(container!.querySelector('[data-testid="promote-plan-panel"]')?.getAttribute('data-proposal-artifact-id'))
      .toBe('prop_1234abcd');
    expect(container!.querySelector('[data-testid="promote-plan-panel"]')?.getAttribute('data-proposal-document-id'))
      .toBe('new');
  });

  it('opens the expanded proposal in the normal file-viewer navigation state', async () => {
    await render(<PlansPane />);
    click('[data-testid="proposal-card"]');
    click('[data-testid="proposal-open-files"]');

    const state = useDashboardStore.getState();
    expect(state.fileViewerOpen).toBe(true);
    expect(state.plansOpen).toBe(false);
    expect(state.openTabs[0]?.filePath).toBe('C:\\work\\.lares\\proposals\\2026-08-03-new.md');
  });
});
