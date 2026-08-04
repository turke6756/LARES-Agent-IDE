import React from 'react';
import type { CommitCoordinatorConsumeResponse } from '../../../shared/types';

export type CommitOutcomeState =
  | 'saved'
  | 'stale-refused'
  | 'integrity-incident'
  | 'repository-uncertain';

export interface CommitOutcomeProps {
  response: CommitCoordinatorConsumeResponse;
  onRepreview?: () => void;
}

type Outcome = Extract<CommitCoordinatorConsumeResponse, { outcome: unknown }>['outcome'];

/**
 * Classify the lens-neutral coordinator response into the four user-visible
 * post-attempt states. The `saved` envelope is the proof that the integrated
 * coordinator/reconciler path verified and ledgered the commit; a raw committed
 * outcome, reconciliation failure, index incident, or HEAD drift never earns the
 * saved payoff.
 */
export function classifyCommitOutcome(response: CommitCoordinatorConsumeResponse): CommitOutcomeState {
  if (response.kind === 'saved') {
    if (response.outcome.currentHeadDrift) return 'repository-uncertain';
    return response.outcome.indexIntegrity === 'verified' ? 'saved' : 'integrity-incident';
  }
  if (response.kind === 'reconciliation-error') return 'integrity-incident';
  if (response.kind !== 'outcome') return 'stale-refused';
  if (response.outcome.status === 'repository-state-uncertain') return 'repository-uncertain';
  if (response.outcome.status === 'committed-integrity-mismatch') return 'integrity-incident';
  return 'stale-refused';
}

function Paths({ paths }: { paths: Array<{ pathBytesBase64: string; displayPath: string }> }) {
  if (paths.length === 0) return null;
  return (
    <ul className="sc-outcome-paths" data-testid="commit-outcome-paths">
      {paths.map((path) => (
        <li key={`${path.pathBytesBase64}:${path.displayPath}`}>{path.displayPath}</li>
      ))}
    </ul>
  );
}

function Repreview({ onRepreview }: { onRepreview?: () => void }) {
  if (!onRepreview) return null;
  return (
    <button
      type="button"
      className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px]"
      data-testid="commit-outcome-repreview"
      onClick={onRepreview}
    >
      Check the package again
    </button>
  );
}

function StaleRefused({ response, onRepreview }: CommitOutcomeProps) {
  const changedSinceApproval = response.kind === 'outcome' && response.outcome.status === 'aborted-stale';
  const reason = response.kind === 'outcome' && (
    response.outcome.status === 'aborted-stale' || response.outcome.status === 'aborted-error'
  )
    ? response.outcome.reason
    : response.kind === 'invalid-message'
      ? response.reason
      : response.kind === 'compose-in-flight'
        ? 'Another save is already in progress for this repository.'
        : 'That preview is no longer available.';
  return (
    <div className="sc-outcome sc-outcome-stale" role="status" data-testid="commit-outcome" data-state="stale-refused">
      <div className="sc-outcome-kicker">Save refused safely</div>
      <h3>{changedSinceApproval ? 'Changed since you approved it' : 'Save was refused'}</h3>
      <p>Nothing was committed from this attempt. Check the package again before deciding whether to save.</p>
      <p className="sc-outcome-detail">{reason}</p>
      <div className="sc-actions"><Repreview onRepreview={onRepreview} /></div>
    </div>
  );
}

function IntegrityIncident({ response }: CommitOutcomeProps) {
  const outcome: Outcome = response.kind === 'reconciliation-error' || response.kind === 'saved'
    ? response.outcome
    : response.kind === 'outcome'
      ? response.outcome
      : ({ status: 'aborted-error', reason: '', attemptId: '' } as Outcome);
  const commitOid = 'commitOid' in outcome ? outcome.commitOid : null;
  const paths = outcome.status === 'committed-integrity-mismatch'
    ? [...outcome.mismatchedPaths, ...(outcome.indexMismatchedPaths ?? [])]
    : 'indexMismatchedPaths' in outcome
      ? outcome.indexMismatchedPaths ?? []
      : [];
  const detail = response.kind === 'reconciliation-error'
    ? response.error.message
    : outcome.status === 'committed-integrity-mismatch'
      ? 'The committed tree did not match the approved package.'
      : 'Lares could not verify that the repository index was preserved exactly.';
  return (
    <div className="sc-outcome sc-outcome-integrity" role="alert" data-testid="commit-outcome" data-state="integrity-incident">
      <div className="sc-outcome-kicker">Integrity incident</div>
      <h3>The commit was retained</h3>
      <p>A commit exists, but Lares will not call this package saved. No rollback was attempted.</p>
      {commitOid && <code className="sc-outcome-oid" data-testid="commit-outcome-commit-oid">Commit {commitOid}</code>}
      <p className="sc-outcome-detail">{detail}</p>
      <Paths paths={paths} />
    </div>
  );
}

function RepositoryUncertain({ response }: CommitOutcomeProps) {
  const outcome = response.kind === 'saved' ? response.outcome : response.kind === 'outcome' ? response.outcome : null;
  const commitOid = outcome && 'commitOid' in outcome ? outcome.commitOid : null;
  const pinnedHeadOid = outcome?.status === 'repository-state-uncertain' ? outcome.pinnedHeadOid : null;
  const resolvedHeadOid = outcome?.status === 'repository-state-uncertain'
    ? outcome.resolvedHeadOid
    : outcome && 'currentHeadDrift' in outcome
      ? outcome.currentHeadDrift?.resolvedHeadOid ?? null
      : null;
  return (
    <div className="sc-outcome sc-outcome-uncertain" role="alert" data-testid="commit-outcome" data-state="repository-uncertain">
      <div className="sc-outcome-kicker">Repository state uncertain</div>
      <h3>HEAD moved during the save</h3>
      <p>Lares kept the evidence and made no rollback attempt. Inspect the repository before saving again.</p>
      <dl className="sc-outcome-facts">
        {commitOid && <div><dt>Identified commit</dt><dd><code>{commitOid}</code></dd></div>}
        {pinnedHeadOid && <div><dt>Approved HEAD</dt><dd><code>{pinnedHeadOid}</code></dd></div>}
        {resolvedHeadOid && <div><dt>Current HEAD</dt><dd><code>{resolvedHeadOid}</code></dd></div>}
      </dl>
    </div>
  );
}

export default function CommitOutcomeView(props: CommitOutcomeProps) {
  const state = classifyCommitOutcome(props.response);
  if (state === 'stale-refused') return <StaleRefused {...props} />;
  if (state === 'integrity-incident') return <IntegrityIncident {...props} />;
  if (state === 'repository-uncertain') return <RepositoryUncertain {...props} />;
  const outcome = props.response.kind === 'saved' ? props.response.outcome : null;
  return (
    <div className="sc-outcome sc-outcome-saved" role="status" data-testid="commit-outcome" data-state="saved">
      <div className="sc-outcome-save-mark" aria-hidden="true">✓</div>
      <div>
        <div className="sc-outcome-kicker">Progress secured</div>
        <h3>Saved</h3>
        <p>Your approved package is committed, verified, and recorded by Lares.</p>
        {outcome && <code className="sc-outcome-oid">Commit {outcome.commitOid}</code>}
      </div>
    </div>
  );
}
