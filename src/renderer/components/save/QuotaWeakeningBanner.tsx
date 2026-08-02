import React from 'react';
import * as Icons from 'lucide-react';
import type { SaveCardQuotaWeakening } from '../../../shared/commit-candidates';

/**
 * SC-WP-2L — retention quota-weakening banner.
 *
 * The Save card stays silent about retention (Amendment 4: "protect, don't nag")
 * until the pin quota (or max-extension) genuinely forces the release of a
 * still-dirty recovery edge. Only then does this single honest line appear —
 * "uncommitted work is eating recovery space — time to save."
 *
 * Render discipline: the warning object is emitted by the WP-2K policy ONLY when
 * at least one still-dirty edge weakens, but we defensively re-check
 * `releasedEdges` here so an empty list can never surface a banner. The warning
 * carries dirty-entry / turn identities only — never raw paths — so nothing here
 * risks leaking a filesystem path.
 */
export default function QuotaWeakeningBanner({
  warning,
}: {
  warning: SaveCardQuotaWeakening | null;
}): React.ReactElement | null {
  if (!warning || warning.releasedEdges.length === 0) return null;

  const pathCount = warning.willWeakenPaths.length;
  const pathLabel = pathCount === 1 ? '1 change' : `${pathCount} changes`;

  return (
    <div className="sc-quota-banner" role="status" data-testid="save-card-quota-weakening">
      <Icons.ShieldAlert size={17} className="sc-quota-icon" aria-hidden="true" />
      <div className="sc-quota-text">
        <div className="sc-quota-title">
          Uncommitted work is eating recovery space — time to save.
        </div>
        <div className="sc-quota-sub">
          Recovery space is full, so the automatic checkpoint protecting {pathLabel} can no longer
          be held and will begin thinning. Saving this work makes it permanent.
        </div>
      </div>
    </div>
  );
}
