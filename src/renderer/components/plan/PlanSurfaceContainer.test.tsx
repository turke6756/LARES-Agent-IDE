// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlanSurfaceContainer from './PlanSurfaceContainer';
import { useDashboardStore } from '../../stores/dashboard-store';

let container: HTMLDivElement;
let root: Root;
let documents: ReturnType<typeof vi.fn>;
let getReviewProjection: ReturnType<typeof vi.fn>;

beforeEach(() => {
  documents = vi.fn(async () => ({
    planId: 'plan-1', warnings: [], tabs: [{ key: 'overview', populated: false, documents: [] }],
  }));
  getReviewProjection = vi.fn(async () => Promise.reject(
    new Error('no work packages implemented yet — pull Implement to begin'),
  ));
  (window as unknown as { api: unknown }).api = {
    plans: {
      documents,
      readDocument: vi.fn(),
      getOverview: vi.fn(async () => null),
      getReviewProjection,
      boardList: vi.fn(async () => []),
      boardTimeline: vi.fn(async () => []),
      previewCandidate: vi.fn(async () => ({ candidate: { members: [] }, selection: null })),
    },
  };
  useDashboardStore.setState({ selectedWorkspaceId: null, openTabs: [], activeTabId: null });
});

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<PlanSurfaceContainer planId="plan-1" />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  delete (window as unknown as { api?: unknown }).api;
});

describe('PlanSurfaceContainer after legacy-surface retirement', () => {
  it('mounts the folder-native document surface and review rail without legacy pane/projection APIs', async () => {
    await render();
    expect(documents).toHaveBeenCalledWith('plan-1');
    expect(container.querySelector('[data-testid="plan-document-tabs"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plan-surface"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plan-doc-host"]')).toBeNull();
    expect(container.textContent).toContain('Work packages');
  });

  it('keeps the full-height sibling-panel layout', async () => {
    await render();
    const surface = container.querySelector('[data-testid="plan-surface-container"]') as HTMLElement;
    expect(surface.classList.contains('h-full')).toBe(true);
    expect(surface.classList.contains('flex-1')).toBe(false);
  });

  it('does not request change evidence until its collapsed disclosure is opened', async () => {
    useDashboardStore.setState({
      selectedWorkspaceId: 'ws-1',
      workspaces: [{
        id: 'ws-1', title: 'Workspace', path: 'C:\\work', pathType: 'windows', description: '',
        defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null,
      }],
      openTabs: [{
        id: 'plan-tab', kind: 'plan', planId: 'plan-1', label: 'Plan', filePath: '',
        rootDirectory: 'C:\\work', pathType: 'windows', workspaceId: 'ws-1',
      }],
      activeTabId: 'plan-tab',
    });
    await render();
    const evidence = container.querySelector('[data-testid="plan-review-evidence"]') as HTMLDetailsElement;
    expect(evidence.open).toBe(false);
    expect(getReviewProjection).not.toHaveBeenCalled();
    await act(async () => {
      evidence.open = true;
      evidence.dispatchEvent(new Event('toggle'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getReviewProjection).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="plan-review-unavailable"]')?.textContent)
      .toContain('no work packages implemented yet — pull Implement to begin');
  });
});
