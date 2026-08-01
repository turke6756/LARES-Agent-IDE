import React, { useState } from 'react';
import * as Icons from 'lucide-react';
import type { SaveCardInventoryResponse } from '../../../shared/types';
import type { DirtyEntry, ProtectionRung } from '../../../shared/commit-candidates';

// One renderer-safe WorkBundle DTO element (SC-WP-1H transport shape).
export type WorkBundleDto = SaveCardInventoryResponse[number];

const MAX_PATHS_COLLAPSED = 6;
const RUNG_ORDER: ProtectionRung[] = [
  'unprotected', 'checkpoint-protected', 'locally-committed', 'remote-reachable',
];

function dateRange(startedAt: number | null, endedAt: number | null): string {
  if (startedAt === null && endedAt === null) return 'Date not recorded';
  const format = (value: number) => new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  }).format(new Date(value));
  const start = format(startedAt ?? endedAt!);
  const end = format(endedAt ?? startedAt!);
  return start === end ? start : `${start}–${end}`;
}

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
export default function SaveBundle({
  bundle,
  bundles,
}: {
  bundle: WorkBundleDto;
  bundles?: WorkBundleDto[];
}) {
  const [expanded, setExpanded] = useState(false);
  const grouped = bundles ?? [bundle];

  const isUnattributed = bundle.kind === 'unattributed';
  const captureConcern = grouped.some(hasCaptureConcern);
  const rung = grouped.reduce<ProtectionRung | null>((weakest, current) => {
    if (!current.weakestProtection) return weakest;
    if (!weakest) return current.weakestProtection;
    return RUNG_ORDER.indexOf(current.weakestProtection) < RUNG_ORDER.indexOf(weakest)
      ? current.weakestProtection : weakest;
  }, null);
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

  const entries = [...new Map(
    grouped.flatMap((item) => item.members).map((member) => [member.entry.entryId, member.entry]),
  ).values()];
  const shownEntries = expanded ? entries : entries.slice(0, MAX_PATHS_COLLAPSED);
  const hiddenCount = entries.length - shownEntries.length;

  // Memory-jog line: role + label + what it touched. The DTO carries the label
  // and any plan associations; we never invent a role description that isn't in
  // the contract.
  const planAssoc = grouped.flatMap((item) => item.component?.associations ?? []).find((a) => a.planId) ?? null;
  const turnCount = new Set(grouped.flatMap((item) =>
    item.component?.associations.flatMap((a) => a.contributingTurnIds) ?? [],
  )).size;
  const workspaceCount = new Set(grouped.flatMap((item) => item.workspaces.map((ws) => ws.workspaceId))).size;
  const identity = bundle.identity;
  const workerUnits = grouped.flatMap((item) => item.identity?.workerUnits ?? []);
  const uniqueWorkers = [...new Map(workerUnits.map((unit) => [unit.agentId ?? unit.name, unit])).values()];

  return (
    <div className={slotClass} data-testid="save-bundle" data-bundle-id={bundle.bundleId} data-kind={bundle.kind}>
      <div className="sc-slothead">
        {!isUnattributed && (
          <span className={`sc-check${alreadyProtected ? ' sc-done' : ''}`} aria-hidden="true" />
        )}
        <h2>{identity?.name ?? bundle.label}</h2>
        <span className={pillClass} data-testid="save-bundle-pill">{pillText}</span>
      </div>

      {isUnattributed ? (
        <p className="sc-meta" data-testid="save-bundle-desc">
          {entries.length} dirty file{entries.length === 1 ? '' : 's'} no agent was seen touching —
          shell side effects, generated files, or a capture gap. Needs a human eye.
        </p>
      ) : (
        <>
          <p className="sc-desc" data-testid="save-bundle-desc">
            <span className="sc-k">{planAssoc ? 'From plan' : identity?.source === 'supervisor' ? 'From supervisor' : 'From agent'}</span>{' '}
            <b>{identity?.name ?? bundle.label}</b>{' '}
            <span className="sc-k">— {identity?.roleDescription || 'No role description recorded.'}</span>
          </p>
          <p className="sc-meta" data-testid="save-bundle-dates">
            {dateRange(identity?.startedAt ?? null, identity?.endedAt ?? null)} · {uniqueWorkers.length} contributing agent{uniqueWorkers.length === 1 ? '' : 's'} · {turnCount} witnessed turn{turnCount === 1 ? '' : 's'}
            {workspaceCount > 1 ? ` · across ${workspaceCount} workspaces` : ''}
          </p>
        </>
      )}

      {grouped.flatMap((item) => item.labels).filter((label) => label !== bundle.label).length > 0 && (
        <p className="sc-meta" data-testid="save-bundle-labels">
          Also: {[...new Set(grouped.flatMap((item) => item.labels).filter((label) => label !== bundle.label))].join(' · ')}
        </p>
      )}

      {!isUnattributed && uniqueWorkers.length > 0 && (
        <div className="sc-worker-units" data-testid="save-bundle-workers">
          {uniqueWorkers.map((worker) => (
            <div className="sc-worker-unit" key={worker.agentId ?? worker.name}>
              <div className="sc-worker-head">
                <b>{worker.name}</b>
                <span>{worker.kind === 'worker' ? 'Worker' : worker.kind === 'supervisor' ? 'Supervisor' : 'Agent'}</span>
              </div>
              <p>{worker.roleDescription}</p>
              <small>{dateRange(worker.startedAt, worker.endedAt)} · {worker.turnCount} turn{worker.turnCount === 1 ? '' : 's'} · {worker.memberEntryIds.length} file{worker.memberEntryIds.length === 1 ? '' : 's'}</small>
            </div>
          ))}
        </div>
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
            {grouped.some((item) => item.captureHealth.captureOutage)
              ? 'Capture outage — some turns in this bundle have no reliable snapshot.'
              : grouped.some((item) => item.captureHealth.pathsWithoutFinalizationEdge.length > 0)
                ? `${grouped.reduce((count, item) => count + item.captureHealth.pathsWithoutFinalizationEdge.length, 0)} path(s) have no protection edge — the witnessed union may not cover the tree.`
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
          {grouped.some((item) => item.component) ? ` · ${grouped.filter((item) => item.component).length} conflict component(s)` : ''}
          {grouped.some((item) => item.component?.overlap.requiresOverlapAck)
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
