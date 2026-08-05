// @vitest-environment jsdom
//
// SC-WP-3I — plan-lens candidate preview integration.
//
// Two properties, both from the WP acceptance:
//
//  1. IDENTICAL identity across lenses. The plan lens resolves a D-1-filtered
//     WHOLE-component selection and runs the SAME WP-3G `buildCandidate` service the
//     save lens uses — so for the same effective selection the `candidateId` and the
//     per-member verdicts are byte-identical, and a component that also connects to
//     ANOTHER plan is included WHOLE, never carved into a proper subset. This test
//     drives `buildCandidate` directly (the single identity/topology authority; the
//     plan channel `buildPlanCandidatePreview` is a thin wrapper that only forwards
//     the whole-component selection to this exact call — it can't be imported here
//     because `plan-ipc` pulls the native DB, so we mirror its selection resolution).
//
//  2. REUSE of the shared `CandidatePreview` (no fork/copy). `PlanSurfaceView`, given
//     a resolved selection, renders the SAME component the save lens uses: the member
//     verdicts show, the commit message body is EDITABLE, and the server-derived
//     `Lares-*` trailers render READ-ONLY.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlanSurfaceView from './PlanSurfaceView';
import { buildCandidate, type CandidateBuildContext } from '../../../main/commit-candidates/candidate-service';
import type {
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  RepositoryIdentity,
  CommitCandidate,
} from '../../../shared/commit-candidates';
import type { CommitRepresentation } from '../../../main/commit-candidates/commit-representation';
import type { FrozenManifestMember } from '../../../main/commit-candidates/finalization-service';
import type { PackageFinalization } from '../../../main/database';
import type { SaveCardPreviewResponse } from '../../../shared/types';

// ── fixtures ──────────────────────────────────────────────────────────────────
//
// A single component `c1` that fuses two entries and connects to BOTH plan-A and
// plan-B (a genuine cross-plan component). A finalization covers both entries and the
// current temp-index reps match, so a whole-component selection verifies + is
// eligible under either lens.

const REPO_KEY = 'repo-key-3i';

function repository(): RepositoryIdentity {
  return {
    repositoryKey: REPO_KEY,
    objectDatabaseKey: 'odb-1',
    gitObjectFormat: 'sha1',
    bareRepo: false,
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  };
}

function entry(id: string, over: Partial<DirtyEntry> = {}): DirtyEntry {
  return {
    entryId: id,
    path: { pathBytesBase64: `b64-${id}`, displayPath: `src/${id}.ts`, utf8Clean: true },
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
    rawWorktreeBlobOid: `raw-${id}`,
    gitLevelEligibility: 'supported',
    commitPathspecs: [],
    ...over,
  };
}

// c1 fuses e1 + e2 and carries TWO plan associations — it connects to plan-A AND
// plan-B, so the plan-A lens must include the whole component (e1 + e2), never e1
// alone.
function crossPlanComponent(): ConflictComponent {
  return {
    componentId: 'c1',
    dirtyEntryIds: ['e1', 'e2'],
    associations: [
      { planId: 'plan-A', planItemId: null, contributingTurnIds: ['t1'], memberEntryIds: ['e1'] },
      { planId: 'plan-B', planItemId: null, contributingTurnIds: ['t2'], memberEntryIds: ['e2'] },
    ],
    overlap: {
      componentId: 'c1',
      contributingAgentCount: 2,
      mergedGroupCount: 2,
      perPathContributors: {},
      requiresOverlapAck: false,
    },
    componentTopologyDigest: 'topo-c1',
  };
}

function inventory(entries: DirtyEntry[], unattributedEntryIds: string[] = []): DirtyInventory {
  return { repository: repository(), entries, unattributedEntryIds, topologyDigest: 'inv-topo' };
}

function frozen(entryId: string): FrozenManifestMember {
  return {
    pathBytesBase64: `b64-${entryId}`,
    expectedState: 'present',
    rawBlobOid: `raw-${entryId}`,
    commitBlobOid: `commit-${entryId}`,
    commitMode: '100644',
  };
}

function finalization(): PackageFinalization {
  return {
    id: 'fin-1',
    packageId: 'pkg-1',
    repositoryKey: REPO_KEY,
    finalizationKind: 'fleet-adhoc',
    planId: null,
    planItemId: null,
    packageRevision: 3,
    finalizedAt: 1,
    finalizedBy: 'human-ipc',
    checkpointTurnId: null,
    checkpointOid: 'boundary-oid',
    boundaryRef: 'refs/lares/fin-1',
    boundaryStatus: 'ready',
    lifecycleStatus: 'active',
    supersededByFinalizationId: null,
    releasedAt: null,
    memberManifestJson: JSON.stringify([frozen('e1'), frozen('e2')]),
    contractVersion: 1,
    failureReason: null,
    createdFromWorkspaceId: null,
  };
}

function context(): CandidateBuildContext {
  return {
    repository: repository(),
    inventory: inventory([entry('e1'), entry('e2')]),
    components: [crossPlanComponent()],
    finalizations: [finalization()],
    currentCommitReps: new Map<string, CommitRepresentation>([
      ['e1', { expectedState: 'present', rawBlobOid: 'raw-e1', commitBlobOid: 'commit-e1', commitMode: '100644' }],
      ['e2', { expectedState: 'present', rawBlobOid: 'raw-e2', commitBlobOid: 'commit-e2', commitMode: '100644' }],
    ]),
    ledger: [],
    pinnedHeadOid: 'HEAD-OID',
    indexFingerprint: { fingerprint: 'fp-1', entries: [], hasUnmerged: false, writeTreeOid: null },
    contractVersion: 1,
  };
}

/** Mirror of the plan channel's D-1 filter (`buildPlanCandidatePreview`): the plan
 *  lens's default selection is EVERY whole component with an association to `planId`
 *  — whole components only, never a carved subset. */
function planLensComponentIds(ctx: CandidateBuildContext, planId: string): string[] {
  return ctx.components
    .filter((component) => component.associations.some((a) => a.planId === planId))
    .map((component) => component.componentId);
}

// ── property 1: identical candidateId + verdicts across lenses ──────────────────

describe('SC-WP-3I plan-lens candidate identity', () => {
  it('assembles an IDENTICAL candidateId + member verdicts as the save lens for the same whole component', () => {
    const ctx = context();
    const finalizationIds = ['fin-1'];

    // Save lens: the user selects the whole component c1.
    const saveLens = buildCandidate(
      { selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], finalizationIds },
      ctx,
    ) as CommitCandidate;

    // Plan lens (plan-A): its D-1 filter resolves the SAME whole component c1 — even
    // though c1 also connects to plan-B, it is included whole, never carved.
    const planComponentIds = planLensComponentIds(ctx, 'plan-A');
    expect(planComponentIds).toEqual(['c1']);
    const planLens = buildCandidate(
      { selectedComponentIds: planComponentIds, selectedUnattributedEntryIds: [], finalizationIds },
      ctx,
    ) as CommitCandidate;

    // Both are finalization-backed candidates with a stable id.
    expect(saveLens.candidateId).toBeTypeOf('string');
    expect(saveLens.candidateId.length).toBeGreaterThan(0);
    // IDENTICAL identity across lenses (§14).
    expect(planLens.candidateId).toBe(saveLens.candidateId);
    // IDENTICAL per-member verdicts, in order.
    expect(planLens.members.map((m) => m.entryId)).toEqual(saveLens.members.map((m) => m.entryId));
    expect(planLens.members.map((m) => m.packageVerification)).toEqual(
      saveLens.members.map((m) => m.packageVerification),
    );
    expect(planLens.eligibility).toEqual(saveLens.eligibility);
    // The whole cross-plan component is present — BOTH entries, never a subset.
    expect(saveLens.members.map((m) => m.entryId).sort()).toEqual(['e1', 'e2']);
    expect(planLens.members.map((m) => m.entryId).sort()).toEqual(['e1', 'e2']);
  });

  it('the plan lens can never split a cross-plan component into a proper subset', () => {
    const ctx = context();
    // Carving one entry of the cross-plan component out as an independent atom is a
    // proper subset — buildCandidate (the sole topology authority) refuses it, so no
    // lens can present a sub-candidate of a component that connects to other plans.
    const carved = buildCandidate(
      { selectedComponentIds: [], selectedUnattributedEntryIds: ['e1'], finalizationIds: ['fin-1'] },
      ctx,
    ) as CommitCandidate;
    expect(carved.eligibility).toEqual({ eligible: false, reason: 'component-subset-not-allowed' });
  });
});

// ── property 2: PlanSurfaceView reuses the shared CandidatePreview ──────────────

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(el: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(el); });
  // Flush CandidatePreview's async preview load.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return container;
}

function previewResponse(): SaveCardPreviewResponse {
  const ctx = context();
  const candidate = buildCandidate(
    { selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], finalizationIds: ['fin-1'] },
    ctx,
  );
  return {
    candidate,
    isCandidate: true,
    // Server-derived, read-only trailer previews (from the immutable snapshot).
    laresTrailers: ['Lares-Turns: 2', 'Lares-Plan: plan-A', 'Lares-Plan: plan-B', 'Lares-Finalization: pkg-1@3'],
    defaultMessageBody: 'Save 2 files',
    requiresOverlapAck: false,
    unacknowledgedUnattributedEntryIds: [],
    componentTopologyDigest: 'topo-1',
  };
}

describe('SC-WP-3I PlanSurfaceView candidate preview reuse', () => {
  beforeEach(() => {
    (window as unknown as { api: unknown }).api = {
      saveCard: { preview: vi.fn(async () => previewResponse()) },
    };
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    container?.remove();
    container = null;
    root = null;
    delete (window as unknown as { api?: unknown }).api;
  });

  it('renders the shared CandidatePreview for the plan lens when a selection is resolved', async () => {
    const c = await render(
      <PlanSurfaceView
        workspaceId="ws-1"
        candidateSelection={{ selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], finalizationIds: ['fin-1'] }}
      />,
    );
    // The plan lens hosts the SHARED save-lens preview component (reused, not forked).
    expect(c.querySelector('[data-testid="plan-candidate-preview"]')).not.toBeNull();
    const preview = c.querySelector('[data-testid="candidate-preview"]');
    expect(preview).not.toBeNull();
    // Both member verdicts render.
    expect(c.querySelectorAll('[data-testid="candidate-member"]').length).toBe(2);
    // window.api.saveCard.preview was driven with the plan lens's selection.
    expect((window as unknown as { api: { saveCard: { preview: ReturnType<typeof vi.fn> } } }).api.saveCard.preview)
      .toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1', selectedComponentIds: ['c1'] }));
  });

  it('renders an EDITABLE message body and READ-ONLY Lares-* trailers', async () => {
    const c = await render(
      <PlanSurfaceView
        workspaceId="ws-1"
        candidateSelection={{ selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], finalizationIds: ['fin-1'] }}
      />,
    );
    // Editable commit message body (a real textarea seeded with the server default).
    const message = c.querySelector('[data-testid="candidate-preview-message"]') as HTMLTextAreaElement | null;
    expect(message).not.toBeNull();
    expect(message!.tagName).toBe('TEXTAREA');
    expect(message!.readOnly).toBe(false);
    expect(message!.value).toBe('Save 2 files');

    // Read-only, server-derived Lares-* trailers — rendered as plain text (not inputs).
    const trailers = Array.from(c.querySelectorAll('[data-testid="candidate-preview-trailer"]')).map(
      (t) => t.textContent,
    );
    expect(trailers).toContain('Lares-Plan: plan-A');
    expect(trailers).toContain('Lares-Plan: plan-B');
    expect(trailers).toContain('Lares-Finalization: pkg-1@3');
    const trailerBox = c.querySelector('[data-testid="candidate-preview-trailers"]')!;
    expect(trailerBox.querySelector('input')).toBeNull();
    expect(trailerBox.querySelector('textarea')).toBeNull();
    expect(trailerBox.textContent).toMatch(/read-only/i);
  });

  it('omits the preview when no candidate selection is resolved (unwired / nothing to save)', async () => {
    const c = await render(
      <PlanSurfaceView
        workspaceId="ws-1"
        candidateSelection={null}
      />,
    );
    expect(c.querySelector('[data-testid="plan-candidate-preview"]')).toBeNull();
    expect(c.querySelector('[data-testid="candidate-preview"]')).toBeNull();
  });
});
