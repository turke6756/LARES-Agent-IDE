import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
} from 'react';
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
  SaveIntentUnitDto,
  SaveSweepIntent,
  SaveSweepResponse,
  SaveSweepTerminalResult,
} from '../../../shared/types';
import type {
  ReviewChallengeAtom,
  SaveCardQuotaWeakening,
  SaveRefusal,
} from '../../../shared/commit-candidates';
import SaveBundle from './SaveBundle';
import CandidatePreview, {
  type CandidatePreviewDraft,
  type CandidatePreviewSelection,
} from './CandidatePreview';
import QuotaWeakeningBanner from './QuotaWeakeningBanner';
import PlanMergeBack from './PlanMergeBack';
import { groupExpiryEdgesByIntentUnit, formatExpiresIn } from './save-card-expiry';
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
function selectionForIntent(
  unit: SaveIntentUnitDto,
  finalizationIds: string[] = [],
): CandidatePreviewSelection {
  return {
    selectedComponentIds: [...unit.topologyEvidence.componentIds],
    selectedUnattributedEntryIds: unit.kind === 'named-save-set'
      ? unit.members.map((member) => member.entry.entryId)
      : [],
    finalizationIds,
    selectedIntentIds: unit.kind === 'task' ? [unit.intentId] : [],
    selectedNamedSaveSetIds: unit.kind === 'named-save-set' ? [unit.intentId] : [],
    resolutionIds: unit.concurrencyCases.flatMap(() => []),
  };
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

interface PreparedSweepPackage {
  intents: SaveSweepIntent[];
  reviewedManifestDigest: string;
  acknowledgedChallengeAtoms: ReviewChallengeAtom[];
}

interface PackageSaveGestureHandle {
  prepareForSweep: () => Promise<PreparedSweepPackage | null>;
  showSweepStarted: () => void;
  clearSweepState: () => void;
  showSweepUncertain: () => void;
}

function sweepSummary(results: readonly SaveSweepTerminalResult[], halted: boolean) {
  return {
    saved: results.filter((result) => result.kind === 'saved').length,
    alreadySaved: results.filter((result) => result.kind === 'already-saved').length,
    needsAttention: results.filter((result) =>
      result.kind === 'needs-attention' || result.kind === 'blocked-unmerged',
    ).length,
    halted,
  };
}

const PackageSaveGesture = forwardRef<PackageSaveGestureHandle, {
  unit: SaveIntentUnitDto;
  workspaceId: string;
}>(({
  unit,
  workspaceId,
}, ref) => {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [gesture, dispatch] = useReducer(saveGestureReducer, initialSaveGestureState);
  const draftRef = useRef<CandidatePreviewDraft | null>(null);
  const submitterRef = useRef<ReturnType<typeof createCandidateSubmitter> | null>(null);
  const prepareInFlightRef = useRef<Promise<PreparedSweepPackage | null> | null>(null);
  const pinInFlightRef = useRef(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  if (!submitterRef.current) submitterRef.current = createCandidateSubmitter();
  const updateDraft = useCallback((nextDraft: CandidatePreviewDraft) => {
    draftRef.current = nextDraft;
    dispatch({ type: 'draft-updated', draft: nextDraft });
  }, []);
  const { pins, draft } = gesture;
  const finalizationIds = pins
    .filter((pin) => pin.boundaryStatus === 'ready')
    .map((pin) => pin.finalizationId);
  const pinned = pins.length === 1 && finalizationIds.length === 1;
  const selection = React.useMemo(
    () => pins.length > 0 ? { ...selectionForIntent(unit, finalizationIds), ...selectionForPins(pins) }
      : selectionForIntent(unit, finalizationIds),
    [unit.intentId, unit.topologyEvidence.componentIds.join('\0'), pins],
  );
  const hasSelectable =
    selection.selectedComponentIds.length > 0 || selection.selectedUnattributedEntryIds.length > 0;

  const pinPackage = async (
    replaceExisting = false,
  ): Promise<SaveCardFleetAdhocMarkDoneSuccess[] | null> => {
    if (pinInFlightRef.current || gesture.status === 'pinning' || gesture.status === 'reviewing'
      || gesture.status === 'sweeping') return null;
    const unsaveable = unit.saveability.saveable === false ? unit : null;
    if (unsaveable?.saveability.saveable === false) {
      dispatch({
        type: 'refused',
        refusal: unsaveable.saveability.refusal ?? {
          stage: 'saveability',
          code: 'save-card-no-repository',
          message: `This package cannot be saved from workspace '${unsaveable.saveability.workspaceTitle}'.`,
        },
      });
      return null;
    }
    const retained = replaceExisting ? [] : pins;
    const pinnedPackages = new Set(retained.map((pin) => pin.packageId));
    const missing = pinnedPackages.has(unit.intentId) ? [] : [unit];
    if (missing.length === 0) return retained;
    pinInFlightRef.current = true;
    dispatch({ type: 'pin-started' });
    const settled = await Promise.allSettled(missing.map((bundle) =>
      window.api.saveCard.markDone({ packageId: bundle.intentId, targetWorkspaceId: workspaceId }),
    ));
    const nextPins = [...retained];
    const failures: Array<{ packageId: string; refusal: SaveRefusal }> = [];
    settled.forEach((result, index) => {
      const packageId = missing[index].intentId;
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
      const successful = response as SaveCardFleetAdhocMarkDoneSuccess;
      nextPins.push(successful);
      if (successful.boundaryStatus !== 'ready') {
        failures.push({
          packageId,
          refusal: successful.refusal ?? {
            stage: 'freeze', code: 'freeze-boundary-unavailable',
            message: `Freeze stage refused for package ${packageId} because its boundary is not ready.`,
            paths: [packageId],
          },
        });
      }
    });
    const uniquePins = [...new Map(nextPins.map((pin) => [pin.packageId, pin])).values()];
    const complete = uniquePins.length === 1
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
      pinInFlightRef.current = false;
      return null;
    }
    pinInFlightRef.current = false;
    return complete ? uniquePins : null;
  };

  const packageName = unit.title;

  useImperativeHandle(ref, () => ({
    prepareForSweep: () => {
      if (prepareInFlightRef.current) return prepareInFlightRef.current;
      const run = (async (): Promise<PreparedSweepPackage | null> => {
        const preparedPins = pinned ? pins : await pinPackage();
        if (!preparedPins) return null;
        const preparedSelection = selectionForPins(preparedPins);
        dispatch({ type: 'submit-stage', stage: 'reviewing' });
        let response;
        try {
          response = await window.api.saveCard.preview({ workspaceId, ...preparedSelection });
        } catch {
          dispatch({
            type: 'refused',
            refusal: {
              stage: 'preview-verify',
              code: 'preview-transport-failed',
              message: `Lares could not verify ${packageName} before the sweep.`,
            },
          });
          return null;
        }
        if (response.refusal || !response.isCandidate || !('repository' in response.candidate)
            || !response.candidate.eligibility.eligible) {
          dispatch({
            type: 'refused',
            refusal: response.refusal ?? {
              stage: 'preview-verify',
              code: 'preview-ineligible',
              message: `${packageName} needs attention before it can be saved.`,
            },
            latestPreview: response,
          });
          return null;
        }
        const repositoryKey = response.candidate.repository.repositoryKey;
        const reviewedManifestDigest = response.reviewedManifest?.reviewedManifestDigest;
        const durableIntents = response.durableFinalizationIntent;
        if (!reviewedManifestDigest || !durableIntents?.length) {
          dispatch({
            type: 'refused',
            refusal: {
              stage: 'preview-verify',
              code: 'review-evidence-missing',
              message: `${packageName} did not return the review evidence required to save it.`,
            },
            latestPreview: response,
          });
          return null;
        }
        const currentDraft = draftRef.current ?? draft;
        const messageBody = currentDraft?.messageBody ?? response.defaultMessageBody;
        const userTrailers = currentDraft?.userTrailers.trim() ?? '';
        const message = userTrailers ? `${messageBody.trimEnd()}\n\n${userTrailers}` : messageBody;
        return {
          intents: durableIntents.map((intent) => ({
            repositoryKey,
            finalizationId: intent.finalizationId,
            packageId: intent.packageId,
            packageRevision: intent.packageRevision,
            frozenMemberManifestDigest: intent.frozenMemberManifestDigest,
            reviewedManifestDigest,
            message,
          })),
          reviewedManifestDigest,
          // Only echo atoms selected in the package review UI. The master gesture
          // never creates acknowledgement evidence of its own.
          acknowledgedChallengeAtoms: currentDraft?.acknowledgedChallengeAtoms ?? [],
        };
      })().finally(() => { prepareInFlightRef.current = null; });
      prepareInFlightRef.current = run;
      return run;
    },
    showSweepStarted: () => dispatch({ type: 'submit-stage', stage: 'sweeping' }),
    clearSweepState: () => dispatch({ type: 'acknowledged' }),
    showSweepUncertain: () => dispatch({
      type: 'uncertain',
      stage: 'commit',
      code: 'repository-outcome-uncertain',
      message: 'The save-all outcome is uncertain. Lares will not retry automatically.',
    }),
  }), [draft, unit, packageName, pinned, pins, workspaceId]);

  if (!hasSelectable) return null;

  const submit = async () => {
    if (!pinned) return;
    const result = await submitterRef.current!.submit({
      workspaceId, selection, draft: draftRef.current ?? draft,
      onStage: (stage) => dispatch({ type: 'submit-stage', stage }),
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
        unit={unit}
        pinned={pinned}
        pinning={gesture.status === 'pinning' || gesture.status === 'reviewing' || previewBusy}
        onPin={() => { void pinPackage(); }}
      />
      <button
        type="button"
        className="ui-btn ui-btn-primary px-3 py-1 text-[12.5px]"
        data-testid="save-bundle-submit"
        disabled={!pinned || submitLocked}
        aria-busy={submitting}
        onClick={() => { void submit(); }}
      >
        {gesture.status === 'reviewing'
          ? 'Verifying…'
          : gesture.status === 'sweeping'
            ? `Saving ${packageName}…`
            : 'Save package'}
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
      {(gesture.status === 'pinning' || gesture.status === 'reviewing' || gesture.status === 'sweeping') && (
        <div className="sc-save-note" role="status" data-testid="save-package-progress">
          {gesture.status === 'pinning'
            ? `Preparing ${packageName}…`
            : gesture.status === 'reviewing'
              ? `Verifying ${packageName}…`
              : `Saving ${packageName}…`}
        </div>
      )}
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
          onBusyChange={setPreviewBusy}
          onCrossIntentResolution={(atom, resolution) =>
            window.api.saveCard.resolveAttribution({ workspaceId, atom, resolution }).then(() => undefined)}
          onClose={() => setDetailsOpen(false)}
        />
      )}
      {gesture.status === 'completed' && (() => {
        const summary = sweepSummary(gesture.outcome.results, gesture.outcome.halted);
        return (
        <div className="sc-save-note" data-testid="save-sweep-results">
          <div role="status" data-testid="save-sweep-summary">
            Saved {summary.saved} · already saved {summary.alreadySaved} · needs attention {summary.needsAttention} · halted {summary.halted ? 'yes' : 'no'}
          </div>
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
        );
      })()}
    </div>
  );
});
PackageSaveGesture.displayName = 'PackageSaveGesture';

/**
 * SC-WP-N2 — the checkpoint-expiry block. Groups the retention pass's expiring
 * recovery edges onto the displayed bundles (by intersecting `affectedEntryIds`
 * with each bundle's member entry ids) so the "expiring soon" warning lands on the
 * exact package holding the work. Renders nothing when no bundle is affected — the
 * signal is truthful (it comes from the real retained-pin selection, never a
 * renderer-side re-derivation from turn age).
 */
function ExpiryBlock({
  intentUnits,
  workspaceId,
}: {
  intentUnits: SaveIntentUnitDto[];
  workspaceId: string | null;
}) {
  const notice = useSaveCardAttention(workspaceId);
  const grouped = groupExpiryEdgesByIntentUnit(notice, intentUnits);
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
        {grouped.map(({ unit, earliestExpiresAt }) => (
          <li key={unit.intentId} data-testid="save-card-expiry-row">
            <b>{unit.title}</b>
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
  | {
      status: 'ready';
      intentUnits: SaveIntentUnitDto[];
      unwitnessed: SaveCardInventoryResponse['unwitnessed'];
      legacyTaskIdentityUnavailable: SaveCardInventoryResponse['legacyTaskIdentityUnavailable'];
      legacyFinalizations: SaveCardInventoryResponse['legacyFinalizations'];
      planningActivities: SaveCardInventoryResponse['planningActivities'];
      quotaWeakening: SaveCardQuotaWeakening | null;
    };

type SaveAllState =
  | { status: 'idle' }
  | { status: 'preparing'; currentPackage: string; current: number; total: number }
  | { status: 'sweeping'; currentPackage: string; total: number }
  | {
      status: 'completed';
      response: SaveSweepResponse;
      localNeedsAttention: number;
    }
  | { status: 'uncertain'; currentPackage: string; localNeedsAttention: number };

// Turn whatever the rejected getInventory invoke throws into a single honest
// line. The Stage ① engine may be unavailable (route not yet injected), the
// workspace may be a non-repo / unborn HEAD, or the read may have failed — all
// surface as an explicit unavailable state, never a fabricated empty tree.
function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Lares could not load save progress.';
}

/**
 * SaveCard — the read-only Save-progress center surface (SC-WP-1I).
 *
 * Fetches the repository inventory for the selected workspace via the single
 * read-only `saveCard.getInventory` channel and renders the intent-unit DTOs the
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
          intentUnits: cached.inventory.intentUnits,
          unwitnessed: cached.inventory.unwitnessed,
          legacyTaskIdentityUnavailable: cached.inventory.legacyTaskIdentityUnavailable,
          legacyFinalizations: cached.inventory.legacyFinalizations,
          planningActivities: cached.inventory.planningActivities,
          quotaWeakening: cached.inventory.quotaWeakening,
        }
      : { status: 'loading' },
  );
  const [refreshing, setRefreshing] = useState(false);
  const [saveAll, setSaveAll] = useState<SaveAllState>({ status: 'idle' });
  const saveAllInFlightRef = useRef(false);
  const packageGestureRefs = useRef(new Map<string, PackageSaveGestureHandle>());
  const [infoOpen, setInfoOpen] = useState(false);
  const [adoptingBaseline, setAdoptingBaseline] = useState(false);
  const [baselineResult, setBaselineResult] = useState<string | null>(null);
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
            intentUnits: response.intentUnits,
            unwitnessed: response.unwitnessed,
            legacyTaskIdentityUnavailable: response.legacyTaskIdentityUnavailable,
            legacyFinalizations: response.legacyFinalizations,
            planningActivities: response.planningActivities,
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
        intentUnits: cached.inventory.intentUnits,
        unwitnessed: cached.inventory.unwitnessed,
        legacyTaskIdentityUnavailable: cached.inventory.legacyTaskIdentityUnavailable,
        legacyFinalizations: cached.inventory.legacyFinalizations,
        planningActivities: cached.inventory.planningActivities,
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

  const { intentUnits, unwitnessed, legacyTaskIdentityUnavailable, legacyFinalizations, planningActivities, quotaWeakening } = state;
  const loud = intentUnits.filter((unit) => unit.state !== 'committed' && unit.state !== 'superseded');
  const loudFileCount = loud.reduce((n, unit) => n + unit.members.length, 0);
  const saveableUnits = loud.filter((unit) => unit.saveability.saveable);

  const startSaveAll = async () => {
    if (!workspaceId || saveAllInFlightRef.current || saveAll.status !== 'idle') return;
    saveAllInFlightRef.current = true;
    const prepared: Array<{
      unit: SaveIntentUnitDto;
      handle: PackageSaveGestureHandle;
      request: PreparedSweepPackage;
    }> = [];
    let localNeedsAttention = 0;
    try {
      for (let index = 0; index < saveableUnits.length; index += 1) {
        const unit = saveableUnits[index];
        const handle = packageGestureRefs.current.get(unit.intentId);
        setSaveAll({
          status: 'preparing',
          currentPackage: unit.title,
          current: index + 1,
          total: saveableUnits.length,
        });
        if (!handle) {
          localNeedsAttention += 1;
          continue;
        }
        const request = await handle.prepareForSweep();
        if (request) prepared.push({ unit, handle, request });
        else localNeedsAttention += 1;
      }

      if (prepared.length === 0) {
        setSaveAll({
          status: 'completed',
          response: { results: [], halted: false, haltKind: null },
          localNeedsAttention,
        });
        return;
      }

      prepared.forEach(({ handle }) => handle.showSweepStarted());
      setSaveAll({
        status: 'sweeping',
        currentPackage: prepared[0].unit.title,
        total: prepared.length,
      });
      let response: SaveSweepResponse;
      try {
        const acknowledgedByKey = new Map<string, ReviewChallengeAtom>();
        prepared.forEach(({ request }) => request.acknowledgedChallengeAtoms.forEach((atom) => {
          acknowledgedByKey.set(`${atom.atomId}\0${atom.digest}`, atom);
        }));
        response = await window.api.saveCard.sweep({
          intents: prepared.flatMap(({ request }) => request.intents),
          reviewedManifestDigests: [
            ...new Set(prepared.map(({ request }) => request.reviewedManifestDigest)),
          ],
          acknowledgedChallengeAtoms: [...acknowledgedByKey.values()],
        });
      } catch {
        prepared.forEach(({ handle }) => handle.showSweepUncertain());
        setSaveAll({
          status: 'uncertain',
          currentPackage: prepared[0].unit.title,
          localNeedsAttention,
        });
        return;
      }

      if (response.results.some((result) => result.kind === 'halted-uncertain')) {
        prepared.forEach(({ handle }) => handle.showSweepUncertain());
      } else {
        prepared.forEach(({ handle }) => handle.clearSweepState());
      }
      setSaveAll({ status: 'completed', response, localNeedsAttention });
      try {
        await useSaveCardStore.getState().refreshInventory(workspaceId);
      } catch {
        // The server verdict and summary remain authoritative. A normal Refresh
        // can heal presentation without risking a duplicate save.
      }
    } finally {
      saveAllInFlightRef.current = false;
    }
  };

  if (intentUnits.length === 0 && planningActivities.length === 0
      && unwitnessed.length === 0 && legacyTaskIdentityUnavailable.length === 0
      && legacyFinalizations.length === 0) {
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

      {(planningActivities?.length ?? 0) > 0 && (
        <section className="sc-sect" data-testid="planning-activity-cards">
          <h2>Plan activities</h2>
          {planningActivities!.map((activity) => (
            <article key={activity.executionRunId} className="sc-slot-wrap" data-testid="planning-activity-card">
              <strong>{activity.planTitle}</strong>
              <div>
                {activity.status === 'saved-in-plan-promotion-pending' && 'Saved in plan; promotion pending'}
                {activity.status === 'merge-conflicted' && 'Saved in plan; content conflict needs resolution'}
                {activity.status === 'promoted' && 'Promoted to main'}
                {activity.status === 'recovery-required' && 'Recovery required — no work was deleted'}
                {activity.status === 'active' && 'Active plan workspace'}
                {activity.status === 'cleaned' && 'Activity complete and safely cleaned'}
              </div>
              <PlanMergeBack activity={activity} onPromoted={refresh} />
            </article>
          ))}
        </section>
      )}

      {intentUnits !== null && (
        <div data-testid="save-intent-hierarchy">
          {[...new Set(intentUnits.map((unit) => unit.plan?.id ?? 'unplanned'))].map((planId) => {
            const planUnits = intentUnits.filter((unit) => (unit.plan?.id ?? 'unplanned') === planId);
            return (
              <section className="sc-sect" key={planId}>
                <h2>{planUnits[0]?.plan?.title ?? 'Unplanned tasks'}</h2>
                <div>
                  {[...new Set(planUnits.map((unit) => unit.planItem?.id ?? 'unplanned-item'))].map((itemId) => {
                    const itemUnits = planUnits.filter((unit) =>
                      (unit.planItem?.id ?? 'unplanned-item') === itemId);
                    return (
                      <div key={itemId} data-testid="save-intent-plan-item">
                        {itemUnits[0]?.planItem && <h3>{itemUnits[0].planItem.title}</h3>}
                        {itemUnits.map((unit) => (
                          <article key={unit.intentId} data-testid="save-intent-unit">
                            {unit.state === 'committed' || unit.state === 'superseded' ? (
                              <SaveBundle unit={unit} />
                            ) : (
                              <PackageSaveGesture
                                ref={(handle) => {
                                  if (handle) packageGestureRefs.current.set(unit.intentId, handle);
                                  else packageGestureRefs.current.delete(unit.intentId);
                                }}
                                unit={unit}
                                workspaceId={workspaceId!}
                              />
                            )}
                          </article>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {(legacyTaskIdentityUnavailable?.length ?? 0) > 0 && (
            <section className="sc-sect" data-testid="legacy-task-identity-unavailable">
              <h2>Legacy task identity unavailable</h2>
              <span>{legacyTaskIdentityUnavailable!.length} witnessed file{legacyTaskIdentityUnavailable!.length === 1 ? '' : 's'}</span>
            </section>
          )}
          {legacyFinalizations.length > 0 && (
            <section className="sc-sect" data-testid="legacy-package-finalizations">
              <h2>Legacy saved packages</h2>
              <ul>
                {legacyFinalizations.map((item) => (
                  <li key={item.finalizationId}>
                    {item.packageId} · revision {item.packageRevision} · {item.boundaryStatus}
                  </li>
                ))}
              </ul>
              <span>Read-only legacy history</span>
            </section>
          )}
          {(unwitnessed?.length ?? 0) > 0 && (
            <section className="sc-sect" data-testid="unwitnessed-pool">
              <h2>Unwitnessed changes</h2>
              <span>{unwitnessed!.length} file{unwitnessed!.length === 1 ? '' : 's'}</span>
              <button
                type="button"
                className="ui-btn ui-btn-primary px-3 py-1 text-[12.5px]"
                disabled={adoptingBaseline || !workspaceId}
                onClick={() => {
                  if (!workspaceId) return;
                  setAdoptingBaseline(true);
                  void window.api.saveCard.adoptAllAsBaseline({ workspaceId })
                    .then((result) => {
                      setBaselineResult(`${result.title} · ${result.memberCount} files`);
                      refresh();
                    })
                    .finally(() => setAdoptingBaseline(false));
                }}
              >
                {adoptingBaseline ? 'Adopting baseline…' : 'Adopt all as baseline'}
              </button>
              {baselineResult && <div role="status">{baselineResult}</div>}
            </section>
          )}
        </div>
      )}

      <ExpiryBlock intentUnits={intentUnits} workspaceId={workspaceId ?? null} />

      <div className="sc-sect">
        <h2>Unsaved work</h2>
        <span className="sc-rule" />
        <span className="sc-count" data-testid="save-card-unsaved-count">
          {loud.length} package{loud.length === 1 ? '' : 's'} · {loudFileCount} file{loudFileCount === 1 ? '' : 's'}
        </span>
      </div>
      {saveableUnits.length > 0 && (
        <div className="sc-actions">
          <button
            type="button"
            className="ui-btn ui-btn-primary px-3 py-1 text-[12.5px]"
            data-testid="save-all"
            disabled={saveAll.status !== 'idle'}
            aria-busy={saveAll.status === 'preparing' || saveAll.status === 'sweeping'}
            onClick={() => { void startSaveAll(); }}
          >
            {saveAll.status === 'preparing'
              ? 'Preparing packages…'
              : saveAll.status === 'sweeping'
                ? 'Saving packages…'
                : 'Save all packages'}
          </button>
        </div>
      )}
      {(saveAll.status === 'preparing' || saveAll.status === 'sweeping') && (
        <div className="sc-save-note" role="status" data-testid="save-all-progress">
          {saveAll.status === 'preparing'
            ? `Preparing ${saveAll.current} of ${saveAll.total} — current package: ${saveAll.currentPackage}`
            : `Saving ${saveAll.total} package${saveAll.total === 1 ? '' : 's'} — current package: ${saveAll.currentPackage}`}
        </div>
      )}
      {saveAll.status === 'completed' && (() => {
        const summary = sweepSummary(saveAll.response.results, saveAll.response.halted);
        return (
          <div className="sc-save-note" role="status" data-testid="save-all-summary">
            Saved {summary.saved} · already saved {summary.alreadySaved} · needs attention {summary.needsAttention + saveAll.localNeedsAttention} · halted {summary.halted ? 'yes' : 'no'}
          </div>
        );
      })()}
      {saveAll.status === 'uncertain' && (
        <div className="sc-save-refusal" role="alert" data-testid="save-all-summary">
          Saved 0 confirmed · already saved 0 confirmed · needs attention {saveAll.localNeedsAttention} · halted yes. The outcome while saving {saveAll.currentPackage} is uncertain; a commit may have been created, so Lares will not retry automatically.
        </div>
      )}
      {loud.length === 0 && (
        <p className="sc-meta" data-testid="save-card-none-loud" style={{ marginBottom: 30 }}>
          No unsaved packages — everything witnessed is already protected below.
        </p>
      )}

      <div className="sc-keyline">
        <b>Exact-byte saves.</b> Lares saves the work you reviewed and asks you to refresh if it changes.
      </div>
    </div>
  );
}
