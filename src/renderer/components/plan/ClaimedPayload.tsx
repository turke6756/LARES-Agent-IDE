import React from 'react';
import { toClaimedPayload, type PlanEventView } from './plan-surface-model';

/** The CLAIMED self-report block (tier-2): the agent's own account of what it
 *  worked on. It is diagnostics-only and NEVER merged into the trusted row —
 *  the dashed, muted styling and the explicit "self-report" label keep the
 *  distinction unmistakable. When the agent made no claim we say so plainly
 *  ("no self-report") rather than fabricating attribution. */
function ClaimedPayload({ event }: { event: PlanEventView }): React.ReactElement {
  const claimed = toClaimedPayload(event);

  if (!claimed.present) {
    return (
      <div className="claimed-payload claimed-payload--absent" data-testid="claimed-payload">
        <span className="claimed-payload__label">Claimed</span> — no self-report
      </div>
    );
  }

  return (
    <div className="claimed-payload" data-testid="claimed-payload">
      <span className="claimed-payload__label">Claimed (self-report)</span>
      {claimed.claimedSectionAnchor && (
        <>
          {' '}→ <code>{claimed.claimedSectionAnchor}</code>
          {claimed.divergesFromObserved && (
            <span className="claimed-payload__diverges" title="Claimed section differs from observed">
              ≠ observed
            </span>
          )}
        </>
      )}
      {claimed.entries.length > 0 && (
        <ul className="claimed-payload__entries">
          {claimed.entries.map((e) => (
            <li key={e.key}>
              <span className="claimed-payload__key">{e.key}:</span>
              <span>{e.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default ClaimedPayload;
