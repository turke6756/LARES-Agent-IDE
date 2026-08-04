import React, { useCallback, useState } from 'react';
import type {
  CheckpointTurnSummary,
  MissionBoardCard,
  MissionBoardDurableTurn,
  MissionBoardLiveActivity,
} from '../../../shared/types';
import { useMissionBoardPolling, type MissionBoardList } from '../../stores/mission-board-store';
import AttributionPanel from '../checkpoints/AttributionPanel';
import FileHistoryView from '../checkpoints/FileHistoryView';
import RestoreDialog from '../checkpoints/RestoreDialog';
import WorkPackageCard, { type WorkPackageFileSelection } from './WorkPackageCard';
import './missionBoard.css';

type BoardPlansApi = typeof window.api.plans & {
  boardList: MissionBoardList;
};

const listMissionBoardCards: MissionBoardList = (planId) =>
  (window.api.plans as BoardPlansApi).boardList(planId);

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
}: MissionBoardProps): React.ReactElement {
  const { cards, error, loading } = useMissionBoardPolling(planId, paneVisible, listCards);
  const [fileHistory, setFileHistory] = useState<FileHistorySelection | null>(null);
  const [turnDiff, setTurnDiff] = useState<TurnDiffSelection | null>(null);
  const [restore, setRestore] = useState<RestoreSelection | null>(null);

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
          />
        ))}
      </div>

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
