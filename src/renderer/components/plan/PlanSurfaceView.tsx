import React, { useEffect, useState } from 'react';
import './planSurface.css';
import CandidatePreview, { type CandidatePreviewSelection } from '../save/CandidatePreview';
import CommitOutcome from '../save/CommitOutcome';
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
  const [viewMode, setViewMode] = useState<'review' | 'packages'>('review');
  const [reviewProjection, setReviewProjection] = useState<PlanReviewProjection | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
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

  useEffect(() => { setCommitOutcome(null); }, [workspaceId, candidateSelection]);

  return (
    <div className="plan-surface" data-testid="plan-surface">
      {workspaceId && candidateSelection && !commitOutcome && (
        <div className="plan-surface__candidate" data-testid="plan-candidate-preview">
          <CandidatePreview
            workspaceId={workspaceId}
            selection={candidateSelection}
            title="Save this plan's work"
            onCommit={async (response, messageBody) => {
              if (!response.isCandidate || !('token' in response.candidate) || !response.candidate.token) return;
              const result = await window.api.commitCoordinator.commit({
                candidateId: response.candidate.candidateId,
                tokenId: response.candidate.token.tokenId,
                message: messageBody,
              });
              setCommitOutcome(result);
            }}
          />
        </div>
      )}
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
