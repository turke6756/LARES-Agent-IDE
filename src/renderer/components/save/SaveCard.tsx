import React, { useCallback, useEffect, useState } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { SaveCardInventoryResponse } from '../../../shared/types';
import SaveBundle, { isQuietlySaved, type WorkBundleDto } from './SaveBundle';
import './save-card.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; bundles: WorkBundleDto[] };

// Turn whatever the rejected getInventory invoke throws into a single honest
// line. The Stage ① engine may be unavailable (route not yet injected), the
// workspace may be a non-repo / unborn HEAD, or the read may have failed — all
// surface as an explicit unavailable state, never a fabricated empty tree.
function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'The Save engine could not be reached.';
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

  const load = useCallback(
    async (wsId: string, isCurrent: () => boolean) => {
      setState({ status: 'loading' });
      try {
        const bundles: SaveCardInventoryResponse = await window.api.saveCard.getInventory({
          workspaceId: wsId,
        });
        if (isCurrent()) setState({ status: 'ready', bundles });
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
      <h1 className="sc-h1">Save Progress</h1>
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

  const { bundles } = state;
  const quiet = bundles.filter(isQuietlySaved);
  const loud = bundles.filter((b) => !isQuietlySaved(b));
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

      <div className="sc-sect">
        <h2>Unsaved work</h2>
        <span className="sc-rule" />
        <span className="sc-count" data-testid="save-card-unsaved-count">
          {loud.length} package{loud.length === 1 ? '' : 's'} · {loudFileCount} file{loudFileCount === 1 ? '' : 's'}
        </span>
      </div>
      {loud.length > 0 ? (
        <div className="sc-slots">
          {loud.map((b) => (
            <SaveBundle key={b.bundleId} bundle={b} />
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
            {quiet.map((b) => (
              <div className="sc-savedrow" key={b.bundleId} data-testid="save-card-quiet-row">
                <span className="sc-tick">✓</span>
                <span className="sc-t">
                  <b>{b.label}</b>
                  {b.workspaces.length > 1 ? ` · ${b.workspaces.length} workspaces` : ''}
                </span>
                <span className="sc-savedrung">
                  {b.weakestProtection === 'remote-reachable' ? 'on origin' : 'committed'}
                </span>
              </div>
            ))}
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
