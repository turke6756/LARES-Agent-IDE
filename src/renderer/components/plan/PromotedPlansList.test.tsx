// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardStore } from '../../stores/dashboard-store';
import PromotedPlansList from './PromotedPlansList';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const workspace = { id: 'ws-1', path: 'C:\\work', pathType: 'windows', title: 'Work' } as any;
let host: HTMLDivElement;
let root: Root;
const openPlanTab = vi.fn();

beforeEach(() => {
  openPlanTab.mockClear();
  (window as any).api = { plans: { listPromotedFolders: vi.fn(async () => ({ plans: [
    { planArtifactId: 'active-art', planId: 'active-id', folderName: 'active', title: 'Active plan', status: 'ready', archived: false, updatedAt: 2, responsibleSupervisor: { display: 'Edward', agentId: 's1', source: 'manual-skill' } },
    { planArtifactId: 'old-art', planId: 'old-id', folderName: 'old', title: 'Archived plan', status: 'archived', archived: true, updatedAt: 1, responsibleSupervisor: null },
  ], warnings: [] })) } };
  useDashboardStore.setState({ workspaces: [workspace], selectedWorkspaceId: 'ws-1', openPlanTab } as any);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(): Promise<void> {
  await act(async () => { root.render(<PromotedPlansList />); await Promise.resolve(); await Promise.resolve(); });
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
});
