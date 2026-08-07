import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import {
  isSaveCardInventoryFresh,
  useSaveCardStore,
  useSaveCardAttention,
} from '../../stores/save-card-store';
import type {
  SaveCardFleetAdhocMarkDoneResponse,
  SaveCardFleetAdhocMarkDoneSuccess,
  SaveCardInventoryResponse,
  SaveSweepTerminalResult,
} from '../../../shared/types';
import type { SaveCardQuotaWeakening, SaveRefusal } from '../../../shared/commit-candidates';
import SaveBundle, { isQuietlySaved, type WorkBundleDto } from './SaveBundle';
import CandidatePreview, {
  type CandidatePreviewDraft,
  type CandidatePreviewSelection,
} from './CandidatePreview';
import QuotaWeakeningBanner from './QuotaWeakeningBanner';
import { groupExpiryEdgesByBundle, formatExpiresIn } from './save-card-expiry';
import { renderSaveRefusal } from './save-refusal-copy';
import { createCandidateSubmitter } from './candidate-submit';
import { initialSaveGestureState, saveGestureReducer } from './save-gesture-state';
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

function selectionForPins(pins: SaveCardFleetAdhocMarkDoneSuccess[]): CandidatePreviewSelection {
  return {
    selectedComponentIds: [...new Set(pins.flatMap((pin) => pin.pinnedSelection.selectedComponentIds))],
    selectedUnattributedEntryIds: [
      ...new Set(pins.flatMap((pin) => pin.pinnedSelection.selectedUnattributedEntryIds)),
    ],
    finalizationIds: pins.filter((pin) => pin.boundaryStatus === 'ready').map((pin) => pin.finalizationId),
  };
}

/**
 * SC-WP-3H — the per-package "Save…" affordance. Toggles the read-only candidate
 * preview pane in place beneath the bundle card. Kept in SaveCard (not SaveBundle)
 * so the Stage ① read-only bundle card stays untouched. The pane itself decides
 * whether a one-click save is offered (never for mismatch/degraded/unfinalized).
 */
function terminalResultText(result: SaveSweepTerminalResult): string {
  switch (result.kind) {
    case 'saved':
      return `saved — commit ${result.commitOid} (attempt ${result.attemptId})`;
    case 'already-saved':
      return `already-saved — proven by ${result.provingCommitOids.join(', ')}`;
    case 'needs-attention':
      return `needs-attention — ${result.message} (${result.code})`;
    case 'blocked-unmerged':
      return 'blocked-unmerged';
    case 'not-attempted':
      return `not-attempted — sweep halted after ${result.haltedAfterFinalizationId}`;
    case 'halted-uncertain': {
      const evidence = [
        result.attemptId ? `attempt ${result.attemptId}` : null,
        result.commitOid ? `commit ${result.commitOid}` : null,
      ].filter(Boolean).join(', ');
      return `halted-uncertain — ${result.message} (${result.code})${evidence ? ` — ${evidence}` : ''}. A commit may have been created; Lares will not retry automatically.`;
    }
  }
}

function PackageSaveGesture({
  group,
  workspaceId,
}: {
  group: WorkBundleDto[];
  workspaceId: string;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [gesture, dispatch] = useReducer(saveGestureReducer, initialSaveGestureState);
  const draftRef = useRef<CandidatePreviewDraft | null>(null);
  const submitterRef = useRef<ReturnType<typeof createCandidateSubmitter> | null>(null);
  if (!submitterRef.current) submitterRef.current = createCandidateSubmitter();
  const updateDraft = useCallback((nextDraft: CandidatePreviewDraft) => {
    draftRef.current = nextDraft;
    dispatch({ type: 'draft-updated', draft: nextDraft });
  }, []);
  const { pins, draft } = gesture;
  const finalizationIds = pins
    .filter((pin) => pin.boundaryStatus === 'ready')
    .map((pin) => pin.finalizationId);
  const pinned = pins.length === group.length && finalizationIds.length === group.length;
  const selection = React.useMemo(
    () => pins.length > 0 ? selectionForPins(pins) : selectionForGroup(group, finalizationIds),
    [group.map((bundle) => bundle.bundleId).join('\0'), pins],
  );
  const hasSelectable =
    selection.selectedComponentIds.length > 0 || selection.selectedUnattributedEntryIds.length > 0;
  if (!hasSelectable) return null;

  const pinPackage = async (replaceExisting = false) => {
    if (gesture.status === 'pinning' || gesture.status === 'reviewing'
      || gesture.status === 'sweeping') return;
    const unsaveable = group.find((bundle) => bundle.saveability?.saveable === false);
    if (unsaveable?.saveability?.saveable === false) {
      dispatch({
        type: 'refused',
        refusal: unsaveable.saveability.refusal ?? {
          stage: 'saveability',
          code: 'save-card-no-repository',
          message: `This package cannot be saved from workspace '${unsaveable.saveability.workspaceTitle}'.`,
        },
      });
      return;
    }
    const retained = replaceExisting ? [] : pins;
    const pinnedPackages = new Set(retained.map((pin) => pin.packageId));
    const missing = group.filter((bundle) => !pinnedPackages.has(bundle.bundleId));
    if (missing.length === 0) return;
    dispatch({ type: 'pin-started' });
    const settled = await Promise.allSettled(missing.map((bundle) =>
      window.api.saveCard.markDone({ packageId: bundle.bundleId, targetWorkspaceId: workspaceId }),
    ));
    const nextPins = [...retained];
    const failures: Array<{ packageId: string; refusal: SaveRefusal }> = [];
    settled.forEach((result, index) => {
      const packageId = missing[index].bundleId;
      if (result.status === 'rejected') {
        failures.push({
          packageId,
          refusal: {
            stage: 'boundary-capture', code: 'boundary-capture-failed',
            message: `Boundary-capture stage failed for package ${packageId}: ${errorMessage(result.reason)}`,
            paths: [packageId],
          },
        });
        return;
      }
      const response: SaveCardFleetAdhocMarkDoneResponse = result.value;
      if ('ok' in response && response.ok === false) {
        failures.push({
          packageId,
          refusal: {
            stage: response.stage ?? 'boundary-capture', code: response.code,
            message: `${response.message} (package ${packageId})`, paths: [packageId],
          },
        });
        return;
      }
      nextPins.push(response);
      if (response.boundaryStatus !== 'ready') {
        failures.push({
          packageId,
          refusal: response.refusal ?? {
            stage: 'freeze', code: 'freeze-boundary-unavailable',
            message: `Freeze stage refused for package ${packageId} because its boundary is not ready.`,
            paths: [packageId],
          },
        });
      }
    });
    const uniquePins = [...new Map(nextPins.map((pin) => [pin.packageId, pin])).values()];
    const complete = uniquePins.length === group.length
      && uniquePins.every((pin) => pin.boundaryStatus === 'ready');
    dispatch({ type: 'pins-updated', pins: uniquePins, complete });
    if (failures.length > 0) {
      const failed = failures[0];
      dispatch({
        type: 'refused',
        refusal: {
          ...failed.refusal,
          message: failures.length === 1
            ? failed.refusal.message
            : `${failed.refusal.message} Failed packages: ${failures.map((item) => item.packageId).join(', ')}.`,
          paths: failures.map((item) => item.packageId),
        },
      });
    }
  };

  const submit = async () => {
    if (!pinned) return;
    const result = await submitterRef.current!.submit({
      workspaceId, selection, draft: draftRef.current ?? draft,
      onStage: (stage) => dispatch({ type: 'submit-stage', stage }),
      onTransition: (event) => {
        void window.api.demandProbe.record({ workspaceId, kind: `save_${event}` }).catch(() => {});
      },
    });
    if (result.kind === 'completed') {
      dispatch({ type: 'completed', outcome: result.response });
      setDetailsOpen(false);
    } else if (result.kind === 'uncertain') {
      dispatch({ type: 'uncertain', ...result });
    } else if (result.kind === 'refused') {
      dispatch({
        type: 'refused', refusal: result.refusal,
        latestPreview: result.preview ?? null,
      });
      setDetailsOpen(true);
    }
  };
  const submitting = gesture.status === 'reviewing' || gesture.status === 'sweeping';
  const submitLocked = submitting || gesture.status === 'uncertain' || gesture.status === 'completed';
  const gestureError = gesture.status === 'refused'
    ? renderSaveRefusal(gesture.refusal)
    : gesture.status === 'uncertain' ? 'Lares could not confirm whether this package was saved.' : null;
  const movedPaths = gesture.status === 'refused' ? gesture.refusal.paths ?? [] : [];
  const recover = () => {
    void pinPackage(true);
  };
  return (
    <div className="sc-save-launcher">
      <SaveBundle
        bundle={group[0]}
        bundles={group}
        pinned={pinned}
        pinning={gesture.status === 'pinning'}
        onPin={() => { void pinPackage(); }}
      />
      <button
        type="button"
        className="ui-btn ui-btn-primary px-3 py-1 text-[12.5px]"
        data-testid="save-bundle-submit"
        disabled={!pinned || submitLocked}
        onClick={() => { void submit(); }}
      >
        {submitting ? 'Saving…' : 'Save package'}
      </button>
      <button
        type="button"
        className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px]"
        data-testid="save-bundle-details-toggle"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        {detailsOpen ? 'Hide review & message' : 'Review & message'}
      </button>
      {gesture.status === 'pinning' && <div className="sc-save-note" role="status">Preparing reviewed work…</div>}
      {gestureError && (
        <div className="sc-save-refusal" role="alert" data-testid="save-gesture-refusal">
          {gestureError}
          {movedPaths.length > 0 && (
            <div className="sc-save-diff" data-testid="save-gesture-diff">
              <strong>Changed work</strong>
              {movedPaths.length > 0
                ? <ul>{movedPaths.map((path) => <li key={path}>{path}</li>)}</ul>
                : null}
            </div>
          )}
          {gesture.status === 'refused' && <button
            type="button"
            className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px] sc-repin"
            data-testid="save-bundle-repin"
            onClick={recover}
          >
            Refresh package
          </button>}
        </div>
      )}
      {detailsOpen && pinned && (
        <CandidatePreview
          key={finalizationIds.join(':')}
          workspaceId={workspaceId}
          selection={selection}
          showCommitAction={false}
          authoritativeResponse={gesture.status === 'refused' ? (gesture.latestPreview ?? null) : null}
          onDraftChange={updateDraft}
          onClose={() => setDetailsOpen(false)}
        />
      )}
      {gesture.status === 'completed' && (
        <div className="sc-save-note" data-testid="save-sweep-results">
          <ul>
            {gesture.outcome.results.map((result) => (
              <li
                key={`${result.repositoryKey}\0${result.finalizationId}`}
                data-testid="save-sweep-terminal-result"
                data-kind={result.kind}
              >
                <strong>{result.packageId}</strong>: {terminalResultText(result)}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px]"
            onClick={() => dispatch({ type: 'acknowledged' })}
          >
            Dismiss results
          </button>
        </div>
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
  return 'Lares could not load save progress.';
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
          <>Workspace <b>{workspace.title}</b> · review and save exact packages of work</>
        ) : (
          <>Review and save exact packages of work</>
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
            Nothing was written, so try again once this workspace is ready.
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
        <b>Exact-byte saves.</b> Lares saves the work you reviewed and asks you to refresh if it changes.
      </div>
    </div>
  );
}
