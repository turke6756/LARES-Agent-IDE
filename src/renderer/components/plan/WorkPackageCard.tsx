import React from 'react';
import type {
  MissionBoardCard as MissionBoardCardDto,
  MissionBoardDurableTurn,
  MissionBoardLiveActivity,
  MissionBoardTouch,
} from '../../../shared/types';

export interface WorkPackageFileSelection {
  activity: MissionBoardLiveActivity;
  touch: MissionBoardTouch;
}

export interface WorkPackageCardProps {
  card: MissionBoardCardDto;
  onOpenFile: (selection: WorkPackageFileSelection) => void;
  onOpenTurnDiff: (activity: MissionBoardLiveActivity) => void;
  onRestoreTurn: (turn: MissionBoardDurableTurn) => void;
}

function activityLabel(activity: MissionBoardLiveActivity): string {
  return activity.taskLabel
    ?? (activity.agentId ? `Agent ${activity.agentId}` : `Turn ${activity.turnSeq}`);
}

export default function WorkPackageCard({
  card,
  onOpenFile,
  onOpenTurnDiff,
  onRestoreTurn,
}: WorkPackageCardProps): React.ReactElement {
  const activeActivity = card.liveActivity.filter((activity) => activity.isActive);
  const isActive = activeActivity.length > 0;

  return (
    <article
      className={`work-package-card${isActive ? ' work-package-card--active' : ''}`}
      data-testid={`work-package-card-${card.packageId}`}
      data-state={card.state}
      data-live-active={isActive ? 'true' : 'false'}
    >
      <header className="work-package-card__header">
        <div className="work-package-card__heading">
          <span className="work-package-card__id">{card.packageId}</span>
          <h3>{card.title}</h3>
        </div>
        <span className={`work-package-card__state work-package-card__state--${card.state}`}>
          {card.state}
        </span>
      </header>

      {card.acceptanceCondition && (
        <p className="work-package-card__acceptance">{card.acceptanceCondition}</p>
      )}

      <div className="work-package-card__activity" aria-label="Live activity">
        {isActive ? (
          activeActivity.map((activity) => (
            <div className="work-package-card__turn" key={activity.turnId}>
              <div className="work-package-card__turn-heading">
                <span className="work-package-card__pulse" aria-hidden="true" />
                <span>{activityLabel(activity)}</span>
                <span className="work-package-card__turn-number">turn {activity.turnSeq}</span>
              </div>
              <div className="work-package-card__touches">
                {activity.touched.map((touch) => (
                  <button
                    type="button"
                    className="work-package-card__file"
                    key={`${activity.turnId}:${touch.path}`}
                    onClick={() => onOpenFile({ activity, touch })}
                    title={`Open history for ${touch.path}`}
                  >
                    <span>{touch.path}</span>
                    <small>{touch.op}</small>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="work-package-card__secondary"
                onClick={() => onOpenTurnDiff(activity)}
                data-testid={`turn-diff-${activity.turnId}`}
              >
                Turn diff
              </button>
            </div>
          ))
        ) : (
          <span className="work-package-card__quiet">No open-turn activity</span>
        )}
      </div>

      {card.durableTurns.length > 0 && (
        <div className="work-package-card__trail" aria-label="Durable turn evidence">
          {card.durableTurns.slice(0, 3).map((turn) => (
            <div key={turn.turnId} className="work-package-card__trail-row">
              <span>Turn {turn.turnSeq}</span>
              <button type="button" onClick={() => onRestoreTurn(turn)}>
                Restore…
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className="work-package-card__warning-slot"
        data-testid={`contention-slot-${card.packageId}`}
        aria-hidden="true"
      />

      <footer className="work-package-card__actions">
        <button type="button" disabled title="Package finalization lands in WP-P6D">
          Mark done
        </button>
        <button type="button" disabled title="Package commit lands in WP-P6D">
          Commit package
        </button>
      </footer>
    </article>
  );
}
