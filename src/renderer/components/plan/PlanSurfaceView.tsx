import React, { useEffect, useRef, useState } from 'react';
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
  const [viewMode, setViewMode] = useState<'review' | 'packages'>('review');
  const [reviewProjection, setReviewProjection] = useState<PlanReviewProjection | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const submitterRef = useRef<ReturnType<typeof createCandidateSubmitter> | null>(null);
  if (!submitterRef.current) submitterRef.current = createCandidateSubmitter();
  const activePlanId = useDashboardStore((state) => {
    const activeTab = state.openTabs.find((tab) => tab.id === state.activeTabId);
    return activeTab?.kind === 'plan' ? activeTab.planId : null;
  });

  useEffect(() => {
    if (!activePlanId || !workspaceId) {
      setReviewProjection(null);
      setReviewError(null);
      return;
    }
    let active = true;
    const getReviewProjection = window.api.plans.getReviewProjection;
    if (typeof getReviewProjection !== 'function') return;
    void getReviewProjection({ workspaceId, planId: activePlanId })
      .then((next) => {
        if (!active) return;
        setReviewProjection(next);
        setReviewError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setReviewProjection(null);
        setReviewError(error instanceof Error ? error.message : 'Plan review is unavailable.');
      });
    return () => { active = false; };
  }, [activePlanId, workspaceId]);

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
      <div className="plan-surface__viewtoggle" role="tablist" aria-label="Plan view" data-testid="plan-view-toggle">
        <button
          type="button"
          role="tab"
          className={`plan-surface__viewtab${viewMode === 'review' ? ' plan-surface__viewtab--active' : ''}`}
          aria-selected={viewMode === 'review'}
          onClick={() => setViewMode('review')}
          data-testid="plan-view-review"
        >
          Review
        </button>
        <button
          type="button"
          role="tab"
          className={`plan-surface__viewtab${viewMode === 'packages' ? ' plan-surface__viewtab--active' : ''}`}
          aria-selected={viewMode === 'packages'}
          onClick={() => setViewMode('packages')}
          data-testid="plan-view-packages"
        >
          Packages
        </button>
      </div>
      {viewMode === 'review' ? (
        reviewProjection ? (
          <PlanReviewView projection={reviewProjection} />
        ) : (
          <div className="mission-board__empty" data-testid="plan-review-unavailable">
            {reviewError ?? 'Loading plan review…'}
          </div>
        )
      ) : activePlanId ? (
        <MissionBoard planId={activePlanId} paneVisible />
      ) : (
        <div className="mission-board__empty" data-testid="mission-board-no-plan">No active plan selected.</div>
      )}
    </div>
  );
}

export default PlanSurfaceView;
