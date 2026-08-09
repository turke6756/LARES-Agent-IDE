// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { DirtyEntry } from '../../../shared/commit-candidates';
import type { SaveCardInventoryResponse, SaveIntentUnitDto } from '../../../shared/types';
import { useSaveCardStore } from '../../stores/save-card-store';
import SaveCard from './SaveCard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const dashboardState = {
  selectedWorkspaceId: 'ws-1' as string | null,
  workspaces: [{ id: 'ws-1', title: 'Workspace', path: 'C:/repo', pathType: 'windows' }],
  saveCardOpenGesture: false,
  consumeSaveCardGesture: vi.fn(),
};

vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: (selector: (state: typeof dashboardState) => unknown) => selector(dashboardState),
}));

function member(entryId: string, displayPath: string) {
  return {
    entry: {
      entryId,
      path: { displayPath, pathBytesBase64: btoa(displayPath), utf8Clean: true },
    } as DirtyEntry,
    protection: 'unprotected' as const,
  };
}

function unit(over: Partial<SaveIntentUnitDto> = {}): SaveIntentUnitDto {
  return {
    intentId: 'intent-1', kind: 'task', title: 'Implement the intent cutover', state: 'open',
    plan: { id: 'plan-1', title: 'Save Card architecture' },
    planItem: { id: 'item-1', title: 'Cut over consumers' },
    members: [member('entry-1', 'src/intent.ts')], contributors: [],
    topologyEvidence: { componentIds: ['component-1'], pathsWithMultipleTurns: [],
      captureHealth: { turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [] } },
    concurrencyCases: [], saveability: { saveable: true }, ...over,
  };
}

function inventory(over: Partial<SaveCardInventoryResponse> = {}): SaveCardInventoryResponse {
  return {
    intentUnits: [unit()], unwitnessed: [], legacyTaskIdentityUnavailable: [],
    legacyFinalizations: [], planningActivities: [], quotaWeakening: null, ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
let getInventory: ReturnType<typeof vi.fn>;

async function renderCard(value: SaveCardInventoryResponse): Promise<void> {
  getInventory.mockResolvedValue(value);
  await act(async () => {
    root.render(React.createElement(SaveCard));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  useSaveCardStore.getState().clearInventoryCache();
  getInventory = vi.fn();
  (window as unknown as { api: unknown }).api = {
    saveCard: {
      getInventory,
      markDone: vi.fn(), preview: vi.fn(), sweep: vi.fn(),
      resolveAttribution: vi.fn(), adoptAllAsBaseline: vi.fn(),
    },
    demandProbe: { record: vi.fn(async () => undefined) },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SaveCard intent-first rendering', () => {
  it('renders plan -> item -> intent hierarchy with one card per task intent', async () => {
    await renderCard(inventory({ intentUnits: [unit(), unit({ intentId: 'intent-2', title: 'Verify cutover' })] }));

    expect(container.querySelector('[data-testid="save-intent-hierarchy"]')?.textContent)
      .toContain('Save Card architecture');
    expect(container.querySelector('[data-testid="save-intent-plan-item"]')?.textContent)
      .toContain('Cut over consumers');
    expect(container.querySelectorAll('[data-testid="save-intent-unit"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="save-bundle"]')).toHaveLength(2);
  });

  it('keeps committed intents, unstamped turns, and legacy finalizations read-only', async () => {
    await renderCard(inventory({
      intentUnits: [unit({ state: 'committed' })],
      legacyTaskIdentityUnavailable: [member('legacy-entry', 'legacy.ts')],
      legacyFinalizations: [{ finalizationId: 'legacy-fin', packageId: 'legacy-package',
        packageRevision: 2, finalizationKind: 'plan-package', boundaryStatus: 'ready', finalizedAt: 1 }],
    }));

    expect(container.querySelector('[data-testid="legacy-task-identity-unavailable"]')?.textContent)
      .toContain('1 witnessed file');
    expect(container.querySelector('[data-testid="legacy-package-finalizations"]')?.textContent)
      .toContain('Read-only legacy history');
    expect(container.querySelector('[data-testid="save-bundle-pin"]')).toBeNull();
    expect(container.querySelector('[data-testid="save-bundle-submit"]')).toBeNull();
  });

  it('keeps human edits unwitnessed and offers the single baseline-adoption gesture', async () => {
    await renderCard(inventory({ intentUnits: [], unwitnessed: [member('human', 'human.txt')] }));

    const pool = container.querySelector('[data-testid="unwitnessed-pool"]');
    expect(pool?.textContent).toContain('1 file');
    expect(pool?.querySelector('button')?.textContent).toContain('Adopt all as baseline');
    expect(container.querySelectorAll('[data-testid="save-intent-unit"]')).toHaveLength(0);
  });
});
