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
import type { SaveCardBundle, SaveCardPreviewResponse } from '../../../shared/types';
import type { CommitCandidate, DirtyEntry, SaveCardQuotaWeakening } from '../../../shared/commit-candidates';
import SaveCard from './SaveCard';
import { useSaveCardStore } from '../../stores/save-card-store';

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

const unpinnedBundle: WorkBundleDto = {
  ...unattributedBundle,
  bundleId: 'b-unpinned',
  members: Array.from({ length: 15 }, (_, index) => ({
    entry: entry(`untracked-${index}`, `.lares/proposals/file-${index}.md`),
    protection: 'unprotected' as const,
  })),
  captureHealth: {
    turns: [], captureOutage: false,
    pathsWithoutFinalizationEdge: Array.from({ length: 15 }, (_, index) => `path-${index}`),
  },
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
let markDone: ReturnType<typeof vi.fn>;
let preview: ReturnType<typeof vi.fn>;
let sweep: ReturnType<typeof vi.fn>;

async function render() {
  await act(async () => {
    root.render(React.createElement(SaveCard));
  });
  // Flush the async load microtask chain.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  useSaveCardStore.getState().clearInventoryCache();
  storeState.selectedWorkspaceId = 'ws-1';
  getInventory = vi.fn();
  markDone = vi.fn();
  preview = vi.fn();
  sweep = vi.fn();
  (window as unknown as { api: unknown }).api = {
    saveCard: { getInventory, markDone, preview, sweep },
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

  it('shows an unpinned package neutrally without a capture warning', async () => {
    getInventory.mockResolvedValue(inv([unpinnedBundle]));
    await render();
    expect(container.querySelector('[data-testid="save-bundle-capture"]')).toBeNull();
    const affordance = container.querySelector('[data-testid="save-bundle-unpinned"]');
    expect(affordance?.textContent).toContain('Not yet pinned');
    expect(affordance?.textContent).toContain('No live pinned finalization covers these exact bytes.');
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
    expect(err?.textContent).toContain('Nothing was written');
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

function readyMarkDone() {
  return {
    finalizationId: 'fin-1', packageId: 'b-loud', finalizationKind: 'fleet-adhoc' as const,
    outcome: 'created' as const, boundaryRef: 'refs/lares/finalizations/fin-1',
    boundaryStatus: 'ready' as const, packageRevision: 1,
    pinnedSelection: {
      selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], frozenMemberCount: 1,
    },
    refusal: null,
  };
}

function readyCandidatePreview(): SaveCardPreviewResponse {
  const candidate: CommitCandidate = {
    candidateId: 'candidate-1', contractVersion: 1,
    repository: {
      repositoryKey: 'repo-1', objectDatabaseKey: 'odb-1', gitObjectFormat: 'sha1',
      bareRepo: false, workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
    },
    componentIds: ['c1'], selectedUnattributedEntryIds: [],
    members: [{
      entryId: 'e1',
      path: { pathBytesBase64: 'c3JjL21haW4vbWVtb3J5L3JlY2FsbC50cw==', displayPath: 'src/main/memory/recall.ts', utf8Clean: true },
      expectedWorktreeState: 'present', rawWorktreeBlobOid: 'raw-1', expectedCommitBlobOid: 'blob-1',
      expectedCommitMode: '100644', checkpointMode: '100644', coveringFinalizationIds: ['fin-1'],
      packageVerification: 'verified-match', protection: 'checkpoint-protected',
    }],
    finalizations: [{ finalizationId: 'fin-1', packageId: 'b-loud', packageRevision: 1, boundaryStatus: 'ready' }],
    eligibility: { eligible: true },
    token: null,
  };
  return {
    candidate, isCandidate: true, laresTrailers: ['Lares-Turns: 2'],
    defaultMessageBody: 'Save Memory Architecture', requiresOverlapAck: false,
    unacknowledgedUnattributedEntryIds: [], componentTopologyDigest: 'topo-1',
    selectionDrift: { added: [], missing: [], reAttributed: [], byteMoved: [] },
    selectionDriftDisplayPaths: {},
    pinnedSelection: {
      selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], frozenMemberCount: 1,
    },
    reviewedManifest: {
      manifestVersion: 1, reviewedManifestDigest: 'review-1', members: [],
      challengeVersion: 1, challengeAtoms: [],
    },
    durableFinalizationIntent: [{
      finalizationId: 'fin-1', packageId: 'b-loud', packageRevision: 1,
      boundaryStatus: 'ready', frozenMemberManifestDigest: 'frozen-1',
    }],
    refusal: null,
  };
}

async function gestureClick(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SaveCard decisive save gesture', () => {
  beforeEach(() => {
    getInventory.mockResolvedValue(inv([loudBundle]));
    markDone.mockResolvedValue(readyMarkDone());
    preview.mockResolvedValue(readyCandidatePreview());
    sweep.mockResolvedValue({
      halted: false, haltKind: null,
      results: [{
        kind: 'saved', repositoryKey: 'repo-1', finalizationId: 'fin-1',
        packageId: 'b-loud', packageRevision: 1, commitOid: 'saved-oid', attemptId: 'attempt-1',
      }],
    });
  });

  it('round-trips the package checkbox through markDone and leaves the ready pin checked', async () => {
    await render();
    const pin = container.querySelector('[data-testid="save-bundle-pin"]') as HTMLInputElement;
    expect(pin.checked).toBe(false);
    await gestureClick(pin);
    // SC-WP-W5: the mark-done carries the PANE's workspaceId so the finalize routes
    // by the repository the pane is scoped to, never by a contributor's home.
    expect(markDone).toHaveBeenCalledWith({ packageId: 'b-loud', targetWorkspaceId: 'ws-1' });
    expect(pin.checked).toBe(true);
  });

  it('preserves successful grouped pins, names the failed package, and retries only the missing package', async () => {
    const second = {
      ...loudBundle,
      bundleId: 'b-second',
      label: 'Second package', labels: ['Second package'],
      component: {
        ...loudBundle.component!, componentId: 'c2', dirtyEntryIds: ['e2'],
      },
      members: [{ entry: entry('e2', 'src/second.ts'), protection: 'checkpoint-protected' as const }],
    };
    getInventory.mockResolvedValue(inv([loudBundle, second]));
    let secondAttempts = 0;
    markDone.mockImplementation(async ({ packageId }: { packageId: string }) => {
      if (packageId === 'b-second' && secondAttempts++ === 0) throw new Error('pin unavailable');
      return {
        ...readyMarkDone(), packageId, finalizationId: `fin-${packageId}`,
        pinnedSelection: {
          selectedComponentIds: [packageId === 'b-loud' ? 'c1' : 'c2'],
          selectedUnattributedEntryIds: [], frozenMemberCount: 1,
        },
      };
    });
    await render();
    const pin = container.querySelector('[data-testid="save-bundle-pin"]')!;
    await gestureClick(pin);
    expect(container.querySelector('[data-testid="save-gesture-refusal"]')?.textContent).toContain('b-second');
    expect(markDone.mock.calls.map(([request]) => request.packageId)).toEqual(['b-loud', 'b-second']);

    await gestureClick(pin);
    expect(markDone.mock.calls.map(([request]) => request.packageId)).toEqual(['b-loud', 'b-second', 'b-second']);
    expect((pin as HTMLInputElement).checked).toBe(true);
  });

  it('disables an unsaveable package inline and never calls markDone', async () => {
    getInventory.mockResolvedValue(inv([{
      ...loudBundle,
      saveability: {
        saveable: false,
        reason: 'no-repository',
        workspaceId: '54ad9887',
        workspaceTitle: 'Computer Root',
      },
    }]));
    await render();

    const pin = container.querySelector('[data-testid="save-bundle-pin"]') as HTMLInputElement;
    expect(pin.disabled).toBe(true);
    expect(container.querySelector('[data-testid="save-bundle-unsaveable"]')?.textContent)
      .toContain("No git repository — cannot pin/commit from workspace 'Computer Root'");
    await gestureClick(pin);
    expect(markDone).not.toHaveBeenCalled();
  });

  it('keeps the safe-refusal banner for a typed refusal that reaches the renderer', async () => {
    markDone.mockResolvedValue({
      ok: false,
      code: 'save-card-no-repository',
      message: "No git repository — cannot pin/commit from workspace 'Computer Root'.",
      workspaceId: '54ad9887',
      workspaceTitle: 'Computer Root',
    });
    await render();
    await gestureClick(container.querySelector('[data-testid="save-bundle-pin"]')!);

    expect(container.querySelector('[data-testid="save-gesture-refusal"]')?.textContent)
      .toContain('Lares could not gather the current work for b-loud.');
    expect(container.querySelectorAll('[data-testid="save-gesture-refusal"] button')).toHaveLength(1);
  });

  it('submits durable review evidence to the sweep and renders its saved terminal result', async () => {
    await render();
    expect(container.querySelector('[data-testid="candidate-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="save-bundle-details-toggle"]')?.getAttribute('aria-expanded')).toBe('false');
    await gestureClick(container.querySelector('[data-testid="save-bundle-pin"]')!);
    await gestureClick(container.querySelector('[data-testid="save-bundle-submit"]')!);

    expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1', selectedComponentIds: ['c1'], finalizationIds: ['fin-1'],
    }));
    expect(sweep).toHaveBeenCalledWith({
      intents: [{
        repositoryKey: 'repo-1', finalizationId: 'fin-1', packageId: 'b-loud', packageRevision: 1,
        frozenMemberManifestDigest: 'frozen-1', reviewedManifestDigest: 'review-1',
        message: 'Save Memory Architecture',
      }],
      reviewedManifestDigests: ['review-1'], acknowledgedChallengeAtoms: [],
    });
    const terminal = container.querySelector('[data-testid="save-sweep-terminal-result"]');
    expect(terminal?.getAttribute('data-kind')).toBe('saved');
    expect(terminal?.textContent).toContain('saved-oid');
    expect(container.querySelector('[data-testid="candidate-preview"]')).toBeNull();
  });

  it('pins three overlapping components, checks once, submits once, and renders Saved', async () => {
    const bundles = ['c1', 'c2', 'c3'].map((componentId, index) => ({
      ...loudBundle,
      bundleId: `b-${index + 1}`,
      label: `Overlap ${index + 1}`,
      labels: [`Overlap ${index + 1}`],
      component: {
        ...loudBundle.component!, componentId, dirtyEntryIds: [`e${index + 1}`],
        overlap: { ...loudBundle.component!.overlap, componentId, requiresOverlapAck: true },
      },
      members: [{
        entry: entry(`e${index + 1}`, `src/overlap-${index + 1}.ts`),
        protection: 'checkpoint-protected' as const,
      }],
    }));
    getInventory.mockResolvedValue(inv(bundles));
    markDone.mockImplementation(async ({ packageId }: { packageId: string }) => {
      const index = Number(packageId.slice(2));
      return {
        ...readyMarkDone(), packageId, finalizationId: `fin-${index}`,
        pinnedSelection: {
          selectedComponentIds: [`c${index}`], selectedUnattributedEntryIds: [], frozenMemberCount: 1,
        },
      };
    });
    const overlapPreview = {
      ...readyCandidatePreview(),
      requiresOverlapAck: true,
      componentTopologyDigest: 'three-component-digest',
      reviewedManifest: {
        ...readyCandidatePreview().reviewedManifest!,
        challengeAtoms: [{
          kind: 'overlap' as const, atomId: 'overlap-1', digest: 'overlap-digest', reasonVersion: 1 as const,
          memberPathBytesBase64: ['c3JjL21haW4vbWVtb3J5L3JlY2FsbC50cw=='],
          contributors: [], ownershipGroupKeys: ['owner-1'],
        }],
      },
      durableFinalizationIntent: [1, 2, 3].map((index) => ({
        finalizationId: `fin-${index}`, packageId: `b-${index}`, packageRevision: 1,
        boundaryStatus: 'ready' as const, frozenMemberManifestDigest: `frozen-${index}`,
      })),
      candidate: {
        ...readyCandidatePreview().candidate,
        componentIds: ['c1', 'c2', 'c3'],
        finalizations: [1, 2, 3].map((index) => ({
          finalizationId: `fin-${index}`, packageId: `b-${index}`, packageRevision: 1, boundaryStatus: 'ready' as const,
        })),
      } as CommitCandidate,
      pinnedSelection: {
        selectedComponentIds: ['c1', 'c2', 'c3'], selectedUnattributedEntryIds: [], frozenMemberCount: 3,
      },
    };
    preview.mockResolvedValue(overlapPreview);
    sweep.mockResolvedValue({
      halted: false, haltKind: null,
      results: [1, 2, 3].map((index) => ({
        kind: 'saved' as const, repositoryKey: 'repo-1', finalizationId: `fin-${index}`,
        packageId: `b-${index}`, packageRevision: 1, attemptId: `a-${index}`, commitOid: `c-${index}`,
      })),
    });

    await render();
    await gestureClick(container.querySelector('[data-testid="save-bundle-pin"]')!);
    await gestureClick(container.querySelector('[data-testid="save-bundle-details-toggle"]')!);
    const acknowledgement = container.querySelector<HTMLInputElement>('[data-testid="candidate-preview-overlap-ack"] input')!;
    await gestureClick(acknowledgement);
    await gestureClick(container.querySelector('[data-testid="save-bundle-submit"]')!);

    expect(preview).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep.mock.calls[0][0].intents).toHaveLength(3);
    expect(sweep.mock.calls[0][0].acknowledgedChallengeAtoms).toEqual([
      expect.objectContaining({ atomId: 'overlap-1', digest: 'overlap-digest' }),
    ]);
    expect(container.querySelectorAll('[data-testid="save-sweep-terminal-result"]')).toHaveLength(3);
  });

  it('renders a needs-attention carry verdict without reclassifying it locally', async () => {
    sweep.mockResolvedValue({
      halted: false, haltKind: null,
      results: [{
        kind: 'needs-attention', repositoryKey: 'repo-1', finalizationId: 'fin-1',
        packageId: 'b-loud', packageRevision: 1, code: 'reviewed-effect-changed',
        message: 'Server says this reviewed effect changed.',
      }],
    });
    await render();
    await gestureClick(container.querySelector('[data-testid="save-bundle-pin"]')!);
    await gestureClick(container.querySelector('[data-testid="save-bundle-submit"]')!);
    const terminal = container.querySelector('[data-testid="save-sweep-terminal-result"]');
    expect(terminal?.getAttribute('data-kind')).toBe('needs-attention');
    expect(terminal?.textContent).toContain('Server says this reviewed effect changed.');
    expect(terminal?.textContent).toContain('reviewed-effect-changed');
  });

  it('propagates a checkbox change into an immediately adjacent outer submit', async () => {
    const overlap = {
      ...readyCandidatePreview(), requiresOverlapAck: true,
      reviewedManifest: {
        ...readyCandidatePreview().reviewedManifest!,
        challengeAtoms: [{
          kind: 'overlap' as const, atomId: 'overlap-adjacent', digest: 'digest-adjacent', reasonVersion: 1 as const,
          memberPathBytesBase64: ['c3JjL21haW4vbWVtb3J5L3JlY2FsbC50cw=='], contributors: [], ownershipGroupKeys: [],
        }],
      },
    };
    preview.mockResolvedValue(overlap);
    await render();
    await gestureClick(container.querySelector('[data-testid="save-bundle-pin"]')!);
    await gestureClick(container.querySelector('[data-testid="save-bundle-details-toggle"]')!);
    const acknowledgement = container.querySelector<HTMLInputElement>('[data-testid="candidate-preview-overlap-ack"] input')!;
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="save-bundle-submit"]')!;
    await act(async () => {
      acknowledgement.click();
      submit.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sweep).toHaveBeenCalledWith(expect.objectContaining({
      acknowledgedChallengeAtoms: [expect.objectContaining({ atomId: 'overlap-adjacent', digest: 'digest-adjacent' })],
    }));
  });

  it('renders halted-uncertain evidence and offers no retry', async () => {
    sweep.mockResolvedValue({
      halted: true, haltKind: 'uncertain',
      results: [{
        kind: 'halted-uncertain', repositoryKey: 'repo-1', finalizationId: 'fin-1',
        packageId: 'b-loud', packageRevision: 1, code: 'reconciliation-lost',
        message: 'Reconciliation could not be verified.', attemptId: 'attempt-uncertain', commitOid: 'maybe-oid',
      }],
    });
    await render();
    await gestureClick(container.querySelector('[data-testid="save-bundle-pin"]')!);
    await gestureClick(container.querySelector('[data-testid="save-bundle-submit"]')!);
    const terminal = container.querySelector('[data-kind="halted-uncertain"]');
    expect(terminal?.textContent).toContain('attempt-uncertain');
    expect(terminal?.textContent).toContain('maybe-oid');
    expect(terminal?.textContent).toContain('will not retry automatically');
    expect(container.querySelector('[data-testid="save-bundle-submit"]')?.hasAttribute('disabled')).toBe(true);
    expect(container.querySelector('[data-testid="save-bundle-repin"]')).toBeNull();
  });

  it('renders one terminal row per intent, including already-saved and not-attempted', async () => {
    // The server minted nothing because the human has not yet acknowledged the
    // unattributed atoms — it names the reason. The renderer must surface the ack
    // gate, never the confusing "did not produce a committable candidate".
    sweep.mockResolvedValue({
      halted: true, haltKind: 'uncertain',
      results: [
        { kind: 'already-saved', repositoryKey: 'repo-1', finalizationId: 'fin-1', packageId: 'b-loud', packageRevision: 1, provingCommitOids: ['proof-oid'] },
        { kind: 'not-attempted', repositoryKey: 'repo-1', finalizationId: 'fin-2', packageId: 'b-next', packageRevision: 1, haltedAfterFinalizationId: 'fin-1' },
      ],
    });
    await render();
    await gestureClick(container.querySelector('[data-testid="save-bundle-pin"]')!);
    await gestureClick(container.querySelector('[data-testid="save-bundle-submit"]')!);

    const terminals = container.querySelectorAll('[data-testid="save-sweep-terminal-result"]');
    expect(terminals).toHaveLength(2);
    expect(terminals[0].getAttribute('data-kind')).toBe('already-saved');
    expect(terminals[0].textContent).toContain('proof-oid');
    expect(terminals[1].getAttribute('data-kind')).toBe('not-attempted');
    expect(terminals[1].textContent).toContain('fin-1');
  });

  it('renders blocked-unmerged exactly as the server terminal kind', async () => {
    sweep.mockResolvedValue({
      halted: true, haltKind: 'unmerged',
      results: [{
        kind: 'blocked-unmerged', repositoryKey: 'repo-1', finalizationId: 'fin-1',
        packageId: 'b-loud', packageRevision: 1,
      }],
    });
    await render();
    await gestureClick(container.querySelector('[data-testid="save-bundle-pin"]')!);
    await gestureClick(container.querySelector('[data-testid="save-bundle-submit"]')!);

    expect(container.querySelector('[data-kind="blocked-unmerged"]')?.textContent).toContain('blocked-unmerged');
  });

  it('makes a second submit inert while the first sweep is still pending', async () => {
    let resolveSweep!: (value: unknown) => void;
    sweep.mockImplementation(() => new Promise((resolve) => { resolveSweep = resolve; }));
    await render();
    await gestureClick(container.querySelector('[data-testid="save-bundle-pin"]')!);
    const submit = container.querySelector('[data-testid="save-bundle-submit"]') as HTMLButtonElement;
    await act(async () => {
      submit.click();
      submit.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
    await act(async () => {
      resolveSweep({
        halted: false, haltKind: null,
        results: [{
          kind: 'saved', repositoryKey: 'repo-1', finalizationId: 'fin-1', packageId: 'b-loud',
          packageRevision: 1, commitOid: 'saved-oid', attemptId: 'attempt-1',
        }],
      });
      await Promise.resolve();
    });
  });

  it('locks the gesture after sweep transport uncertainty and never offers retry', async () => {
    sweep.mockRejectedValue(new Error('transport lost'));
    await render();
    await gestureClick(container.querySelector('[data-testid="save-bundle-pin"]')!);
    await gestureClick(container.querySelector('[data-testid="save-bundle-submit"]')!);

    expect(container.querySelector('[data-testid="save-gesture-refusal"]')?.textContent)
      .toContain('could not confirm whether this package was saved');
    expect(container.querySelector('[data-testid="save-bundle-repin"]')).toBeNull();
    expect((container.querySelector('[data-testid="save-bundle-submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('uses the edited message and appends optional user trailers after one blank line', async () => {
    await render();
    await gestureClick(container.querySelector('[data-testid="save-bundle-pin"]')!);
    await gestureClick(container.querySelector('[data-testid="save-bundle-details-toggle"]')!);
    const message = container.querySelector('[data-testid="candidate-preview-message"]') as HTMLTextAreaElement;
    const trailers = container.querySelector('[data-testid="candidate-preview-user-trailers"]') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(message, 'feat: decisive save');
      message.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(trailers, 'Co-authored-by: Example <example@example.com>');
      trailers.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    await gestureClick(container.querySelector('[data-testid="save-bundle-submit"]')!);
    expect(sweep.mock.calls[0][0].intents).toEqual([
      expect.objectContaining({
        message: 'feat: decisive save\n\nCo-authored-by: Example <example@example.com>',
      }),
    ]);
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
