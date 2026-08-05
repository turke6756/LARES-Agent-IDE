// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardStore } from '../../stores/dashboard-store';
import PlansPane from './PlansPane';

vi.mock('../fileviewer/MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => React.createElement('article', { 'data-testid': 'shared-markdown-reader' }, content),
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
        content: `${docId === 'new' ? '---\nauthor: Edward\n---\n' : ''}# ${docId === 'new' ? 'Newest proposal' : 'Older proposal'}\n\nDescription for ${docId}.`,
        truncated: false,
        sizeBytes: 10,
      })),
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
    expect(cards[0].querySelector('[data-testid="proposal-card-author"]')?.textContent).toContain('Edward');
    expect(cards[1].querySelector('[data-testid="proposal-card-author"]')).toBeNull();

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
