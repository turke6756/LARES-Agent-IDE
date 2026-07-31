import React, { useState } from 'react';
import * as Icons from 'lucide-react';
import type { SaveCardInventoryResponse } from '../../../shared/types';
import type { DirtyEntry, ProtectionRung } from '../../../shared/commit-candidates';

// One renderer-safe WorkBundle DTO element (SC-WP-1H transport shape).
export type WorkBundleDto = SaveCardInventoryResponse[number];

const MAX_PATHS_COLLAPSED = 6;

// Human wording for each protection rung — the honest three-rung ledger from
// Amendment 5 (checkpoint-protected → locally-committed → remote-reachable),
// plus the unprotected floor. Read-only: naming state, never a safety claim.
const RUNG_LABEL: Record<ProtectionRung, string> = {
  'unprotected': 'Unprotected',
  'checkpoint-protected': 'Checkpoint only',
  'locally-committed': 'Committed',
  'remote-reachable': 'On origin',
};

// A dirty entry's git status, mapped to the mockup's path coloring. Porcelain-v2
// leaves an unmodified slot as '.', so index status wins when present, else the
// worktree status. Purely presentational.
function pathStatus(entry: DirtyEntry): { cls: string; code: string } {
  if (entry.entryKind === 'untracked') return { cls: 'sc-add', code: 'A' };
  if (entry.entryKind === 'unmerged') return { cls: 'sc-del', code: 'U' };
  const s = entry.indexStatus && entry.indexStatus !== '.' ? entry.indexStatus : entry.worktreeStatus;
  if (s === 'A') return { cls: 'sc-add', code: 'A' };
  if (s === 'D') return { cls: 'sc-del', code: 'D' };
  if (s === 'R' || s === 'C') return { cls: 'sc-mod', code: s };
  return { cls: 'sc-mod', code: 'M' };
}

// Whether this bundle has any capture-health concern worth surfacing: a capture
// outage, a turn whose snapshot failed, or dirty paths with no protection edge.
export function hasCaptureConcern(b: WorkBundleDto): boolean {
  return (
    b.captureHealth.captureOutage ||
    b.captureHealth.pathsWithoutFinalizationEdge.length > 0 ||
    b.captureHealth.turns.some((t) => t.failureClass !== 'none')
  );
}

// A bundle belongs in the quiet "already protected" list when its work is
// witnessed, cleanly captured, and its weakest member is already locally
// committed or reachable on origin. Everything else — unattributed, capture
// gaps, checkpoint-only / unprotected work — stays in the loud unsaved section.
export function isQuietlySaved(b: WorkBundleDto): boolean {
  return (
    b.kind !== 'unattributed' &&
    !hasCaptureConcern(b) &&
    (b.weakestProtection === 'locally-committed' || b.weakestProtection === 'remote-reachable')
  );
}

/**
 * SaveBundle — one work-package card in the read-only Save surface.
 *
 * Renders the DTO the candidate service delivered: a memory-jog description
 * line (who did the work / what it touched), the dirty path list, the honest
 * capture-health flags, and the weakest protection rung. The only CTA is
 * "Inspect", which expands the card in place — Stage ① has NO commit/write
 * affordance of any kind (no writer exists yet).
 */
export default function SaveBundle({ bundle }: { bundle: WorkBundleDto }) {
  const [expanded, setExpanded] = useState(false);

  const isUnattributed = bundle.kind === 'unattributed';
  const captureConcern = hasCaptureConcern(bundle);
  const rung = bundle.weakestProtection;
  const alreadyProtected = rung === 'locally-committed' || rung === 'remote-reachable';

  // Card edge + pill follow the mockup's honest state coloring, derived only
  // from DTO fields: unattributed → ghost; capture concern → held/blocked;
  // already-protected → ready(green); otherwise loud unsaved (blue).
  let slotClass = 'sc-slot';
  let pillClass = 'sc-pill sc-p-live';
  let pillText = 'Unsaved';
  if (isUnattributed) {
    slotClass = 'sc-slot sc-ghost';
    pillClass = 'sc-pill sc-p-ghost';
    pillText = 'No witness';
  } else if (captureConcern) {
    slotClass = 'sc-slot sc-blocked';
    pillClass = 'sc-pill sc-p-warn';
    pillText = 'Capture gap';
  } else if (alreadyProtected) {
    slotClass = 'sc-slot sc-ready';
    pillClass = 'sc-pill sc-p-done';
    pillText = RUNG_LABEL[rung];
  } else if (rung) {
    pillText = RUNG_LABEL[rung];
  }

  const entries = bundle.members.map((m) => m.entry);
  const shownEntries = expanded ? entries : entries.slice(0, MAX_PATHS_COLLAPSED);
  const hiddenCount = entries.length - shownEntries.length;

  // Memory-jog line: role + label + what it touched. The DTO carries the label
  // and any plan associations; we never invent a role description that isn't in
  // the contract.
  const planAssoc = bundle.component?.associations.find((a) => a.planId) ?? null;
  const turnCount = bundle.component
    ? new Set(bundle.component.associations.flatMap((a) => a.contributingTurnIds)).size
    : 0;
  const workspaceCount = bundle.workspaces.length;

  return (
    <div className={slotClass} data-testid="save-bundle" data-bundle-id={bundle.bundleId} data-kind={bundle.kind}>
      <div className="sc-slothead">
        {!isUnattributed && (
          <span className={`sc-check${alreadyProtected ? ' sc-done' : ''}`} aria-hidden="true" />
        )}
        <h2>{bundle.label}</h2>
        <span className={pillClass} data-testid="save-bundle-pill">{pillText}</span>
      </div>

      {isUnattributed ? (
        <p className="sc-meta" data-testid="save-bundle-desc">
          {entries.length} dirty file{entries.length === 1 ? '' : 's'} no agent was seen touching —
          shell side effects, generated files, or a capture gap. Needs a human eye.
        </p>
      ) : (
        <p className="sc-desc" data-testid="save-bundle-desc">
          <span className="sc-k">{planAssoc ? 'From plan' : 'From supervisor unit'}</span>{' '}
          <b>{bundle.label}</b>{' '}
          <span className="sc-k">
            — {entries.length} file{entries.length === 1 ? '' : 's'}
            {turnCount > 0 ? `, ${turnCount} witnessed turn${turnCount === 1 ? '' : 's'}` : ''}
            {workspaceCount > 1 ? `, across ${workspaceCount} workspaces` : ''}.
          </span>
        </p>
      )}

      {bundle.labels.length > 1 && (
        <p className="sc-meta" data-testid="save-bundle-labels">
          Also: {bundle.labels.filter((l) => l !== bundle.label).join(' · ')}
        </p>
      )}

      {entries.length > 0 && (
        <div className="sc-paths" data-testid="save-bundle-paths">
          {shownEntries.map((entry) => {
            const st = pathStatus(entry);
            return (
              <div key={entry.entryId} className={st.cls}>
                {st.code} {entry.path.displayPath}
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <div className="sc-more" data-testid="save-bundle-more">+{hiddenCount} more file{hiddenCount === 1 ? '' : 's'}…</div>
          )}
        </div>
      )}

      {captureConcern && (
        <div className="sc-flag" data-testid="save-bundle-capture">
          <Icons.AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            {bundle.captureHealth.captureOutage
              ? 'Capture outage — some turns in this bundle have no reliable snapshot.'
              : bundle.captureHealth.pathsWithoutFinalizationEdge.length > 0
                ? `${bundle.captureHealth.pathsWithoutFinalizationEdge.length} path(s) have no protection edge — the witnessed union may not cover the tree.`
                : 'Some turn snapshots are degraded — the card cannot vouch this bundle is fully captured.'}
          </span>
        </div>
      )}

      {rung && (
        <div className="sc-protect" data-testid="save-bundle-protection">
          <span>Weakest protection:</span>
          <span className={`sc-rung sc-rung-${rung}`}>{RUNG_LABEL[rung]}</span>
        </div>
      )}

      {expanded && (
        <div className="sc-meta" data-testid="save-bundle-detail" style={{ marginTop: 10 }}>
          Repository <b>{bundle.repositoryKey}</b>
          {bundle.component ? ` · component ${bundle.component.componentId}` : ''}
          {bundle.component && bundle.component.overlap.requiresOverlapAck
            ? ' · transitive overlap — multiple agents touched intersecting paths'
            : ''}
        </div>
      )}

      <div className="sc-actions">
        <button
          type="button"
          className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px]"
          data-testid="save-bundle-inspect"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <Icons.Search className="w-3.5 h-3.5 shrink-0" />
          {expanded ? 'Hide details' : 'Inspect'}
        </button>
      </div>
    </div>
  );
}
