import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import {
  isSaveCardInventoryFresh,
  useSaveCardStore,
  useSaveCardAttention,
} from '../../stores/save-card-store';
import type {
  CommitCoordinatorConsumeResponse,
  SaveCardFleetAdhocMarkDoneResponse,
  SaveCardFleetAdhocMarkDoneSuccess,
  SaveCardInventoryResponse,
  SaveCardPreviewResponse,
} from '../../../shared/types';
import type { SaveCardQuotaWeakening } from '../../../shared/commit-candidates';
import SaveBundle, { isQuietlySaved, type WorkBundleDto } from './SaveBundle';
import CandidatePreview, {
  type CandidatePreviewDraft,
  type CandidatePreviewSelection,
} from './CandidatePreview';
import CommitOutcome from './CommitOutcome';
import QuotaWeakeningBanner from './QuotaWeakeningBanner';
import { groupExpiryEdgesByBundle, formatExpiresIn } from './save-card-expiry';
import './save-card.css';

// SC-WP-3H — derive the explicit WP-3G selection for a displayed group of
// bundles. Component bundles contribute their whole component (atomic);
// unattributed bundles contribute their member entries as independent atoms. The
// bundle DTO carries no finalization coverage yet, so `finalizationIds` is empty
// — the preview is a `SelectionPreview` (previewable, never one-click) until a
// later stage surfaces the covering finalizations.
function selectionForGroup(
  group: WorkBundleDto[],
  finalizationIds: string[] = [],
): CandidatePreviewSelection {
  const selectedComponentIds = group
    .filter((bundle) => bundle.kind === 'component' && bundle.component)
    .map((bundle) => bundle.component!.componentId);
  const selectedUnattributedEntryIds = group
    .filter((bundle) => bundle.kind === 'unattributed')
    .flatMap((bundle) => bundle.members.map((member) => member.entry.entryId));
  return { selectedComponentIds, selectedUnattributedEntryIds, finalizationIds };
}

/**
 * SC-WP-3H — the per-package "Save…" affordance. Toggles the read-only candidate
 * preview pane in place beneath the bundle card. Kept in SaveCard (not SaveBundle)
 * so the Stage ① read-only bundle card stays untouched. The pane itself decides
 * whether a one-click save is offered (never for mismatch/degraded/unfinalized).
 */
function joinMessageAndUserTrailers(messageBody: string, userTrailers: string): string {
  const trailers = userTrailers.trim();
  return trailers ? `${messageBody.trimEnd()}\n\n${trailers}` : messageBody;
}

function previewMismatchPaths(response: SaveCardPreviewResponse): string[] {
  return response.candidate.members
    .filter((member) => member.packageVerification === 'verified-mismatch')
    .map((member) => member.path.displayPath);
}

function PackageSaveGesture({
  group,
  workspaceId,
}: {
  group: WorkBundleDto[];
  workspaceId: string;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [pins, setPins] = useState<SaveCardFleetAdhocMarkDoneSuccess[]>([]);
  const [draft, setDraft] = useState<CandidatePreviewDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<CommitCoordinatorConsumeResponse | null>(null);
  const [gestureError, setGestureError] = useState<string | null>(null);
  const [movedPaths, setMovedPaths] = useState<string[]>([]);
  const submittingRef = useRef(false);
  const finalizationIds = pins
    .filter((pin) => pin.boundaryStatus === 'ready')
    .map((pin) => pin.finalizationId);
  const pinned = pins.length === group.length && finalizationIds.length === group.length;
  const selection = React.useMemo(
    () => selectionForGroup(group, finalizationIds),
    [group.map((bundle) => bundle.bundleId).join('\0'), finalizationIds.join('\0')],
  );
  const hasSelectable =
    selection.selectedComponentIds.length > 0 || selection.selectedUnattributedEntryIds.length > 0;
  if (!hasSelectable) return null;

  const pinPackage = async () => {
    if (pinning || submittingRef.current) return;
    const unsaveable = group.find((bundle) => bundle.saveability?.saveable === false);
    if (unsaveable?.saveability?.saveable === false) {
      setGestureError(
        `No git repository — cannot pin/commit from workspace '${unsaveable.saveability.workspaceTitle}'.`,
      );
      return;
    }
    setPinning(true);
    setGestureError(null);
    setOutcome(null);
    setMovedPaths([]);
    try {
      const responses: SaveCardFleetAdhocMarkDoneResponse[] = await Promise.all(
        group.map((bundle) =>
          window.api.saveCard.markDone({ packageId: bundle.bundleId, targetWorkspaceId: workspaceId }),
        ),
      );
      const refusal = responses.find(
        (response): response is Extract<SaveCardFleetAdhocMarkDoneResponse, { ok: false }> =>
          'ok' in response && response.ok === false,
      );
      if (refusal) {
        setPins([]);
        setGestureError(refusal.message);
        return;
      }
      const successful = responses as SaveCardFleetAdhocMarkDoneSuccess[];
      setPins(successful);
      setDraft(null);
      if (successful.some((response) => response.boundaryStatus !== 'ready')) {
        setGestureError('Finalization could not capture a ready boundary. Nothing can be submitted yet.');
      }
    } catch (err) {
      setGestureError(errorMessage(err));
    } finally {
      setPinning(false);
    }
  };

  const submit = async () => {
    if (!pinned || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setGestureError(null);
    setOutcome(null);
    setMovedPaths([]);
    try {
      // Submit intent: ask the server to mint a consumable commit token for an
      // eligible candidate, forwarding the human acknowledgements the preview pane
      // collected. A display-only preview (the expander) never sets `mintIfEligible`.
      const response = await window.api.saveCard.preview({
        workspaceId,
        ...selection,
        mintIfEligible: true,
        acknowledgeTopologyDigest: draft?.response.topologyDigest,
        acknowledgeUnattributedEntryIds: draft?.acknowledgedUnattributedEntryIds,
      });
      const paths = previewMismatchPaths(response);
      const reason = response.candidate.eligibility.eligible === false
        ? response.candidate.eligibility.reason
        : null;
      // A pending human acknowledgement wins over the generic no-token message:
      // route the user to the ack gate rather than a confusing "no candidate" line.
      // The SERVER is authoritative about whether acks are the blocker.
      if (reason === 'overlap-not-acknowledged' || reason === 'unattributed-not-acknowledged') {
        setGestureError('Review and acknowledge the highlighted package details before submitting.');
        setDetailsOpen(true);
        return;
      }
      if (!response.isCandidate || !response.candidate.eligibility.eligible ||
          !('token' in response.candidate) || !response.candidate.token) {
        setMovedPaths(paths);
        // Surface the SERVER's specific ineligibility reason when it named one; only
        // fall back to the generic line when an eligible candidate somehow lacks a
        // token (the honest "unknown" case).
        setGestureError(reason
          ? `Pinned bytes no longer qualify: ${reason}.`
          : 'The pinned package did not produce a committable candidate.');
        setDetailsOpen(true);
        return;
      }
      if (draft?.reservedTrailer) {
        setGestureError('A user trailer uses the reserved Lares- namespace. Remove it before submitting.');
        setDetailsOpen(true);
        return;
      }
      const result = await window.api.commitCoordinator.commit({
        candidateId: response.candidate.candidateId,
        tokenId: response.candidate.token.tokenId,
        message: joinMessageAndUserTrailers(
          draft?.messageBody ?? response.defaultMessageBody,
          draft?.userTrailers ?? '',
        ),
      });
      setOutcome(result);
      if (result.kind === 'outcome' && result.outcome.status === 'aborted-stale') {
        setGestureError(result.outcome.reason);
      }
    } catch (err) {
      setGestureError(errorMessage(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  return (
    <div className="sc-save-launcher">
      <SaveBundle
        bundle={group[0]}
        bundles={group}
        pinned={pinned}
        pinning={pinning}
        onPin={() => { void pinPackage(); }}
      />
      <button
        type="button"
        className="ui-btn ui-btn-primary px-3 py-1 text-[12.5px]"
        data-testid="save-bundle-submit"
        disabled={!pinned || submitting}
        onClick={() => { void submit(); }}
      >
        {submitting ? 'Saving…' : 'Submit save'}
      </button>
      <button
        type="button"
        className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px]"
        data-testid="save-bundle-details-toggle"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        {detailsOpen ? 'Hide preview & message' : 'Preview & message'}
      </button>
      {pinning && <div className="sc-save-note" role="status">Pinning reviewed bytes…</div>}
      {gestureError && (
        <div className="sc-save-refusal" role="alert" data-testid="save-gesture-refusal">
          <b>Save refused safely.</b> {gestureError}
          {(movedPaths.length > 0 || (outcome?.kind === 'outcome' && outcome.outcome.status === 'aborted-stale')) && (
            <div className="sc-save-diff" data-testid="save-gesture-diff">
              <strong>What moved</strong>
              {movedPaths.length > 0
                ? <ul>{movedPaths.map((path) => <li key={path}>{path}</li>)}</ul>
                : <p>{gestureError}</p>}
            </div>
          )}
        </div>
      )}
      {detailsOpen && pinned && (
        <CandidatePreview
          key={finalizationIds.join(':')}
          workspaceId={workspaceId}
          selection={selection}
          showCommitAction={false}
          onDraftChange={setDraft}
          onClose={() => setDetailsOpen(false)}
        />
      )}
      {outcome && (
        <CommitOutcome
          response={outcome}
          onRepreview={() => {
            setOutcome(null);
            setGestureError(null);
            setDetailsOpen(true);
          }}
        />
      )}
      {outcome && outcome.kind === 'outcome' && outcome.outcome.status === 'aborted-stale' && (
        <button
          type="button"
          className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px] sc-repin"
          data-testid="save-bundle-repin"
          onClick={() => { void pinPackage(); }}
        >
          Re-pin current bytes
        </button>
      )}
    </div>
  );
}

/**
 * SC-WP-N2 — the checkpoint-expiry block. Groups the retention pass's expiring
 * recovery edges onto the displayed bundles (by intersecting `affectedEntryIds`
 * with each bundle's member entry ids) so the "expiring soon" warning lands on the
 * exact package holding the work. Renders nothing when no bundle is affected — the
 * signal is truthful (it comes from the real retained-pin selection, never a
 * renderer-side re-derivation from turn age).
 */
function ExpiryBlock({
  bundles,
  workspaceId,
}: {
  bundles: WorkBundleDto[];
  workspaceId: string | null;
}) {
  const notice = useSaveCardAttention(workspaceId);
  const grouped = groupExpiryEdgesByBundle(notice, bundles);
  if (!notice || grouped.length === 0) return null;
  const now = notice.observedAt;
  return (
    <div className="sc-expiry" role="status" data-testid="save-card-expiry">
      <div className="sc-expiry-title">
        ⏳ Recovery checkpoints expiring soon
      </div>
      <div className="sc-expiry-body">
        Automatic turn snapshots protecting this work will be pruned unless you save
        it. Committing (or pushing) makes it permanent.
      </div>
      <ul className="sc-expiry-list">
        {grouped.map(({ bundle, earliestExpiresAt }) => (
          <li key={bundle.bundleId} data-testid="save-card-expiry-row">
            <b>{bundle.label}</b>
            <span className="sc-expiry-when"> · expires in {formatExpiresIn(earliestExpiresAt, now)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; bundles: WorkBundleDto[]; quotaWeakening: SaveCardQuotaWeakening | null };

// Turn whatever the rejected getInventory invoke throws into a single honest
// line. The Stage ① engine may be unavailable (route not yet injected), the
// workspace may be a non-repo / unborn HEAD, or the read may have failed — all
// surface as an explicit unavailable state, never a fabricated empty tree.
function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'The Save engine could not be reached.';
}

function groupBySupervisor(bundles: WorkBundleDto[]): WorkBundleDto[][] {
  const groups = new Map<string, WorkBundleDto[]>();
  for (const bundle of bundles) {
    const key = bundle.kind === 'unattributed'
      ? bundle.bundleId
      : bundle.identity?.groupingKey ?? bundle.bundleId;
    const group = groups.get(key);
    if (group) group.push(bundle);
    else groups.set(key, [bundle]);
  }
  return [...groups.values()];
}

/**
 * SaveCard — the read-only Save-progress center surface (SC-WP-1I).
 *
 * Fetches the repository inventory for the selected workspace via the single
 * read-only `saveCard.getInventory` channel and renders the WorkBundle DTOs the
 * candidate service delivered: a loud "unsaved work" section (colored card
 * edges, memory-jog descriptions, capture-health flags) and a quiet
 * already-protected list below. Loading, unavailable/error, and empty states
 * all render honestly. There is NO commit/write affordance anywhere on this
 * surface — Stage ① reveals state only (no writer exists).
 */
export default function SaveCard() {
  const workspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const workspace = useDashboardStore((s) =>
    s.workspaces.find((w) => w.id === s.selectedWorkspaceId),
  );
  const cached = useSaveCardStore((s) =>
    workspaceId ? s.inventoryByWorkspace[workspaceId] : undefined,
  );
  const cacheInventory = useSaveCardStore((s) => s.cacheInventory);
  const [state, setState] = useState<LoadState>(() =>
    cached
      ? {
          status: 'ready',
          bundles: cached.inventory.bundles,
          quotaWeakening: cached.inventory.quotaWeakening,
        }
      : { status: 'loading' },
  );
  const [refreshing, setRefreshing] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);
  const infoButtonRef = useRef<HTMLButtonElement>(null);

  // WP-P1S — demand probe: witness a VOLUNTARY user open of the Save card. The
  // store's one-shot `saveCardOpenGesture` flag is set only by `showSaveCard()`
  // (the toolbar gesture), so we emit exactly one `savecard_open` per gesture and
  // stay silent on a bare mount / session-restore reopen (switchWorkspace leaves
  // the flag false) and on Refresh/Try-again (a re-fetch, not a remount). The ref
  // guards against a re-render or StrictMode double-invoke re-firing within one
  // mount; `feature_exercise` is intentionally omitted so the event stays
  // voluntary-eligible at aggregation.
  const openedByGesture = useDashboardStore((s) => s.saveCardOpenGesture);
  const consumeSaveCardGesture = useDashboardStore((s) => s.consumeSaveCardGesture);
  const probeFiredRef = useRef(false);
  useEffect(() => {
    if (!openedByGesture || probeFiredRef.current) return;
    probeFiredRef.current = true;
    consumeSaveCardGesture();
    if (!workspaceId) return;
    void window.api.demandProbe.record({ workspaceId, kind: 'savecard_open' }).catch(() => {});
  }, [openedByGesture, workspaceId, consumeSaveCardGesture]);

  useEffect(() => {
    if (!infoOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!infoRef.current?.contains(event.target as Node)) setInfoOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setInfoOpen(false);
      infoButtonRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [infoOpen]);

  const load = useCallback(
    async (wsId: string, isCurrent: () => boolean, keepVisible: boolean) => {
      if (keepVisible) setRefreshing(true);
      else setState({ status: 'loading' });
      try {
        const response: SaveCardInventoryResponse = await window.api.saveCard.getInventory({
          workspaceId: wsId,
        });
        if (isCurrent()) {
          cacheInventory(wsId, response);
          setState({
            status: 'ready',
            bundles: response.bundles,
            quotaWeakening: response.quotaWeakening,
          });
        }
      } catch (err) {
        if (isCurrent() && !keepVisible) {
          setState({ status: 'error', message: errorMessage(err) });
        }
      } finally {
        if (isCurrent()) setRefreshing(false);
      }
    },
    [cacheInventory],
  );

  useEffect(() => {
    if (!workspaceId) {
      setRefreshing(false);
      setState({ status: 'error', message: 'Select a workspace to inspect its save progress.' });
      return;
    }
    if (cached) {
      setState({
        status: 'ready',
        bundles: cached.inventory.bundles,
        quotaWeakening: cached.inventory.quotaWeakening,
      });
      if (isSaveCardInventoryFresh(cached)) return;
    }
    let active = true;
    void load(workspaceId, () => active, Boolean(cached));
    return () => {
      active = false;
    };
  }, [workspaceId, cached?.loadedAt, load]);

  const refresh = useCallback(() => {
    if (!workspaceId) return;
    let active = true;
    void load(workspaceId, () => active, state.status === 'ready');
  }, [workspaceId, load, state.status]);

  const header = (
    <>
      <div className="sc-heading-row">
        <h1 className="sc-h1">Save Progress</h1>
        <div className="sc-info-wrap" ref={infoRef}>
          <button
            ref={infoButtonRef}
            type="button"
            className="sc-info-button"
            aria-label="How save protection works"
            aria-haspopup="dialog"
            aria-expanded={infoOpen}
            aria-controls="save-protection-info"
            onClick={() => setInfoOpen((open) => !open)}
          >
            i
          </button>
          {infoOpen && (
            <div
              id="save-protection-info"
              className="sc-info-popover"
              role="dialog"
              aria-label="Save protection ladder"
            >
              <div className="sc-info-title">Your save-protection ladder</div>
              <dl>
                <div>
                  <dt>Working tree</dt>
                  <dd>Your live files. They can change at any time.</dd>
                </div>
                <div>
                  <dt>Checkpoint</dt>
                  <dd>An automatic turn snapshot. Recoverable, but it can expire or be pruned.</dd>
                </div>
                <div>
                  <dt>Commit</dt>
                  <dd>An immutable, named, permanent save on this machine.</dd>
                </div>
                <div>
                  <dt>Push</dt>
                  <dd>A copy off this machine. Your strongest protection.</dd>
                </div>
              </dl>
            </div>
          )}
        </div>
      </div>
      <p className="sc-sub">
        {workspace ? (
          <>Workspace <b>{workspace.title}</b> · pin and save exact packages of work</>
        ) : (
          <>Pin and save exact packages of work</>
        )}
      </p>
      {refreshing && (
        <div className="sc-refreshing" data-testid="save-card-refreshing" role="status">
          Refreshing save progress…
        </div>
      )}
    </>
  );

  if (state.status === 'loading') {
    return (
      <div className="sc-root" data-testid="save-card">
        {header}
        <div className="sc-state" data-testid="save-card-loading">
          <div className="sc-state-title">Reading save progress…</div>
          <div className="sc-state-body">Gathering the workspace's uncommitted work into packages.</div>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="sc-root" data-testid="save-card">
        {header}
        <div className="sc-state sc-state-error" data-testid="save-card-error">
          <div className="sc-state-title">Save progress unavailable</div>
          <div className="sc-state-body">{state.message}</div>
          <div className="sc-state-hint">
            The Save surface reveals state only — nothing was written. Try again once the workspace is a
            git repository with at least one commit and the Save engine has finished starting.
          </div>
          <div className="sc-actions">
            <button
              type="button"
              className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px]"
              data-testid="save-card-retry"
              onClick={refresh}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { bundles, quotaWeakening } = state;
  const quiet = bundles.filter(isQuietlySaved);
  const loud = bundles.filter((b) => !isQuietlySaved(b));
  const loudGroups = groupBySupervisor(loud);
  const quietGroups = groupBySupervisor(quiet);
  const loudFileCount = loud.reduce((n, b) => n + b.members.length, 0);

  if (bundles.length === 0) {
    return (
      <div className="sc-root" data-testid="save-card">
        {header}
        <div className="sc-state" data-testid="save-card-empty">
          <div className="sc-state-title">Nothing to save</div>
          <div className="sc-state-body">
            No uncommitted work was found in this workspace — the tree is clean, or every change is already
            captured. Your progress is safe.
          </div>
          <div className="sc-actions">
            <button
              type="button"
              className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px]"
              data-testid="save-card-retry"
              onClick={refresh}
            >
              Refresh
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sc-root" data-testid="save-card">
      {header}

      <QuotaWeakeningBanner warning={quotaWeakening} />

      <ExpiryBlock bundles={bundles} workspaceId={workspaceId ?? null} />

      <div className="sc-sect">
        <h2>Unsaved work</h2>
        <span className="sc-rule" />
        <span className="sc-count" data-testid="save-card-unsaved-count">
          {loudGroups.length} package{loudGroups.length === 1 ? '' : 's'} · {loudFileCount} file{loudFileCount === 1 ? '' : 's'}
        </span>
      </div>
      {loud.length > 0 ? (
        <div className="sc-slots">
          {loudGroups.map((group) => (
            <div key={group[0].identity?.groupingKey ?? group[0].bundleId} className="sc-slot-wrap">
              {/* workspaceId is non-null here: the ready state is only reached
                  after a successful load, which requires a selected workspace. */}
              <PackageSaveGesture group={group} workspaceId={workspaceId!} />
            </div>
          ))}
        </div>
      ) : (
        <p className="sc-meta" data-testid="save-card-none-loud" style={{ marginBottom: 30 }}>
          No unsaved packages — everything witnessed is already protected below.
        </p>
      )}

      {quiet.length > 0 && (
        <>
          <div className="sc-sect">
            <h2>Already protected</h2>
            <span className="sc-rule" />
            <span className="sc-count">recent only</span>
          </div>
          <div className="sc-saved" data-testid="save-card-quiet">
            {quietGroups.map((group) => {
              const b = group[0];
              return <div className="sc-savedrow" key={b.identity?.groupingKey ?? b.bundleId} data-testid="save-card-quiet-row">
                <span className="sc-tick">✓</span>
                <span className="sc-t">
                  <b>{b.label}</b>
                  {b.workspaces.length > 1 ? ` · ${b.workspaces.length} workspaces` : ''}
                </span>
                <span className="sc-savedrung">
                  {b.weakestProtection === 'remote-reachable' ? 'on origin' : 'committed'}
                </span>
              </div>;
            })}
          </div>
        </>
      )}

      <div className="sc-keyline">
        <b>Exact-byte saves.</b> Pin freezes the package boundary; Submit creates and commits a fresh candidate.
        If those bytes moved, Lares refuses and asks you to inspect or re-pin instead of guessing.
      </div>
    </div>
  );
}
