import React from 'react';
import type { PlanReviewProjection } from '../../../shared/types';
import CandidatePreview, { type CandidatePreviewSelection } from '../save/CandidatePreview';
import './planReviewView.css';

const MIXED_REASON_LABELS = {
  'multiple-plans': 'Multiple plans contributed to this component',
  'unattributed-contributor': 'Some contributing work is unattributed',
  'multiple-agents': 'Multiple agents contributed to this component',
} as const;

const GAP_REASON_LABELS = {
  'capture-outage': 'Checkpoint capture was unavailable for part of this work',
  'incomplete-edge': 'Some paths or turns lack a complete finalization edge',
  'unstamped-turn': 'A contributing turn was not stamped to this plan',
  'unverified-turn': 'A contributing plan stamp could not be verified',
} as const;

function previewSelection(projection: PlanReviewProjection): CandidatePreviewSelection {
  const scObject = projection.scObject;
  return {
    selectedComponentIds: [...scObject.componentIds],
    selectedUnattributedEntryIds: [...scObject.selectedUnattributedEntryIds],
    finalizationIds: 'finalizations' in scObject
      ? scObject.finalizations.map((entry) => entry.finalizationId)
      : [],
  };
}

export default function PlanReviewView({
  projection,
}: {
  projection: PlanReviewProjection;
}): React.ReactElement {
  const { baselineDiff, annotations } = projection;
  const baselineLabel = baselineDiff.baseline.kind === 'head'
    ? `Pinned baseline ${baselineDiff.baseline.headOid.slice(0, 12)}`
    : 'Unborn repository baseline';

  return (
    <div className="plan-review" data-testid="plan-review-view">
      <p className="plan-review__disclaimer" data-testid="plan-review-disclaimer">
        Review evidence only — activity and changed bytes do not imply completion.
      </p>

      <section className="plan-review__section" aria-labelledby="plan-review-diff-heading">
        <div className="plan-review__heading-row">
          <h3 id="plan-review-diff-heading">Baseline to current</h3>
          <span>{baselineLabel}</span>
        </div>
        {baselineDiff.witnessedPaths.length > 0 && (
          <ul className="plan-review__paths" aria-label="Plan-witnessed paths">
            {baselineDiff.witnessedPaths.map((path) => <li key={path}>{path}</li>)}
          </ul>
        )}
        <pre className="plan-review__patch" data-testid="plan-review-patch">
          {baselineDiff.patch || 'No baseline-to-current changes on plan-witnessed paths.'}
        </pre>
      </section>

      {(annotations.mixedAuthorship.length > 0 || annotations.captureGaps.length > 0) && (
        <section className="plan-review__section" aria-labelledby="plan-review-annotations-heading">
          <h3 id="plan-review-annotations-heading">Evidence limits</h3>
          <ul className="plan-review__annotations">
            {annotations.mixedAuthorship.map((annotation) => (
              <li key={`mixed:${annotation.componentId}`} data-testid="plan-review-mixed-authorship">
                <strong>Mixed authorship may be present</strong>
                <span>{annotation.reasons.map((reason) => MIXED_REASON_LABELS[reason]).join('. ')}.</span>
                <small>Component {annotation.componentId}; this is not line-authorship evidence.</small>
              </li>
            ))}
            {annotations.captureGaps.map((annotation, index) => (
              <li
                key={`gap:${annotation.source}:${annotation.componentId ?? 'plan'}:${index}`}
                data-testid="plan-review-capture-gap"
              >
                <strong>Capture gap</strong>
                <span>{annotation.reasons.map((reason) => GAP_REASON_LABELS[reason]).join('. ')}.</span>
                {annotation.turnIds.length > 0 && <small>Turns: {annotation.turnIds.join(', ')}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="plan-review__section" aria-labelledby="plan-review-selection-heading">
        <h3 id="plan-review-selection-heading">Shared selection preview</h3>
        <CandidatePreview
          workspaceId={projection.workspaceId}
          selection={previewSelection(projection)}
          title="Plan-associated work"
          showCommitAction={false}
        />
      </section>
    </div>
  );
}
