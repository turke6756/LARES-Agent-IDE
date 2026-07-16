// @vitest-environment jsdom
//
// The Plans gallery: a card view (not a flat list) of a workspace's plan
// SURFACES only (`format:'html'`) — markdown-adopted rows are excluded — where
// clicking a card opens the plan tab.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlansMenu from './PlansMenu';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { PlanListItem } from '../../../shared/types';
import { suspendBrowserPane, resumeBrowserPane } from '../browser/useBrowserSuspension';

// The gallery hides both native panes while open; mock the browser-suspension
// module so we can assert the suspend/resume calls without a real IPC bridge.
vi.mock('../browser/useBrowserSuspension', () => ({
  suspendBrowserPane: vi.fn(),
  resumeBrowserPane: vi.fn(),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let listMock: ReturnType<typeof vi.fn>;
let paneSetVisible: ReturnType<typeof vi.fn>;
let openPlanTab: ReturnType<typeof vi.fn>;

const plan = (over: Partial<PlanListItem>): PlanListItem => ({
  id: 'p-html', workspaceId: 'ws-1', path: 'plans/auth.html', slug: 'auth', format: 'html',
  runState: null, mtimeMs: 0, sizeBytes: 0, createdAt: '2026-07-05 00:00:00',
  updatedAt: '2026-07-05 00:00:00', deletedAt: null, snippet: 'Wire up auth.', ...over,
});

beforeEach(() => {
  openPlanTab = vi.fn();
  useDashboardStore.setState({ selectedWorkspaceId: 'ws-1', openPlanTab });
  listMock = vi.fn(async () => [
    plan({ id: 'p-html', slug: 'auth', format: 'html', snippet: 'Wire up auth.' }),
    plan({ id: 'p-html2', slug: 'billing', path: 'plans/billing.html', format: 'html', snippet: null }),
    plan({ id: 'p-md', slug: 'legacy', path: 'plans/legacy.md', format: 'md', snippet: null }),
  ]);
  paneSetVisible = vi.fn();
  (window as unknown as { api: unknown }).api = { plans: { list: listMock, paneSetVisible } };
});

async function render(el: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(el); });
  return container;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function openGallery(c: HTMLDivElement): Promise<void> {
  const toggle = c.querySelector('button') as HTMLButtonElement;
  await act(async () => { toggle.click(); });
  await act(async () => { await Promise.resolve(); });
}

// The gallery renders through a portal into document.body (A6), so gallery /
// card lookups query the document, not the button's container.
const gallery = () => document.querySelector('[data-testid="plans-gallery"]');
const cards = () => document.querySelectorAll('[data-testid="plan-card"]');

describe('PlansMenu gallery', () => {
  it('renders only html plan surfaces as cards, excluding markdown rows', async () => {
    const c = await render(<PlansMenu compact={false} />);
    await openGallery(c);
    expect(cards().length).toBe(2); // auth + billing; legacy.md filtered out
    const text = gallery()!.textContent!;
    expect(text).toContain('auth');
    expect(text).toContain('billing');
    expect(text).not.toContain('legacy');
  });

  it('shows the snippet, or a placeholder when none', async () => {
    const c = await render(<PlansMenu compact={false} />);
    await openGallery(c);
    expect(gallery()!.textContent).toContain('Wire up auth.');
    expect(gallery()!.textContent).toMatch(/No description yet/);
  });

  it('opens the plan tab when a card is clicked', async () => {
    const c = await render(<PlansMenu compact={false} />);
    await openGallery(c);
    const firstCard = cards()[0] as HTMLButtonElement;
    await act(async () => { firstCard.click(); });
    expect(openPlanTab).toHaveBeenCalledWith('p-html', 'auth', 'ws-1');
  });

  it('shows an empty-state when there are no surfaces', async () => {
    listMock.mockResolvedValueOnce([plan({ id: 'p-md', format: 'md', path: 'plans/x.md' })]);
    const c = await render(<PlansMenu compact={false} />);
    await openGallery(c);
    expect(gallery()!.textContent).toMatch(/No plan surfaces/);
  });

  it('hides both native panes when the gallery opens (ISSUE #2)', async () => {
    const c = await render(<PlansMenu compact={false} />);
    await openGallery(c);
    expect(paneSetVisible).toHaveBeenCalledWith(false);
    expect(suspendBrowserPane).toHaveBeenCalledTimes(1);
  });

  it('restores both native panes when the gallery closes (Escape)', async () => {
    const c = await render(<PlansMenu compact={false} />);
    await openGallery(c);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(paneSetVisible).toHaveBeenCalledWith(true);
    expect(resumeBrowserPane).toHaveBeenCalledTimes(1);
  });

  it('renders in a fixed-position portal and stays open on inside click (A6)', async () => {
    const c = await render(<PlansMenu compact={false} />);
    await openGallery(c);
    const g = gallery() as HTMLElement;
    expect(g).not.toBeNull();
    // Fixed placement (A6): `fixed` class + inline rect anchored to the button.
    expect(g.className).toContain('fixed');
    expect(g.style.top).not.toBe('');
    // A click INSIDE the portaled gallery must NOT dismiss it (guards A6 step 5).
    await act(async () => {
      g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(gallery()).not.toBeNull();
  });
});
