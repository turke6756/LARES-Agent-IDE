// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromotedPlanFolder } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import PromotedPlansList from './PromotedPlansList';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const workspace = { id: 'ws-1', path: 'C:\\work', pathType: 'windows', title: 'Work' } as any;
let host: HTMLDivElement;
let root: Root | null;
const openPlanTab = vi.fn();
let listPromotedFolders: ReturnType<typeof vi.fn>;

function plan(overrides: Partial<PromotedPlanFolder> = {}): PromotedPlanFolder {
  return {
    planArtifactId: 'active-art',
    planId: 'active-id',
    folderName: 'active',
    title: 'Active plan',
    status: 'manifest-status',
    archived: false,
    updatedAt: 2,
    responsibleSupervisor: { display: 'Edward', agentId: 's1', source: 'manual-skill' },
    lifecycle: 'ready',
    rollup: { total: 2, landed: 1, remaining: 1, archived: 0, completed: false },
    activeVerifiedTurnCount: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  openPlanTab.mockClear();
  listPromotedFolders = vi.fn(async () => ({ plans: [
    plan(),
    plan({ planArtifactId: 'old-art', planId: 'old-id', folderName: 'old', title: 'Archived plan',
      lifecycle: 'archived', status: 'archived', archived: true, updatedAt: 1, responsibleSupervisor: null }),
  ], warnings: [] }));
  (window as any).api = { plans: { listPromotedFolders } };
  useDashboardStore.setState({ workspaces: [workspace], selectedWorkspaceId: 'ws-1', openPlanTab } as any);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host.remove();
  vi.useRealTimers();
});

async function render(): Promise<void> {
  await act(async () => { root?.render(<PromotedPlansList />); await Promise.resolve(); await Promise.resolve(); });
}

describe('PromotedPlansList', () => {
  it('hides archived plans by default and reveals them through the labeled history control', async () => {
    await render();
    expect(host.textContent).toContain('Active plan');
    expect(host.textContent).not.toContain('Archived plan');
    const toggle = host.querySelector<HTMLInputElement>('[data-testid="promoted-history-toggle"] input')!;
    act(() => toggle.click());
    expect(host.textContent).toContain('Archived plan');
  });

  it('double-clicks through the existing plan-tab route', async () => {
    await render();
    const row = host.querySelector<HTMLElement>('[data-testid="promoted-plan-row"]')!;
    act(() => row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(openPlanTab).toHaveBeenCalledWith('active-id', 'Active plan', 'ws-1');
  });

  it('renders completion before lifecycle, falls back to raw status, and keeps archived separate', async () => {
    listPromotedFolders.mockResolvedValueOnce({ plans: [
      plan({ title: 'Done plan', lifecycle: 'executing',
        rollup: { total: 2, landed: 2, remaining: 0, archived: 0, completed: true } }),
      plan({ planId: 'fallback', folderName: 'fallback', title: 'Fallback plan', lifecycle: 'unknown',
        status: 'promoted-fallback', rollup: null }),
      plan({ planId: 'mixed', folderName: 'mixed', title: 'Mixed plan', lifecycle: 'ready',
        rollup: { total: 2, landed: 1, remaining: 0, archived: 1, completed: false } }),
    ], warnings: [] });
    await render();
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="promoted-plan-row"]'));
    const doneStatus = rows[0].querySelector<HTMLElement>('[data-testid="promoted-plan-status"]')!;
    expect(doneStatus.textContent).toBe('Completed');
    expect(doneStatus.dataset.lifecycle).toBe('executing');
    expect(doneStatus.dataset.completed).toBe('true');
    expect(rows[1].querySelector('[data-testid="promoted-plan-status"]')?.textContent).toBe('promoted-fallback');
    expect(rows[2].querySelector('[data-testid="promoted-plan-status"]')?.textContent).toBe('Ready');
    expect(rows[2].querySelector('[data-testid="promoted-plan-archived-count"]')?.textContent).toContain('1 archived');
  });

  it('shows the verified-active dot separately and retains the owner', async () => {
    listPromotedFolders.mockResolvedValueOnce({ plans: [
      plan({ activeVerifiedTurnCount: 1 }),
      plan({ planId: 'idle', folderName: 'idle', title: 'Idle plan', responsibleSupervisor: null }),
    ], warnings: [] });
    await render();
    const dots = host.querySelectorAll('[data-testid="promoted-plan-active"]');
    expect(dots).toHaveLength(1);
    expect(dots[0].getAttribute('aria-label')).toBe('Open verified turn stamped to this plan');
    expect(host.querySelector('[data-testid="promoted-plan-owner"]')?.textContent).toContain('Edward');
  });

  it('keeps rows visible while a background refresh is pending', async () => {
    const pending = deferred<{ plans: PromotedPlanFolder[]; warnings: string[] }>();
    listPromotedFolders.mockResolvedValueOnce({ plans: [plan()], warnings: [] }).mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(host.textContent).toContain('Active plan');
    expect(host.textContent).not.toContain('Loading promoted plans');
    pending.resolve({ plans: [plan()], warnings: [] });
    await act(async () => { await pending.promise; });
  });

  it('does not overlap background refresh requests', async () => {
    const pending = deferred<{ plans: PromotedPlanFolder[]; warnings: string[] }>();
    listPromotedFolders.mockResolvedValueOnce({ plans: [plan()], warnings: [] }).mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(listPromotedFolders).toHaveBeenCalledTimes(2);
    pending.resolve({ plans: [plan()], warnings: [] });
    await act(async () => { await pending.promise; });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(listPromotedFolders).toHaveBeenCalledTimes(3);
  });

  it('ignores a response from the previously selected workspace', async () => {
    const oldResponse = deferred<{ plans: PromotedPlanFolder[]; warnings: string[] }>();
    listPromotedFolders.mockImplementation((workspaceId: string) => workspaceId === 'ws-1'
      ? oldResponse.promise
      : Promise.resolve({ plans: [plan({ title: 'New workspace plan' })], warnings: [] }));
    await render();
    const nextWorkspace = { ...workspace, id: 'ws-2', path: 'C:\\next' };
    await act(async () => {
      useDashboardStore.setState({ workspaces: [nextWorkspace], selectedWorkspaceId: 'ws-2' } as any);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('New workspace plan');
    oldResponse.resolve({ plans: [plan({ title: 'Stale workspace plan' })], warnings: [] });
    await act(async () => { await oldResponse.promise; });
    expect(host.textContent).toContain('New workspace plan');
    expect(host.textContent).not.toContain('Stale workspace plan');
  });

  it('clears the refresh timer on unmount', async () => {
    await render();
    expect(vi.getTimerCount()).toBe(1);
    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});
