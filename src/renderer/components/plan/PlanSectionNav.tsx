import React from 'react';
import type { SectionGroup } from './plan-surface-model';

/** The side navigation pane for the plan surface: one entry per section group,
 *  clicking jumps (scroll-to) to that fully-expanded section in the trail. This
 *  replaces the old collapse/expand disclosure as the way a human moves around a
 *  long plan. `onJump` receives the group anchor; the parent scrolls its trail. */
function PlanSectionNav({
  groups,
  activeAnchor,
  onJump,
}: {
  groups: SectionGroup[];
  activeAnchor: string | null;
  onJump: (anchor: string) => void;
}): React.ReactElement | null {
  if (groups.length === 0) return null;
  return (
    <nav className="plan-nav" aria-label="Jump to plan section" data-testid="plan-section-nav">
      {groups.map((g) => (
        <button
          key={g.anchor}
          type="button"
          className={`plan-nav__item${g.archived ? ' plan-nav__item--archived' : ''}`}
          aria-current={g.anchor === activeAnchor ? 'true' : undefined}
          onClick={() => onJump(g.anchor)}
          title={`Jump to “${g.heading}”`}
        >
          <span className="plan-nav__label">{g.heading}</span>
          {/* GT-A A3.4 — writeCount is the primary number; presence is muted/secondary. */}
          {g.writeCount > 0 && (
            <span className="plan-nav__count" title={`${g.writeCount} writes`}>{g.writeCount}</span>
          )}
          {g.presenceCount > 0 && (
            <span className="plan-nav__count-muted" title={`${g.presenceCount} deliberation turns`}>
              · {g.presenceCount}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

export default PlanSectionNav;
