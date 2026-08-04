import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CheckpointTurnSummary,
  CommitCoordinatorConsumeResponse,
  MissionBoardCard,
  MissionBoardDurableTurn,
  MissionBoardLiveActivity,
  MissionBoardPackageTimeline,
  PlanCandidatePreviewResponse,
} from '../../../shared/types';
import { useMissionBoardPolling, type MissionBoardList } from '../../stores/mission-board-store';
import AttributionPanel from '../checkpoints/AttributionPanel';
import FileHistoryView from '../checkpoints/FileHistoryView';
import RestoreDialog from '../checkpoints/RestoreDialog';
import CandidatePreview, { type CandidatePreviewSelection } from '../save/CandidatePreview';
import CommitOutcome from '../save/CommitOutcome';
import WorkPackageCard, { type WorkPackageFileSelection } from './WorkPackageCard';
import './missionBoard.css';

type BoardPlansApi = typeof window.api.plans & {
  boardList: MissionBoardList;
  boardTimeline: (planId: string) => Promise<MissionBoardPackageTimeline[] | null>;
  finalizeItemDone: (request: { planItemId: string }) => Promise<unknown>;
};

const listMissionBoardCards: MissionBoardList = (planId) =>
  (window.api.plans as BoardPlansApi).boardList(planId);
const listMissionBoardTimeline = (planId: string) => {
  const boardTimeline = (window.api.plans as Partial<BoardPlansApi>).boardTimeline;
  return boardTimeline ? boardTimeline(planId) : Promise.resolve([]);
};

interface FileHistorySelection extends WorkPackageFileSelection {
  workspaceId: string;
}

interface TurnDiffSelection {
  workspaceId: string;
  activity: MissionBoardLiveActivity;
}

interface RestoreSelection {
  workspaceId: string;
  turn: MissionBoardDurableTurn;
}

export interface MissionBoardProps {
  planId: string;
  paneVisible: boolean;
  listCards?: MissionBoardList;
  listTimeline?: (planId: string) => Promise<MissionBoardPackageTimeline[] | null>;
}

interface CommitSelection {
  packageId: string;
  workspaceId: string;
  selection: CandidatePreviewSelection;
}

function messageFromError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error || 'Unknown error');
}

function restoreSummary(turn: MissionBoardDurableTurn): CheckpointTurnSummary {
  return {
    turnId: turn.turnId,
    turnSeq: turn.turnSeq,
    agentId: turn.agentId,
    agentTitle: null,
    taskLabel: turn.taskLabel,
    status: 'closed',
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    // The board DTO does not claim checkpoint-edge readiness. RestoreDialog's
    // fresh preview is the authority and remains the hard mutation gate.
    beforeReady: false,
    afterReady: false,
    beforeQuality: null,
    afterQuality: null,
    witnessedPaths: turn.touched.map((touch) => touch.path),
    failureReason: null,
  };
}

export default function MissionBoard({
  planId,
  paneVisible,
  listCards = listMissionBoardCards,
  listTimeline = listMissionBoardTimeline,
}: MissionBoardProps): React.ReactElement {
  const { cards, error, loading } = useMissionBoardPolling(planId, paneVisible, listCards);
  const [fileHistory, setFileHistory] = useState<FileHistorySelection | null>(null);
  const [turnDiff, setTurnDiff] = useState<TurnDiffSelection | null>(null);
  const [restore, setRestore] = useState<RestoreSelection | null>(null);
  const [timeline, setTimeline] = useState<MissionBoardPackageTimeline[]>([]);
  const [actionPending, setActionPending] = useState<{ packageId: string; action: 'done' | 'commit' } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [commitSelection, setCommitSelection] = useState<CommitSelection | null>(null);
  const [commitOutcome, setCommitOutcome] = useState<CommitCoordinatorConsumeResponse | null>(null);

  const cardRevisionKey = useMemo(
    () => cards.map((card) => `${card.packageId}:${card.revision}:${card.state}`).join('|'),
    [cards],
  );

  useEffect(() => {
    setCommitSelection(null);
    setCommitOutcome(null);
    setActionError(null);
  }, [planId]);

  useEffect(() => {
    if (!paneVisible || !planId) return;
    let current = true;
    void listTimeline(planId)
      .then((value) => { if (current) setTimeline(value ?? []); })
      .catch((error) => { if (current) setActionError(`Timeline unavailable: ${messageFromError(error)}`); });
    return () => { current = false; };
  }, [cardRevisionKey, listTimeline, paneVisible, planId]);

  const timelineByPackage = useMemo(
    () => new Map(timeline.map((entry) => [entry.packageId, entry.events])),
    [timeline],
  );

  const markDone = useCallback(async (card: MissionBoardCard) => {
    setActionError(null);
    setActionPending({ packageId: card.packageId, action: 'done' });
    try {
      // SC-WP-3D is the sole owner of the atomic finalization + done transition.
      // No renderer/planning state write accompanies this invocation.
      await (window.api.plans as BoardPlansApi).finalizeItemDone({ planItemId: card.packageId });
    } catch (error) {
      setActionError(`Could not mark ${card.packageId} done: ${messageFromError(error)}`);
    } finally {
      setActionPending(null);
    }
  }, []);

  const prepareCommit = useCallback(async (card: MissionBoardCard) => {
    const finalization = [...(timelineByPackage.get(card.packageId) ?? [])].reverse().find((event) =>
      event.source === 'finalization'
      && event.boundaryStatus === 'ready'
      && event.lifecycleStatus === 'active');
    if (!finalization || finalization.source !== 'finalization') return;
    setActionError(null);
    setCommitOutcome(null);
    setActionPending({ packageId: card.packageId, action: 'commit' });
    try {
      // The Plan route resolves whole components and candidate identity. The board
      // supplies only the SC-owned finalization id; it never recomputes topology.
      const preview: PlanCandidatePreviewResponse = await window.api.plans.previewCandidate({
        workspaceId: card.workspaceId,
        planId: card.planId,
        selectedComponentIds: [],
        selectedUnattributedEntryIds: [],
        finalizationIds: [finalization.eventId],
      });
      setCommitSelection({
        packageId: card.packageId,
        workspaceId: card.workspaceId,
        selection: preview.selection,
      });
    } catch (error) {
      setActionError(`Could not prepare ${card.packageId}: ${messageFromError(error)}`);
    } finally {
      setActionPending(null);
    }
  }, [timelineByPackage]);

  const openFile = useCallback((card: MissionBoardCard, selection: WorkPackageFileSelection) => {
    const workspaceId = selection.activity.workspaceId || card.workspaceId;
    const opts = selection.activity.agentId ? { agentId: selection.activity.agentId } : undefined;
    // Select the contributor at the transport boundary before mounting the shared
    // history surface. FileHistoryView owns subsequent refreshes and restore flow.
    void window.api.checkpoints.fileHistory(workspaceId, selection.touch.path, opts).catch(() => undefined);
    setFileHistory({ ...selection, workspaceId });
  }, []);

  const openTurnDiff = useCallback((card: MissionBoardCard, activity: MissionBoardLiveActivity) => {
    const workspaceId = activity.workspaceId || card.workspaceId;
    // Deliberately turn-wide. File-level navigation above uses fileHistory.
    void window.api.checkpoints.diff(workspaceId, activity.turnId).catch(() => undefined);
    setTurnDiff({ workspaceId, activity });
  }, []);

  return (
    <section className="mission-board" data-testid="mission-board" aria-label="Mission board">
      <div className="mission-board__summary">
        <div>
          <h2>Packages</h2>
          <p>Live touches are activity evidence, not completion.</p>
        </div>
        {loading && <span className="mission-board__loading">Refreshing…</span>}
      </div>

      {error && <div className="mission-board__error" role="alert">Board unavailable: {error}</div>}
      {actionError && <div className="mission-board__error" role="alert">{actionError}</div>}
      {!loading && !error && cards.length === 0 && (
        <div className="mission-board__empty">No work packages yet.</div>
      )}

      <div className="mission-board__grid">
        {cards.map((card) => (
          <WorkPackageCard
            key={card.packageId}
            card={card}
            onOpenFile={(selection) => openFile(card, selection)}
            onOpenTurnDiff={(activity) => openTurnDiff(card, activity)}
            onRestoreTurn={(turn) => setRestore({ workspaceId: turn.workspaceId || card.workspaceId, turn })}
            timeline={timelineByPackage.get(card.packageId) ?? []}
            onMarkDone={() => { void markDone(card); }}
            onCommitPackage={() => { void prepareCommit(card); }}
            actionPending={actionPending?.packageId === card.packageId ? actionPending.action : null}
          />
        ))}
      </div>

      {commitSelection && !commitOutcome && (
        <div className="mission-board__commit" data-testid="board-candidate-preview">
          <CandidatePreview
            workspaceId={commitSelection.workspaceId}
            selection={commitSelection.selection}
            title={`Commit ${commitSelection.packageId}`}
            onClose={() => setCommitSelection(null)}
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
      {commitOutcome && (
        <CommitOutcome
          response={commitOutcome}
          onRepreview={() => setCommitOutcome(null)}
        />
      )}

      {fileHistory && (
        <div data-selected-turn-id={fileHistory.activity.turnId}>
          <FileHistoryView
            workspaceId={fileHistory.workspaceId}
            path={fileHistory.touch.path}
            onClose={() => setFileHistory(null)}
          />
        </div>
      )}

      {turnDiff && (
        <div data-selected-turn-id={turnDiff.activity.turnId}>
          <AttributionPanel
            workspaceId={turnDiff.workspaceId}
            onClose={() => setTurnDiff(null)}
          />
        </div>
      )}

      {restore && (
        <RestoreDialog
          workspaceId={restore.workspaceId}
          agentId={restore.turn.agentId ?? ''}
          turn={restoreSummary(restore.turn)}
          mode="restore"
          paths={restore.turn.touched.map((touch) => touch.path)}
          onClose={() => setRestore(null)}
        />
      )}
    </section>
  );
}
