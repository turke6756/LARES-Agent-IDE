import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { SaveCardInventoryResponse } from '../../../shared/types';
import type { SaveCardQuotaWeakening } from '../../../shared/commit-candidates';
import SaveBundle, { isQuietlySaved, type WorkBundleDto } from './SaveBundle';
import CandidatePreview, { type CandidatePreviewSelection } from './CandidatePreview';
import QuotaWeakeningBanner from './QuotaWeakeningBanner';
import './save-card.css';

// SC-WP-3H — derive the explicit WP-3G selection for a displayed group of
// bundles. Component bundles contribute their whole component (atomic);
// unattributed bundles contribute their member entries as independent atoms. The
// bundle DTO carries no finalization coverage yet, so `finalizationIds` is empty
// — the preview is a `SelectionPreview` (previewable, never one-click) until a
// later stage surfaces the covering finalizations.
function selectionForGroup(group: WorkBundleDto[]): CandidatePreviewSelection {
  const selectedComponentIds = group
    .filter((bundle) => bundle.kind === 'component' && bundle.component)
    .map((bundle) => bundle.component!.componentId);
  const selectedUnattributedEntryIds = group
    .filter((bundle) => bundle.kind === 'unattributed')
    .flatMap((bundle) => bundle.members.map((member) => member.entry.entryId));
  return { selectedComponentIds, selectedUnattributedEntryIds, finalizationIds: [] };
}

/**
 * SC-WP-3H — the per-package "Save…" affordance. Toggles the read-only candidate
 * preview pane in place beneath the bundle card. Kept in SaveCard (not SaveBundle)
 * so the Stage ① read-only bundle card stays untouched. The pane itself decides
 * whether a one-click save is offered (never for mismatch/degraded/unfinalized).
 */
function SavePreviewLauncher({
  group,
  workspaceId,
}: {
  group: WorkBundleDto[];
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const selection = selectionForGroup(group);
  const hasSelectable =
    selection.selectedComponentIds.length > 0 || selection.selectedUnattributedEntryIds.length > 0;
  if (!hasSelectable) return null;
  return (
    <div className="sc-save-launcher">
      <button
        type="button"
        className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px]"
        data-testid="save-bundle-save"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide save preview' : 'Save…'}
      </button>
      {open && (
        <CandidatePreview
          workspaceId={workspaceId}
          selection={selection}
          onClose={() => setOpen(false)}
        />
      )}
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
  const [state, setState] = useState<LoadState>({ status: 'loading' });
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
    async (wsId: string, isCurrent: () => boolean) => {
      setState({ status: 'loading' });
      try {
        const response: SaveCardInventoryResponse = await window.api.saveCard.getInventory({
          workspaceId: wsId,
        });
        if (isCurrent()) {
          setState({
            status: 'ready',
            bundles: response.bundles,
            quotaWeakening: response.quotaWeakening,
          });
        }
      } catch (err) {
        if (isCurrent()) setState({ status: 'error', message: errorMessage(err) });
      }
    },
    [],
  );

  useEffect(() => {
    if (!workspaceId) {
      setState({ status: 'error', message: 'Select a workspace to inspect its save progress.' });
      return;
    }
    let active = true;
    void load(workspaceId, () => active);
    return () => {
      active = false;
    };
  }, [workspaceId, load]);

  const refresh = useCallback(() => {
    if (!workspaceId) return;
    let active = true;
    void load(workspaceId, () => active);
  }, [workspaceId, load]);

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
          <>Workspace <b>{workspace.title}</b> · read-only inspection of uncommitted work</>
        ) : (
          <>Read-only inspection of uncommitted work</>
        )}
      </p>
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
              <SaveBundle bundle={group[0]} bundles={group} />
              {/* workspaceId is non-null here: the ready state is only reached
                  after a successful load, which requires a selected workspace. */}
              <SavePreviewLauncher group={group} workspaceId={workspaceId!} />
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
        <b>Read-only.</b> This surface inspects your uncommitted work and how well it is protected — it makes
        no change and no claim that inspection has made anything safer. Saving, pushing, and restore are later
        stages.
      </div>
    </div>
  );
}
