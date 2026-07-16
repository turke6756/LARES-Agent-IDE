import React, { useCallback, useState } from 'react';
import {
  toTrustedRow,
  repoDigestLabel,
  hasRepoDetail,
  repoFileItemLine,
  repoDetailOverflow,
  type PlanEventView,
  type RepoActivityDetail,
} from './plan-surface-model';

/** Tier-3 fetch contract — the detail stays local to the expanded row and NEVER
 *  replaces the section/events state (Fix-4 §6). */
export type FetchEventDetail = (eventId: string) => Promise<RepoActivityDetail | null>;

/** One TRUSTED activity row (tier-2): the resolver's attribution of an agent's
 *  work to a section, with an `observed_via` label + confidence badge and a
 *  visible mismatch flag when the observed section diverges from the dispatched
 *  one. This is the verified record — never mix claimed self-report in here.
 *
 *  GT-C §3.5 / GT-A A3.4 — a leading marker keyed on `changeCount` (`✎ wrote` for a
 *  real write, `· note` for a presence/deliberation turn) and, when the turn wrote
 *  more than one section, a "wrote N sections" affordance derived from
 *  `writtenSectionAnchors.length` (D-5: NEVER `changeCount`, which is raw cardinality).
 *
 *  Fix-4 §6 — beneath the trusted row sits the WITNESSED repo-activity evidence: a
 *  digest line (counts only) that is VISUALLY SEPARATE from the agent-authored
 *  claimed payload (evidence ≠ narrative). When the digest is captured-with-detail,
 *  an expander drills down (Tier-3) to the capped witnessed file list, fetched once
 *  on first expand and cached in row state (collapse → re-expand does NOT refetch);
 *  a failed fetch surfaces a retryable error line. Full file lists live ONLY here,
 *  behind the expand — never in the plan HTML pane. */
function TrustedEventRow({
  event,
  onFetchEventDetail,
}: {
  event: PlanEventView;
  onFetchEventDetail?: FetchEventDetail;
}): React.ReactElement {
  const row = toTrustedRow(event);
  const conf = row.confidence ?? 'none';
  const when = formatTime(row.createdAt);
  const isWriteRow = event.changeCount > 0;
  const wroteN = event.writtenSectionAnchors?.length ?? 0;
  // GT-C §3.6 — honest render of an uncertain multi-section turn: when the resolver
  // saw several candidate sections but the effect set didn't pin a confident "wrote
  // N", surface the audit breadth from `observedCandidates`. Suppressed once the
  // confident "wrote N sections" affordance already conveys multi-section breadth.
  const spannedN = event.observedCandidates?.length ?? 0;
  const showSpanned = wroteN <= 1 && spannedN > 1;
  return (
    <>
      <div className="trusted-row" data-testid="trusted-row">
        <span
          className={`trusted-row__marker trusted-row__marker--${isWriteRow ? 'write' : 'note'}`}
          data-testid="trusted-row-marker"
        >
          {isWriteRow ? '✎ wrote' : '· note'}
        </span>
        <span className="trusted-row__agent">{row.agentTitle}</span>
        <span className="trusted-row__via">{row.observedViaLabel}</span>
        {wroteN > 1 && (
          <span className="trusted-row__spanned" title="This turn wrote several sections">
            wrote {wroteN} sections
          </span>
        )}
        {showSpanned && (
          <span
            className="trusted-row__spanned trusted-row__spanned--candidates"
            title="The resolver saw this turn touch several candidate sections (attribution uncertain)"
          >
            spanned {spannedN} sections
          </span>
        )}
        <span
          className={`confidence-badge confidence-badge--${conf}`}
          title={`Attribution confidence: ${row.confidenceLabel}`}
        >
          {row.confidenceLabel}
        </span>
        {row.mismatchLabel && (
          <span className="mismatch-flag" title="Section mismatch">
            ⚠ {row.mismatchLabel}
          </span>
        )}
        {when && <span className="trusted-row__time">{when}</span>}
      </div>
      <RepoEvidence event={event} onFetchEventDetail={onFetchEventDetail} />
    </>
  );
}

/** Fix-4 §6 — the witnessed repo-activity evidence block, rendered BELOW the
 *  trusted row and ABOVE the claimed payload so it is unmistakably evidence, not
 *  narrative. Owns the per-row Tier-3 drill-down state. */
function RepoEvidence({
  event,
  onFetchEventDetail,
}: {
  event: PlanEventView;
  onFetchEventDetail?: FetchEventDetail;
}): React.ReactElement | null {
  const digest = event.repoActivityDigest ?? null;
  const label = repoDigestLabel(digest);
  const canExpand = hasRepoDetail(digest) && !!onFetchEventDetail;

  // Hooks must run unconditionally (Rules of Hooks) — declare them before the
  // captured-but-empty early return below.
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [detail, setDetail] = useState<RepoActivityDetail | null>(null);
  // Marks a COMPLETED successful fetch. Caching keys on this so collapse → re-expand
  // never refetches, while a failed fetch (fetched stays false) remains retryable.
  const [fetched, setFetched] = useState(false);

  const runFetch = useCallback(async () => {
    if (!onFetchEventDetail) return;
    setLoading(true);
    setError(false);
    try {
      const d = await onFetchEventDetail(event.id);
      setDetail(d);
      setFetched(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [onFetchEventDetail, event.id]);

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!fetched && !loading) void runFetch();
  }, [open, fetched, loading, runFetch]);

  // captured-but-empty (`line === null`) adds nothing — render no evidence block.
  if (label === null) return null;

  return (
    <div className="repo-evidence" data-testid="repo-evidence">
      {canExpand ? (
        <button
          type="button"
          className="repo-evidence__toggle"
          aria-expanded={open}
          onClick={toggle}
          data-testid="repo-evidence-toggle"
        >
          <span className="repo-evidence__line">{label}</span>
          <span className="repo-evidence__chevron">{open ? '▾' : '▸'}</span>
        </button>
      ) : (
        <span
          className="repo-evidence__line repo-evidence__line--muted"
          data-testid="repo-evidence-line"
        >
          {label}
        </span>
      )}
      {open && (
        <div className="repo-evidence__detail" data-testid="repo-evidence-detail">
          {loading && (
            <span
              className="repo-evidence__loading"
              role="status"
              data-testid="repo-evidence-loading"
            >
              Loading witnessed files…
            </span>
          )}
          {!loading && error && (
            <button
              type="button"
              className="repo-evidence__error"
              onClick={() => void runFetch()}
              data-testid="repo-evidence-error"
            >
              Couldn't load witnessed files — retry
            </button>
          )}
          {!loading && !error && detail && (
            <RepoDetailList detail={detail} />
          )}
        </div>
      )}
    </div>
  );
}

/** The capped witnessed file list (Tier-3). Each row is `path · ops · counts`; a
 *  "+N more (capped)" line surfaces when the blob was truncated at write time. */
function RepoDetailList({ detail }: { detail: RepoActivityDetail }): React.ReactElement {
  const overflow = repoDetailOverflow(detail);
  return (
    <ul className="repo-evidence__files" data-testid="repo-evidence-files">
      {detail.files.items.map((item) => {
        const line = repoFileItemLine(item);
        return (
          <li
            key={item.outsideWorkspace ? `::${item.path}` : item.path}
            className={`repo-evidence__file${item.outsideWorkspace ? ' repo-evidence__file--outside' : ''}`}
          >
            <span className="repo-evidence__path">{line.path}</span>
            <span className="repo-evidence__sep">·</span>
            <span className="repo-evidence__ops">{line.ops}</span>
            <span className="repo-evidence__sep">·</span>
            <span className="repo-evidence__counts">{line.counts}</span>
          </li>
        );
      })}
      {detail.files.truncated && (
        <li className="repo-evidence__more" data-testid="repo-evidence-more">
          +{overflow} more (capped)
        </li>
      )}
    </ul>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default TrustedEventRow;
