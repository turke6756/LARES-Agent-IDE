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
import type { SaveCardBundle } from '../../../shared/types';
import type { DirtyEntry, SaveCardQuotaWeakening } from '../../../shared/commit-candidates';
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

type WorkBundleDto = SaveCardBundle;

// SC-WP-2L — the inventory response is now { bundles, quotaWeakening }. This
// helper keeps the existing bundle-shaped fixtures terse while defaulting to no
// quota-weakening warning (the common case).
function inv(
  bundles: WorkBundleDto[],
  quotaWeakening: SaveCardQuotaWeakening | null = null,
): { bundles: WorkBundleDto[]; quotaWeakening: SaveCardQuotaWeakening | null } {
  return { bundles, quotaWeakening };
}

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

// SC-WP-1L.2 — a mixed-owner component: several agents' work overlaps and no
// single agent or supervisor owns it. `source: 'mixed'`, `agentId: null`, and the
// clamped 1L.1 name list survives on `identity.name`.
const mixedBundle: WorkBundleDto = {
  ...loudBundle,
  bundleId: 'b-mixed',
  label: 'app icon, Guard exit-code source fix + 38 more agents',
  labels: ['app icon, Guard exit-code source fix + 38 more agents'],
  identity: {
    groupingKey: 'mixed:c1',
    source: 'mixed',
    agentId: null,
    name: 'app icon, Guard exit-code source fix + 38 more agents',
    roleDescription: 'Overlapping work from 40 agents across 40 turns — First role memory jog',
    startedAt: Date.UTC(2026, 6, 1), endedAt: Date.UTC(2026, 6, 2),
    workerUnits: [
      { agentId: 'w-a', name: 'app icon', roleDescription: 'Built the icon.', kind: 'worker', startedAt: Date.UTC(2026, 6, 1), endedAt: Date.UTC(2026, 6, 1), turnCount: 1, memberEntryIds: ['e1'] },
      { agentId: 'w-b', name: 'Guard exit-code source fix', roleDescription: 'Fixed the guard.', kind: 'worker', startedAt: Date.UTC(2026, 6, 2), endedAt: Date.UTC(2026, 6, 2), turnCount: 1, memberEntryIds: ['e1'] },
    ],
  },
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
    getInventory.mockResolvedValue(inv([loudBundle]));
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
    getInventory.mockResolvedValue(inv([loudBundle]));
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
    getInventory.mockResolvedValue(inv([captureGapBundle]));
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
    getInventory.mockResolvedValue(inv([loudBundle, second]));
    await render();
    expect(container.querySelectorAll('[data-testid="save-bundle"]')).toHaveLength(1);
    const workers = container.querySelector('[data-testid="save-bundle-workers"]');
    expect(workers?.textContent).toContain('memory-tool-worker');
    expect(workers?.textContent).toContain('review-ui-worker');
    expect(container.querySelector('[data-testid="save-card-unsaved-count"]')?.textContent).toContain('1 package');
  });

  it('renders a mixed-owner bundle honestly — no fabricated From-agent/supervisor prefix', async () => {
    getInventory.mockResolvedValue(inv([mixedBundle]));
    await render();
    const desc = container.querySelector('[data-testid="save-bundle-desc"]');
    expect(desc).toBeTruthy();
    // Honest header, none of the fabricated ownership prefixes.
    expect(desc?.textContent).toContain('Overlapping work');
    expect(desc?.textContent).not.toContain('From agent');
    expect(desc?.textContent).not.toContain('From supervisor');
    // The card title says Overlapping work rather than parading the name list as an owner.
    expect(container.querySelector('[data-testid="save-bundle"] h2')?.textContent).toBe('Overlapping work');
    // Counts surface (2 contributing worker units, 2 witnessed turns from the component).
    expect(desc?.textContent).toContain('2 agents');
    expect(desc?.textContent).toContain('2 turns');
    // The clamped 1L.1 name list survives as secondary memory-jog detail.
    expect(desc?.textContent).toContain('app icon, Guard exit-code source fix + 38 more agents');
  });

  it('keeps distinct mixed components as separate cards (groupingKey mixed:<componentId>)', async () => {
    const mixedTwo: WorkBundleDto = {
      ...mixedBundle,
      bundleId: 'b-mixed-2',
      component: {
        ...mixedBundle.component!, componentId: 'c2', dirtyEntryIds: ['e9'],
        overlap: { ...mixedBundle.component!.overlap, componentId: 'c2' },
      },
      members: [{ entry: entry('e9', 'src/renderer/other.tsx'), protection: 'checkpoint-protected' }],
      identity: { ...mixedBundle.identity!, groupingKey: 'mixed:c2' },
    };
    getInventory.mockResolvedValue(inv([mixedBundle, mixedTwo]));
    await render();
    // Distinct mixed groupingKeys must NOT collapse into one card.
    expect(container.querySelectorAll('[data-testid="save-bundle"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="save-card-unsaved-count"]')?.textContent).toContain('2 packages');
  });

  it('renders the unattributed pseudo-bundle as a no-witness card', async () => {
    getInventory.mockResolvedValue(inv([unattributedBundle]));
    await render();
    const bundle = container.querySelector('[data-kind="unattributed"]');
    expect(bundle).toBeTruthy();
    expect(bundle?.querySelector('[data-testid="save-bundle-pill"]')?.textContent).toBe('No witness');
    expect(container.textContent).toContain('no agent was seen touching');
  });

  it('splits already-protected bundles into the quiet list', async () => {
    getInventory.mockResolvedValue(inv([loudBundle, quietBundle]));
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

  it('the read-only bundle card exposes only an inspect affordance — NO commit/save/write button', async () => {
    // SC-WP-3H: Stage ③ adds a per-package "Save…" preview launcher as a SIBLING
    // of the bundle card (see SavePreviewLauncher in SaveCard). The read-only
    // Stage ① bundle CARD itself stays inspect-only, so this invariant is now
    // scoped to the `save-bundle` card rather than the whole surface.
    getInventory.mockResolvedValue(inv([loudBundle, captureGapBundle, unattributedBundle]));
    await render();
    expect(container.querySelector('[data-testid="save-bundle-inspect"]')).toBeTruthy();
    const cards = Array.from(container.querySelectorAll('[data-testid="save-bundle"]'));
    expect(cards.length).toBeGreaterThan(0);
    const buttons = cards.flatMap((card) => Array.from(card.querySelectorAll('button')));
    for (const b of buttons) {
      const label = (b.textContent ?? '').toLowerCase();
      expect(label).not.toContain('commit');
      expect(label).not.toMatch(/\bsave\b/);
      expect(label).not.toContain('push');
    }
  });

  it('Inspect toggles bundle detail in place (read-only)', async () => {
    getInventory.mockResolvedValue(inv([loudBundle]));
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
    getInventory.mockResolvedValue(inv([]));
    await render();
    expect(container.querySelector('[data-testid="save-card-empty"]')).toBeTruthy();
    expect(container.textContent).toContain('Nothing to save');
  });
});

describe('SC-WP-2L quota-weakening banner', () => {
  const weakening: SaveCardQuotaWeakening = {
    quotaBytes: 536_870_912,
    usedBytes: 536_870_912,
    releasedEdges: [{ turnId: 't-old', edge: 'after' }],
    willWeakenPaths: ['e-weak-1', 'e-weak-2'],
  };

  it('surfaces the honest "time to save" banner when a still-dirty edge is released', async () => {
    getInventory.mockResolvedValue(inv([loudBundle], weakening));
    await render();
    const banner = container.querySelector('[data-testid="save-card-quota-weakening"]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain('time to save');
    // Renderer-safe: the warning carries entry/turn ids only — never raw paths.
    expect(banner?.textContent).not.toContain('e-weak-1');
  });

  it('shows no banner when there is no quota-weakening warning', async () => {
    getInventory.mockResolvedValue(inv([loudBundle], null));
    await render();
    expect(container.querySelector('[data-testid="save-card-quota-weakening"]')).toBeFalsy();
  });

  it('shows no banner when the warning releases no still-dirty edge', async () => {
    getInventory.mockResolvedValue(inv([loudBundle], { ...weakening, releasedEdges: [] }));
    await render();
    expect(container.querySelector('[data-testid="save-card-quota-weakening"]')).toBeFalsy();
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
