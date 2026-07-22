import { useEffect, useState } from 'react';
import type { ContinuationPhaseState } from '../../../shared/types';
import { continuationPhaseLabel } from './continuation-phase-view';

/** One compact line under the card header naming what the handoff is doing
 *  right now. The card is the progress surface (§6: no notification center, no
 *  card redesign), so this is deliberately one line and no chrome.
 *
 *  The `backoff` countdown is a RENDERER-LOCAL 1 s display timer off `retryAt` —
 *  main sends no countdown events, because a per-second IPC broadcast for a
 *  5-minute wait is pure noise on a rail whose whole point is legibility. */
export default function ContinuationPhaseLine({ state }: { state: ContinuationPhaseState }) {
  const ticking = state.phase === 'backoff' && state.retryAt !== undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking, state.retryAt]);

  const failed = state.phase === 'failed';
  return (
    <div
      className={`relative z-10 mb-1 text-[11px] font-semibold truncate ${
        failed ? 'text-accent-red' : 'csplit-on-label'
      }`}
      title={continuationPhaseLabel(state, now)}
      data-continuation-phase={state.phase}
    >
      {continuationPhaseLabel(state, now)}
    </div>
  );
}
