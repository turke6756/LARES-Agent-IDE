import React, { useMemo, useState } from 'react';
import type { SaveCardPlanningActivityDto } from '../../../shared/types';

export interface PlanMergeBackProps {
  activity: SaveCardPlanningActivityDto;
  onPromoted?: () => void;
  onOpenMergeEditor?: (conflict: SaveCardPlanningActivityDto['conflicts'][number]) => void;
}

export default function PlanMergeBack({ activity, onPromoted, onOpenMergeEditor }: PlanMergeBackProps) {
  const [choices, setChoices] = useState<Record<string, 'keep-primary' | 'take-activity'>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const ready = useMemo(() => activity.conflicts.length > 0
    && activity.conflicts.every((conflict) => Boolean(choices[conflict.pathBytesBase64])),
  [activity.conflicts, choices]);

  if (activity.status !== 'merge-conflicted' || !activity.latestAttemptId) return null;
  const submit = async () => {
    if (!ready || busy || !activity.latestAttemptId) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.api.saveCard.resolveActivityMerge({
        attemptId: activity.latestAttemptId,
        resolutions: activity.conflicts.map((conflict) => ({
          pathBytesBase64: conflict.pathBytesBase64,
          resolution: choices[conflict.pathBytesBase64],
        })),
      });
      if (result.status === 'promoted') {
        setMessage('Promoted to main.');
        onPromoted?.();
      } else if (result.status === 'stale') {
        setMessage('Main changed again. Refresh to review the new merge.');
      } else {
        setMessage('Saved in plan; promotion pending.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Saved in plan; promotion pending.');
    } finally { setBusy(false); }
  };

  return (
    <section className="sc-slot-wrap" data-testid="plan-merge-back" aria-label={`Merge ${activity.planTitle} into main`}>
      <h3>{activity.planTitle} is saved in its activity worktree but cannot yet be promoted.</h3>
      <p>main changed since {activity.planTitle} began.</p>
      {activity.conflicts.map((conflict) => (
        <fieldset key={conflict.pathBytesBase64} data-testid="plan-merge-conflict">
          <legend>{conflict.displayPath}</legend>
          <div>Current main — includes other promoted plan work</div>
          <button type="button" aria-pressed={choices[conflict.pathBytesBase64] === 'keep-primary'}
            onClick={() => setChoices((current) => ({ ...current, [conflict.pathBytesBase64]: 'keep-primary' }))}>
            Keep current main
          </button>
          <div>This plan — {activity.planTitle}</div>
          <button type="button" aria-pressed={choices[conflict.pathBytesBase64] === 'take-activity'}
            onClick={() => setChoices((current) => ({ ...current, [conflict.pathBytesBase64]: 'take-activity' }))}>
            Take this plan
          </button>
          <div>Common base</div>
          <button type="button" onClick={() => onOpenMergeEditor?.(conflict)}>Open merge editor</button>
        </fieldset>
      ))}
      <button type="button" disabled={!ready || busy} onClick={() => { void submit(); }}>
        {busy ? 'Promoting…' : 'Apply resolutions and promote'}
      </button>
      {message && <div role="status">{message}</div>}
    </section>
  );
}
