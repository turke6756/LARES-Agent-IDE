import React, { useEffect, useRef, useState } from 'react';
import './planSurface.css';
import {
  selectBannerState,
  groupEventsBySection,
  type PlanSectionView,
  type PlanEventView,
  type PlanProjectionView,
} from './plan-surface-model';
import PlanActivityTrail from './PlanActivityTrail';
import PlanSectionNav from './PlanSectionNav';
import type { FetchEventDetail } from './TrustedEventRow';
import CandidatePreview, { type CandidatePreviewSelection } from '../save/CandidatePreview';
import { useDashboardStore } from '../../stores/dashboard-store';
import MissionBoard from './MissionBoard';

/**
 * WP5 render-surface overlay. The plan document itself renders in a sandboxed
 * `WebContentsView` (main process, JS disabled); this React view is the
 * provenance layer that sits alongside it — the F-E degradation banner over
 * whatever projection was served, plus the section activity trail.
 *
 * The trail is rendered FULLY EXPANDED (no per-section collapse — that disclosure
 * was agent-token-budget machinery that leaked into the human view); a side
 * navigation pane jumps between sections via scroll-to.
 *
 * Props-driven so it stays pure and testable; a container wires the projection,
 * live sections, and `plan_events` from `read_plan_projection`.
 */
function PlanSurfaceView({
  projection,
  sections,
  events,
  onFetchEventDetail,
  workspaceId,
  candidateSelection,
}: {
  projection: PlanProjectionView;
  sections: PlanSectionView[];
  events: PlanEventView[];
  onFetchEventDetail?: FetchEventDetail;
  // SC-WP-3I — the plan lens's own preview. When a D-1-filtered whole-component
  // selection is resolved for this plan, render the SHARED `CandidatePreview`
  // component (reused verbatim, never forked): its verdicts come from the SAME WP-3G
  // service as the save lens (identical `candidateId`), the message body is editable,
  // and the `Lares-*` trailers render read-only. Absent ⇒ no preview (the engine
  // route is not yet wired, or the plan has nothing previewable).
  workspaceId?: string;
  candidateSelection?: CandidatePreviewSelection | null;
}): React.ReactElement {
  const banner = selectBannerState(projection);
  const groups = groupEventsBySection(sections, events);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [highlightAnchor, setHighlightAnchor] = useState<string | null>(null);
  // GT-C §3.3 — the surface owns the view-mode. 'section' is the only first-ship
  // structure (keeps PlanSectionNav targets); 'story' is an explicit flat,
  // oldest-first run narrative with the section nav hidden (no dangling targets).
  const [viewMode, setViewMode] = useState<'section' | 'story' | 'packages'>('section');
  const activePlanId = useDashboardStore((state) => {
    const activeTab = state.openTabs.find((tab) => tab.id === state.activeTabId);
    return activeTab?.kind === 'plan' ? activeTab.planId : null;
  });

  // default the active pill to the first section once groups arrive
  useEffect(() => {
    setActiveAnchor((a) => a ?? groups[0]?.anchor ?? null);
  }, [groups]);

  // scroll-spy: update the active pill as sections cross the top of the scroll region.
  // Guarded so jsdom (no IntersectionObserver) is a no-op.
  useEffect(() => {
    const rootEl = scrollRef.current;
    if (!rootEl || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const anchor = top?.target.getAttribute('data-nav-target');
        if (anchor) setActiveAnchor(anchor);
      },
      { root: rootEl, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    rootEl.querySelectorAll('[data-nav-target]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [groups]);

  const jump = (anchor: string): void => {
    setActiveAnchor(anchor);
    setHighlightAnchor(anchor);
    requestAnimationFrame(() => {
      // Scroll the rail's OWN container only — never `scrollIntoView`, which walks
      // every scrollable ancestor (including the overflow-hidden mount wrapper) and
      // shifts the whole layout with no way back. Compute the target's offset within
      // the scroll container via getBoundingClientRect deltas. The nav now lives
      // OUTSIDE this container (a static header above it), so no header-height
      // subtraction is needed — the heading lands at the top of the scrollport.
      const container = scrollRef.current;
      const el = container?.querySelector(`[data-nav-target="${anchor}"]`) as HTMLElement | null;
      if (!container || !el) return;
      const top =
        container.scrollTop +
        (el.getBoundingClientRect().top - container.getBoundingClientRect().top);
      container.scrollTo?.({ top, behavior: 'smooth' });
    });
    window.setTimeout(() => setHighlightAnchor((a) => (a === anchor ? null : a)), 1200);
  };

  return (
    <div className="plan-surface" data-testid="plan-surface">
      {banner.kind !== 'none' && (
        <div
          className={`plan-surface__banner plan-surface__banner--${banner.severity}`}
          role="alert"
          data-testid="plan-surface-banner"
        >
          {banner.message}
          {banner.warnings.length > 0 && (
            <ul className="plan-surface__banner-warnings">
              {banner.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {workspaceId && candidateSelection && (
        <div className="plan-surface__candidate" data-testid="plan-candidate-preview">
          <CandidatePreview
            workspaceId={workspaceId}
            selection={candidateSelection}
            title="Save this plan's work"
          />
        </div>
      )}
      <div className="plan-surface__viewtoggle" role="tablist" aria-label="Activity view" data-testid="plan-view-toggle">
        <button
          type="button"
          role="tab"
          className={`plan-surface__viewtab${viewMode === 'section' ? ' plan-surface__viewtab--active' : ''}`}
          aria-selected={viewMode === 'section'}
          onClick={() => setViewMode('section')}
          data-testid="plan-view-section"
        >
          By section
        </button>
        <button
          type="button"
          role="tab"
          className={`plan-surface__viewtab${viewMode === 'story' ? ' plan-surface__viewtab--active' : ''}`}
          aria-selected={viewMode === 'story'}
          onClick={() => setViewMode('story')}
          data-testid="plan-view-story"
        >
          Story
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
      {/* GT-C §3.3 — the section nav is meaningless in story mode (flat list, no
          scroll targets); hide it so there are no dangling jump destinations. */}
      {viewMode === 'section' && (
        <PlanSectionNav groups={groups} activeAnchor={activeAnchor} onJump={jump} />
      )}
      {viewMode === 'packages' ? (
        activePlanId ? (
          <MissionBoard planId={activePlanId} paneVisible />
        ) : (
          <div className="mission-board__empty" data-testid="mission-board-no-plan">
            No active plan selected.
          </div>
        )
      ) : (
        <div className="plan-surface__scroll" data-testid="plan-surface-scroll" ref={scrollRef}>
          <PlanActivityTrail
            groups={groups}
            events={events}
            viewMode={viewMode}
            highlightAnchor={highlightAnchor}
            onFetchEventDetail={onFetchEventDetail}
          />
        </div>
      )}
    </div>
  );
}

export default PlanSurfaceView;
