import React, { useCallback, useEffect, useRef, useState } from 'react';
import './planSurface.css';
import CandidatePreview, { type CandidatePreviewSelection } from '../save/CandidatePreview';
import CommitOutcome from '../save/CommitOutcome';
import { renderSaveRefusal } from '../save/save-refusal-copy';
import { createCandidateSubmitter } from '../save/candidate-submit';
import type { CommitCoordinatorConsumeResponse, PlanReviewProjection } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import MissionBoard from './MissionBoard';
import PlanReviewView from './PlanReviewView';

/** Right-hand rail for the folder-native plan surface. Its evidence comes from
 * the review/package ledgers; the retired HTML section/activity projection is
 * intentionally absent. */
function PlanSurfaceView({
  workspaceId,
  candidateSelection,
}: {
  workspaceId?: string;
  candidateSelection?: CandidatePreviewSelection | null;
}): React.ReactElement {
  const [commitOutcome, setCommitOutcome] = useState<CommitCoordinatorConsumeResponse | null>(null);
  const [commitRefusal, setCommitRefusal] = useState<string | null>(null);
  const [reviewProjection, setReviewProjection] = useState<PlanReviewProjection | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewRequestKeyRef = useRef<string | null>(null);
  const currentReviewKeyRef = useRef<string | null>(null);
  const submitterRef = useRef<ReturnType<typeof createCandidateSubmitter> | null>(null);
  if (!submitterRef.current) submitterRef.current = createCandidateSubmitter();
  const activePlanId = useDashboardStore((state) => {
    const activeTab = state.openTabs.find((tab) => tab.id === state.activeTabId);
    return activeTab?.kind === 'plan' ? activeTab.planId : null;
  });

  const reviewKey = activePlanId && workspaceId ? `${workspaceId}\0${activePlanId}` : null;
  currentReviewKeyRef.current = reviewKey;

  useEffect(() => {
    reviewRequestKeyRef.current = null;
    setReviewProjection(null);
    setReviewError(null);
  }, [reviewKey]);

  const loadReviewEvidence = useCallback((event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open || !activePlanId || !workspaceId || !reviewKey) return;
    if (reviewRequestKeyRef.current === reviewKey) return;
    reviewRequestKeyRef.current = reviewKey;
    setReviewProjection(null);
    setReviewError(null);
    const getReviewProjection = window.api.plans.getReviewProjection;
    if (typeof getReviewProjection !== 'function') {
      setReviewError('Plan review is unavailable.');
      return;
    }
    void getReviewProjection({ workspaceId, planId: activePlanId })
      .then((next) => {
        if (currentReviewKeyRef.current !== reviewKey) return;
        setReviewProjection(next);
        setReviewError(null);
      })
      .catch((error: unknown) => {
        if (currentReviewKeyRef.current !== reviewKey) return;
        setReviewProjection(null);
        setReviewError(error instanceof Error ? error.message : 'Plan review is unavailable.');
      });
  }, [activePlanId, reviewKey, workspaceId]);

  useEffect(() => { setCommitOutcome(null); setCommitRefusal(null); }, [workspaceId, candidateSelection]);

  return (
    <div className="plan-surface" data-testid="plan-surface">
      {workspaceId && candidateSelection && !commitOutcome && (
        <div className="plan-surface__candidate" data-testid="plan-candidate-preview">
          <CandidatePreview
            workspaceId={workspaceId}
            selection={candidateSelection}
            title="Save this plan's work"
            onCommit={async (_response, _messageBody, _acknowledgedIds, draft) => {
              const result = await submitterRef.current!.submit({
                workspaceId,
                selection: candidateSelection,
                draft,
              });
              if (result.kind === 'committed') {
                setCommitRefusal(null);
                setCommitOutcome(result.response);
              } else if (result.kind === 'refused') {
                setCommitRefusal(renderSaveRefusal(result.refusal));
                if (result.response) setCommitOutcome(result.response);
              } else {
                setCommitRefusal(result.message);
              }
            }}
          />
        </div>
      )}
      {commitRefusal && <div role="alert" data-testid="plan-save-refusal">{commitRefusal}</div>}
      {commitOutcome && <CommitOutcome response={commitOutcome} onRepreview={() => setCommitOutcome(null)} />}
      {activePlanId ? (
        <MissionBoard planId={activePlanId} paneVisible />
      ) : (
        <div className="mission-board__empty" data-testid="mission-board-no-plan">No active plan selected.</div>
      )}
      <details data-testid="plan-review-evidence" onToggle={loadReviewEvidence}>
        <summary>Change evidence (diff)</summary>
        {reviewProjection ? (
          <PlanReviewView projection={reviewProjection} />
        ) : (
          <div className="mission-board__empty" data-testid="plan-review-unavailable">
            {reviewError ?? 'Loading plan review…'}
          </div>
        )}
      </details>
    </div>
  );
}

export default PlanSurfaceView;
