// @vitest-environment jsdom
/**
 * SC-WP-3H — Save-lens candidate preview render contract.
 *
 * The window.api.saveCard.preview bridge is mocked; the component renders against
 * real DOM in jsdom. Covers:
 *   - per-member verification verdicts render;
 *   - the commit-message body is user-editable;
 *   - server-derived `Lares-*` trailers render READ-ONLY (no bound input);
 *   - a user trailer in the reserved `Lares-` namespace is rejected + blocks save;
 *   - NO one-click save for verified-mismatch / degraded / unfinalized work;
 *   - the overlap / unattributed acknowledgements gate the one-click save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SaveCardPreviewResponse,
} from '../../../shared/types';
import type {
  CandidateMember,
  CommitCandidate,
  CommitEligibility,
  PackageVerificationState,
  ReviewChallengeAtom,
  SelectionPreview,
} from '../../../shared/commit-candidates';
import CandidatePreview, { type CandidatePreviewSelection } from './CandidatePreview';
import { useSaveCardStore } from '../../stores/save-card-store';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function member(
  entryId: string,
  verification: PackageVerificationState,
  displayPath = `src/${entryId}.ts`,
): CandidateMember {
  return {
    entryId,
    path: { pathBytesBase64: `b64-${entryId}`, displayPath, utf8Clean: true },
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid: `raw-${entryId}`,
    expectedCommitBlobOid: `commit-${entryId}`,
    expectedCommitMode: '100644',
    checkpointMode: '100644',
    coveringFinalizationIds: ['fin-1'],
    packageVerification: verification,
    protection: 'checkpoint-protected',
  };
}

function candidate(
  eligibility: CommitEligibility,
  members: CandidateMember[],
): CommitCandidate {
  return {
    candidateId: 'cand-1',
    contractVersion: 1,
    repository: {
      repositoryKey: 'repo-1', objectDatabaseKey: 'odb-1', gitObjectFormat: 'sha1',
      bareRepo: false, workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
    },
    componentIds: ['c1'],
    selectedUnattributedEntryIds: [],
    members,
    finalizations: [{ finalizationId: 'fin-1', packageId: 'pkg-1', packageRevision: 3, boundaryStatus: 'ready' }],
    eligibility,
    token: null,
  };
}

function response(over: Partial<SaveCardPreviewResponse> = {}): SaveCardPreviewResponse {
  return {
    candidate: candidate({ eligible: true }, [member('e1', 'verified-match')]),
    isCandidate: true,
    laresTrailers: ['Lares-Turns: 2', 'Lares-Plan: plan-A'],
    defaultMessageBody: 'Save 1 file',
    requiresOverlapAck: false,
    unacknowledgedUnattributedEntryIds: [],
    componentTopologyDigest: 'topo-1',
    selectionDrift: { added: [], missing: [], reAttributed: [], byteMoved: [] },
    selectionDriftDisplayPaths: {},
    pinnedSelection: {
      selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], frozenMemberCount: 1,
    },
    refusal: null,
    reviewedManifest: {
      manifestVersion: 1, reviewedManifestDigest: 'review-1', members: [],
      challengeVersion: 1, challengeAtoms: [],
    },
    durableFinalizationIntent: [{
      finalizationId: 'fin-1', packageId: 'pkg-1', packageRevision: 3,
      boundaryStatus: 'ready', frozenMemberManifestDigest: 'frozen-1',
    }],
    ...over,
  };
}

const SELECTION: CandidatePreviewSelection = {
  selectedComponentIds: ['c1'],
  selectedUnattributedEntryIds: [],
  finalizationIds: ['fin-1'],
};

// ── render harness ────────────────────────────────────────────────────────────
let container: HTMLDivElement;
let root: Root;
let preview: ReturnType<typeof vi.fn>;

async function render(props: Partial<React.ComponentProps<typeof CandidatePreview>> = {}) {
  await act(async () => {
    root.render(
      React.createElement(CandidatePreview, {
        workspaceId: 'ws-1',
        selection: SELECTION,
        ...props,
      }),
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  useSaveCardStore.getState().clearInventoryCache();
  preview = vi.fn();
  (window as unknown as { api: unknown }).api = { saveCard: { preview } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function q(testid: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}
function all(testid: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)];
}

describe('CandidatePreview', () => {
  it('renders per-member verdicts and enables one-click save for an eligible candidate', async () => {
    preview.mockResolvedValue(response());
    await render();

    const members = all('candidate-member');
    expect(members).toHaveLength(1);
    expect(members[0].getAttribute('data-verdict')).toBe('verified-match');
    expect(members[0].textContent).toContain('Verified');
    expect(members[0].textContent).toContain('src/e1.ts');

    const save = q('candidate-preview-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(save.textContent).toContain('Save — commit 1 file');
  });

  it('lets the user edit the commit message body', async () => {
    preview.mockResolvedValue(response());
    await render();

    const textarea = q('candidate-preview-message') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Save 1 file');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'feat: my own message');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((q('candidate-preview-message') as HTMLTextAreaElement).value).toBe('feat: my own message');
  });

  it('renders Lares-* trailers read-only (no bound input) and never as editable fields', async () => {
    preview.mockResolvedValue(response());
    await render();

    const trailers = q('candidate-preview-trailers')!;
    expect(trailers.textContent).toContain('Lares-Turns: 2');
    expect(trailers.textContent).toContain('Lares-Plan: plan-A');
    // Read-only: the trailer block contains no input/textarea the user could edit.
    expect(trailers.querySelector('input')).toBeNull();
    expect(trailers.querySelector('textarea')).toBeNull();
  });

  it('rejects a user trailer in the reserved Lares- namespace and blocks save', async () => {
    preview.mockResolvedValue(response());
    await render();

    const save = q('candidate-preview-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    const userTrailers = q('candidate-preview-user-trailers') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(userTrailers, 'Lares-Plan: forged-override');
      userTrailers.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(q('candidate-preview-user-trailers-error')).not.toBeNull();
    expect((q('candidate-preview-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('never offers a one-click save for a verified-mismatch (held) candidate', async () => {
    preview.mockResolvedValue(response({
      candidate: candidate({ eligible: false, reason: 'byte-mismatch' }, [member('e1', 'verified-mismatch')]),
    }));
    await render();

    expect(q('candidate-member')!.getAttribute('data-verdict')).toBe('verified-mismatch');
    const save = q('candidate-preview-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(q('candidate-preview-verdict')!.textContent).toContain('no longer matches');
  });

  it('renders typed drift with the server-provided path name and pinned count', async () => {
    const pathBytes = Buffer.from('src/e1.ts').toString('base64');
    preview.mockResolvedValue(response({
      candidate: candidate({ eligible: false, reason: 'byte-mismatch' }, [member('e1', 'verified-mismatch')]),
      selectionDrift: { added: [], missing: [pathBytes], reAttributed: [], byteMoved: [] },
      selectionDriftDisplayPaths: { [pathBytes]: 'src/e1.ts' },
      pinnedSelection: {
        selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], frozenMemberCount: 15,
      },
    }));
    await render();

    const verdict = q('candidate-preview-verdict')!.textContent ?? '';
    expect(verdict).toContain('1 of 15 pinned files changed');
    expect(verdict).toContain('src/e1.ts');
    expect(verdict).toContain('re-pin to save current bytes');
    expect((q('candidate-preview-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('never offers a one-click save for an unfinalized SelectionPreview', async () => {
    const selectionPreview: SelectionPreview = {
      componentIds: ['c1'],
      selectedUnattributedEntryIds: [],
      members: [member('e1', 'package-not-finalized')],
      eligibility: { eligible: false, reason: 'package-not-finalized' },
    };
    preview.mockResolvedValue(response({
      candidate: selectionPreview,
      isCandidate: false,
      laresTrailers: ['Lares-Turns: 2'],
    }));
    await render();

    expect(q('candidate-member')!.getAttribute('data-verdict')).toBe('package-not-finalized');
    expect((q('candidate-preview-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('gates one-click save behind the overlap and unattributed acknowledgements', async () => {
    const overlapAtom: ReviewChallengeAtom = {
      kind: 'overlap', atomId: 'overlap-1', digest: 'overlap-digest', reasonVersion: 1,
      memberPathBytesBase64: ['b64-e1'], contributors: [], ownershipGroupKeys: ['owner-1'],
    };
    const unattributedAtom: ReviewChallengeAtom = {
      kind: 'unattributed', atomId: 'unattributed-1', digest: 'unattributed-digest',
      pathBytesBase64: 'b64-eu', memberEffectDigest: 'effect-eu',
    };
    preview.mockResolvedValue(response({
      candidate: candidate({ eligible: true }, [
        member('e1', 'verified-match'), member('eu', 'verified-match'),
      ]),
      requiresOverlapAck: true,
      unacknowledgedUnattributedEntryIds: ['eu'],
      reviewedManifest: {
        ...response().reviewedManifest!, challengeAtoms: [overlapAtom, unattributedAtom],
      },
    }));
    await render();

    const save = () => q('candidate-preview-save') as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    const overlap = q('candidate-preview-overlap-ack')!.querySelector('input') as HTMLInputElement;
    await act(async () => { overlap.click(); });
    // Still blocked: the unattributed entry is not yet acknowledged.
    expect(save().disabled).toBe(true);

    const unattr = q('candidate-preview-unattributed-ack')!.querySelector('input') as HTMLInputElement;
    await act(async () => { unattr.click(); });
    expect(save().disabled).toBe(false);
  });

  it('labels unattributed acknowledgements with paths and acknowledges a backlog in one gesture', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => member(`u${index}`, 'verified-match'));
    const atoms: ReviewChallengeAtom[] = entries.map((item, index) => ({
      kind: 'unattributed', atomId: `unattributed-${index}`, digest: `digest-${index}`,
      pathBytesBase64: item.path.pathBytesBase64, memberEffectDigest: `effect-${index}`,
    }));
    preview.mockResolvedValue(response({
      candidate: candidate({ eligible: true }, entries),
      unacknowledgedUnattributedEntryIds: entries.map((item) => item.entryId),
      reviewedManifest: { ...response().reviewedManifest!, challengeAtoms: atoms },
    }));
    await render();

    const rows = container.querySelectorAll('[data-testid="candidate-preview-unattributed-ack"]');
    expect(rows).toHaveLength(100);
    expect(rows[0].textContent).toContain('src/u0.ts');
    expect(rows[0].textContent).not.toContain('u0 —');

    const acknowledgeAll = q('candidate-preview-unattributed-ack-all')!.querySelector('input') as HTMLInputElement;
    await act(async () => { acknowledgeAll.click(); });
    expect(acknowledgeAll.checked).toBe(true);
    expect(Array.from(rows).every((row) => (row.querySelector('input') as HTMLInputElement).checked)).toBe(true);

    await act(async () => { (rows[0].querySelector('input') as HTMLInputElement).click(); });
    expect((rows[0].querySelector('input') as HTMLInputElement).checked).toBe(false);
    expect((rows[1].querySelector('input') as HTMLInputElement).checked).toBe(true);
  });

  it('retains only acknowledgements whose atom id and digest are unchanged', async () => {
    const overlapAtom: ReviewChallengeAtom = {
      kind: 'overlap', atomId: 'overlap-1', digest: 'overlap-digest', reasonVersion: 1,
      memberPathBytesBase64: ['b64-e1'], contributors: [], ownershipGroupKeys: ['owner-1'],
    };
    const unattributedAtom: ReviewChallengeAtom = {
      kind: 'unattributed', atomId: 'unattributed-1', digest: 'unattributed-old',
      pathBytesBase64: 'b64-eu', memberEffectDigest: 'effect-eu',
    };
    const candidateWithUnattributed = candidate({ eligible: true }, [
      member('e1', 'verified-match'), member('eu', 'verified-match'),
    ]);
    const first = response({
      candidate: candidateWithUnattributed, requiresOverlapAck: true,
      unacknowledgedUnattributedEntryIds: ['eu'],
      reviewedManifest: { ...response().reviewedManifest!, challengeAtoms: [overlapAtom, unattributedAtom] },
    });
    await render({ authoritativeResponse: first });
    await act(async () => {
      (q('candidate-preview-overlap-ack')!.querySelector('input') as HTMLInputElement).click();
      (q('candidate-preview-unattributed-ack')!.querySelector('input') as HTMLInputElement).click();
    });

    const changedUnattributed = { ...unattributedAtom, digest: 'unattributed-new' };
    const second = response({
      candidate: candidateWithUnattributed, requiresOverlapAck: true,
      unacknowledgedUnattributedEntryIds: ['eu'],
      reviewedManifest: {
        ...response().reviewedManifest!, reviewedManifestDigest: 'review-2',
        challengeAtoms: [overlapAtom, changedUnattributed],
      },
    });
    await render({ authoritativeResponse: second });

    expect((q('candidate-preview-overlap-ack')!.querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect((q('candidate-preview-unattributed-ack')!.querySelector('input') as HTMLInputElement).checked).toBe(false);
  });

  it('surfaces an honest error when the preview cannot be assembled', async () => {
    preview.mockRejectedValue(new Error('save-card-engine-unavailable'));
    await render();
    expect(q('candidate-preview-error')!.textContent).toContain('save-card-engine-unavailable');
  });

  it('fires onCommit only when eligible and acknowledged', async () => {
    const onCommit = vi.fn();
    useSaveCardStore.getState().cacheInventory('ws-1', { bundles: [], quotaWeakening: null });
    preview.mockResolvedValue(response());
    await render({ onCommit });

    await act(async () => { (q('candidate-preview-save') as HTMLButtonElement).click(); });
    expect(onCommit).toHaveBeenCalledTimes(1);
    // CandidatePreview is review UI only. The shared preview→mint→consume
    // transaction owns invalidation plus the mandatory fresh read after a
    // verified save, so merely invoking an injected callback does not stale it.
    expect(useSaveCardStore.getState().inventoryByWorkspace['ws-1'].loadedAt).toBeGreaterThan(0);
  });

  it('shows Save progress and prevents a second commit while the first is pending', async () => {
    let resolveCommit!: () => void;
    const onCommit = vi.fn(() => new Promise<void>((resolve) => { resolveCommit = resolve; }));
    preview.mockResolvedValue(response());
    await render({ onCommit });

    const save = q('candidate-preview-save') as HTMLButtonElement;
    await act(async () => {
      save.click();
      save.click();
      await Promise.resolve();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('aria-busy')).toBe('true');
    expect(save.textContent).toContain('Saving');

    await act(async () => { resolveCommit(); await Promise.resolve(); });
    expect((q('candidate-preview-save') as HTMLButtonElement).disabled).toBe(false);
  });
});
