// @vitest-environment jsdom
/**
 * SC-WP-1I — read-only Save-card surface render contract.
 *
 * The store hook and window.api.saveCard bridge are mocked; the component
 * renders against real DOM in jsdom. Covers:
 *   - bundles render (loud unsaved section + quiet already-protected list,
 *     memory-jog description, capture-health flag, protection rung);
 *   - the honest unavailable/error state when getInventory rejects (engine
 *     unavailable / non-repo / unborn / read error);
 *   - the honest empty state when the tree is clean;
 *   - NO commit/write affordance renders anywhere (inspect-only);
 *   - NO tear-off: 'save' is not a DetachableView.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SaveCardInventoryResponse } from '../../../shared/types';
import type { DirtyEntry } from '../../../shared/commit-candidates';
import SaveCard from './SaveCard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ── store mock: SaveCard reads selectedWorkspaceId + workspaces ──────────────
const storeState = {
  selectedWorkspaceId: 'ws-1' as string | null,
  workspaces: [{ id: 'ws-1', title: 'AgentDashboard', path: '/ws', pathType: 'windows' }],
};
vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}));

// ── DTO fixture builders (SC-WP-1H renderer-safe WorkBundle shape) ───────────
function entry(id: string, displayPath: string, over: Partial<DirtyEntry> = {}): DirtyEntry {
  return {
    entryId: id,
    path: { pathBytesBase64: '', displayPath, utf8Clean: true },
    originalPath: null,
    entryKind: 'ordinary',
    indexStatus: '.',
    worktreeStatus: 'M',
    headMode: '100644',
    indexMode: '100644',
    worktreeMode: '100644',
    submoduleState: null,
    renameOrCopyScore: null,
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid: null,
    gitLevelEligibility: 'supported',
    commitPathspecs: [],
    ...over,
  };
}

type WorkBundleDto = SaveCardInventoryResponse[number];

const loudBundle: WorkBundleDto = {
  bundleId: 'b-loud',
  kind: 'component',
  label: 'Memory Architecture',
  labels: ['Memory Architecture'],
  repositoryKey: 'repo-1',
  workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  component: {
    componentId: 'c1',
    dirtyEntryIds: ['e1'],
    associations: [{ planId: null, planItemId: null, contributingTurnIds: ['t1', 't2'], memberEntryIds: ['e1'] }],
    overlap: { componentId: 'c1', contributingAgentCount: 1, mergedGroupCount: 1, perPathContributors: {}, requiresOverlapAck: false },
    componentTopologyDigest: 'dig',
  },
  members: [{ entry: entry('e1', 'src/main/memory/recall.ts'), protection: 'checkpoint-protected' }],
  captureHealth: { turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [] },
  weakestProtection: 'checkpoint-protected',
  identity: {
    groupingKey: 'supervisor:sup-1', source: 'supervisor', agentId: 'sup-1',
    name: 'Memory Architecture', roleDescription: 'Coordinated the workspace memory rebuild.',
    startedAt: Date.UTC(2026, 6, 28), endedAt: Date.UTC(2026, 6, 29),
    workerUnits: [{
      agentId: 'worker-1', name: 'memory-tool-worker', roleDescription: 'Built the recall tool.',
      kind: 'worker', startedAt: Date.UTC(2026, 6, 28), endedAt: Date.UTC(2026, 6, 29),
      turnCount: 2, memberEntryIds: ['e1'],
    }],
  },
};

const captureGapBundle: WorkBundleDto = {
  ...loudBundle,
  bundleId: 'b-gap',
  label: 'Codex worker auth',
  labels: ['Codex worker auth'],
  members: [{ entry: entry('e2', 'src/main/codex/scaffold.ts'), protection: 'unprotected' }],
  captureHealth: { turns: [], captureOutage: true, pathsWithoutFinalizationEdge: [] },
  weakestProtection: 'unprotected',
};

const unattributedBundle: WorkBundleDto = {
  bundleId: 'b-unattr',
  kind: 'unattributed',
  label: 'Unattributed changes',
  labels: ['Unattributed changes'],
  repositoryKey: 'repo-1',
  workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  component: null,
  members: [{ entry: entry('e3', 'package-lock.json'), protection: 'unprotected' }],
  captureHealth: { turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [] },
  weakestProtection: 'unprotected',
  identity: null,
};

const quietBundle: WorkBundleDto = {
  ...loudBundle,
  bundleId: 'b-quiet',
  label: 'Memory migration artifacts',
  labels: ['Memory migration artifacts'],
  members: [{ entry: entry('e4', 'src/main/db/migrate.ts'), protection: 'locally-committed' }],
  captureHealth: { turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [] },
  weakestProtection: 'locally-committed',
};

// ── render harness ───────────────────────────────────────────────────────────
let container: HTMLDivElement;
let root: Root;
let getInventory: ReturnType<typeof vi.fn>;

async function render() {
  await act(async () => {
    root.render(React.createElement(SaveCard));
  });
  // Flush the async load microtask chain.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  storeState.selectedWorkspaceId = 'ws-1';
  getInventory = vi.fn();
  (window as unknown as { api: unknown }).api = { saveCard: { getInventory } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SaveCard bundle rendering', () => {
  it('explains the save-protection ladder and dismisses it by keyboard or click-away', async () => {
    getInventory.mockResolvedValue([loudBundle]);
    await render();

    const button = document.querySelector<HTMLButtonElement>('[aria-label="How save protection works"]')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');

    await act(async () => button.click());
    const popover = document.querySelector('[aria-label="Save protection ladder"]');
    expect(popover?.textContent).toContain('Your live files. They can change at any time.');
    expect(popover?.textContent).toContain('Recoverable, but it can expire or be pruned.');
    expect(popover?.textContent).toContain('permanent save on this machine');
    expect(popover?.textContent).toContain('copy off this machine');

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('[aria-label="Save protection ladder"]')).toBeNull();
    expect(document.activeElement).toBe(button);

    await act(async () => button.click());
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(document.querySelector('[aria-label="Save protection ladder"]')).toBeNull();
  });

  it('renders loud unsaved bundles with memory-jog description and protection rung', async () => {
    getInventory.mockResolvedValue([loudBundle]);
    await render();
    expect(container.querySelector('[data-testid="save-card"]')).toBeTruthy();
    const bundle = container.querySelector('[data-testid="save-bundle"]');
    expect(bundle).toBeTruthy();
    expect(container.textContent).toContain('Memory Architecture');
    expect(container.querySelector('[data-testid="save-bundle-desc"]')?.textContent).toContain('workspace memory rebuild');
    expect(container.querySelector('[data-testid="save-bundle-dates"]')?.textContent).toContain('witnessed turns');
    expect(container.querySelector('[data-testid="save-bundle-workers"]')?.textContent).toContain('memory-tool-worker');
    expect(container.querySelector('[data-testid="save-bundle-protection"]')?.textContent).toContain('Checkpoint only');
    expect(container.querySelector('[data-testid="save-bundle-paths"]')?.textContent).toContain('src/main/memory/recall.ts');
  });

  it('flags a capture gap honestly', async () => {
    getInventory.mockResolvedValue([captureGapBundle]);
    await render();
    const flag = container.querySelector('[data-testid="save-bundle-capture"]');
    expect(flag).toBeTruthy();
    expect(flag?.textContent).toContain('Capture outage');
  });

  it('groups component bundles from one supervisor and keeps worker sub-units inside', async () => {
    const second: WorkBundleDto = {
      ...loudBundle,
      bundleId: 'b-second',
      component: {
        ...loudBundle.component!, componentId: 'c2', dirtyEntryIds: ['e5'],
        overlap: { ...loudBundle.component!.overlap, componentId: 'c2' },
      },
      members: [{ entry: entry('e5', 'src/renderer/memory/ReviewPane.tsx'), protection: 'checkpoint-protected' }],
      identity: {
        ...loudBundle.identity!,
        workerUnits: [{
          agentId: 'worker-2', name: 'review-ui-worker', roleDescription: 'Built the review UI.',
          kind: 'worker', startedAt: Date.UTC(2026, 6, 29), endedAt: Date.UTC(2026, 6, 29),
          turnCount: 1, memberEntryIds: ['e5'],
        }],
      },
    };
    getInventory.mockResolvedValue([loudBundle, second]);
    await render();
    expect(container.querySelectorAll('[data-testid="save-bundle"]')).toHaveLength(1);
    const workers = container.querySelector('[data-testid="save-bundle-workers"]');
    expect(workers?.textContent).toContain('memory-tool-worker');
    expect(workers?.textContent).toContain('review-ui-worker');
    expect(container.querySelector('[data-testid="save-card-unsaved-count"]')?.textContent).toContain('1 package');
  });

  it('renders the unattributed pseudo-bundle as a no-witness card', async () => {
    getInventory.mockResolvedValue([unattributedBundle]);
    await render();
    const bundle = container.querySelector('[data-kind="unattributed"]');
    expect(bundle).toBeTruthy();
    expect(bundle?.querySelector('[data-testid="save-bundle-pill"]')?.textContent).toBe('No witness');
    expect(container.textContent).toContain('no agent was seen touching');
  });

  it('splits already-protected bundles into the quiet list', async () => {
    getInventory.mockResolvedValue([loudBundle, quietBundle]);
    await render();
    // loud section has exactly the checkpoint-only bundle; quiet has the committed one.
    const cards = container.querySelectorAll('[data-testid="save-bundle"]');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-bundle-id')).toBe('b-loud');
    const quiet = container.querySelector('[data-testid="save-card-quiet"]');
    expect(quiet).toBeTruthy();
    expect(quiet?.textContent).toContain('Memory migration artifacts');
    expect(quiet?.textContent).toContain('committed');
  });

  it('exposes only an inspect affordance — NO commit/save/write button', async () => {
    getInventory.mockResolvedValue([loudBundle, captureGapBundle, unattributedBundle]);
    await render();
    expect(container.querySelector('[data-testid="save-bundle-inspect"]')).toBeTruthy();
    const buttons = Array.from(container.querySelectorAll('button'));
    for (const b of buttons) {
      const label = (b.textContent ?? '').toLowerCase();
      expect(label).not.toContain('commit');
      expect(label).not.toMatch(/\bsave\b/);
      expect(label).not.toContain('push');
    }
  });

  it('Inspect toggles bundle detail in place (read-only)', async () => {
    getInventory.mockResolvedValue([loudBundle]);
    await render();
    expect(container.querySelector('[data-testid="save-bundle-detail"]')).toBeFalsy();
    const inspect = container.querySelector('[data-testid="save-bundle-inspect"]') as HTMLButtonElement;
    await act(async () => { inspect.click(); });
    expect(container.querySelector('[data-testid="save-bundle-detail"]')).toBeTruthy();
  });
});

describe('SaveCard honest non-populated states', () => {
  it('renders the unavailable/error state when getInventory rejects', async () => {
    getInventory.mockRejectedValue(new Error('Save-card engine unavailable (the engine has not finished bootstrapping)'));
    await render();
    const err = container.querySelector('[data-testid="save-card-error"]');
    expect(err).toBeTruthy();
    expect(err?.textContent).toContain('engine unavailable');
    // No bundles, and reveals-only messaging present.
    expect(container.querySelector('[data-testid="save-bundle"]')).toBeFalsy();
    expect(err?.textContent).toContain('nothing was written');
  });

  it('renders the empty state when the tree is clean', async () => {
    getInventory.mockResolvedValue([]);
    await render();
    expect(container.querySelector('[data-testid="save-card-empty"]')).toBeTruthy();
    expect(container.textContent).toContain('Nothing to save');
  });
});

describe('SC-WP-1I non-goals', () => {
  it('does NOT register a Save tear-off — save is absent from DetachableView', () => {
    const typesPath = path.resolve(__dirname, '../../../shared/types.ts');
    const src = readFileSync(typesPath, 'utf8');
    const m = src.match(/export type DetachableView =\s*([^;]+);/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toContain("'save'");
  });
});
