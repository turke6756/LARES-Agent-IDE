import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import PlanSurfaceView from './PlanSurfaceView';
import PlanDocumentTabs from './PlanDocumentTabs';
import type { PlanSectionView, PlanEventView, PlanProjectionView } from './plan-surface-model';
import type { FetchEventDetail } from './TrustedEventRow';
import type { CandidatePreviewSelection } from '../save/CandidatePreview';
import { throttle } from '../browser/throttle';
import { useDashboardStore } from '../../stores/dashboard-store';

// WP5 mount container. Two jobs, both driven off `planId`:
//
//  1. Drive the sandboxed render pane. The plan *document* lives in a main-process
//     `WebContentsView` (JS disabled), which paints ABOVE renderer DOM — so we
//     stream this host <div>'s rectangle to main (throttled, ~one per frame, the
//     SAME handoff BrowserViewHost uses) and show/hide the pane as this plan tab
//     gains/loses focus (mount ⇒ show, unmount ⇒ hide). The provenance rail is a
//     flex sibling, so the host rect naturally excludes it and the view never
//     paints over it.
//
//  2. Feed the provenance rail. Fetches the full projection over IPC (the
//     in-process mirror of GET /api/plans/:id/projection?events=full) and re-fetches
//     on the WP4 reparse nudge (`onSurfaceChanged`) for this plan — a full
//     re-render off the fresh projection, never in-place patching.

const BOUNDS_THROTTLE_MS = 16;

const EMPTY_PROJECTION: PlanProjectionView = { parseError: null, warnings: [], degradedFrom: null };

export default function PlanSurfaceContainer({ planId }: { planId: string }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [sections, setSections] = useState<PlanSectionView[]>([]);
  const [events, setEvents] = useState<PlanEventView[]>([]);
  const [projection, setProjection] = useState<PlanProjectionView>(EMPTY_PROJECTION);
  // SC-WP-3I — the plan lens's D-1-filtered whole-component selection, resolved
  // main-side via the read-only plan-lens preview channel and handed to the shared
  // CandidatePreview component. Null until resolved (or while the engine route is
  // unwired) so the surface simply omits the preview rather than erroring.
  const [candidateSelection, setCandidateSelection] = useState<CandidatePreviewSelection | null>(null);
  // WP-P4B.1 — which document surface the left pane shows. Legacy `format:'html'`
  // plans keep the sandboxed WebContentsView (WP5); folder-native (structured)
  // plans render the WP-P4B tabbed document home. `null` while the format is
  // still resolving, so we neither show the pane nor mount the tabs prematurely.
  const [isLegacy, setIsLegacy] = useState<boolean | null>(null);

  const closeTab = useDashboardStore((s) => s.closeTab);
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);

  // Always-present dismiss for the plan pane. The pane is a native
  // WebContentsView painting ABOVE renderer DOM, so a reliable close matters
  // (BUG-47): hide the pane immediately, then close the owning plan tab. Finds
  // the tab by planId so it works no matter how the tab was opened.
  const dismiss = useCallback(() => {
    void window.api.plans.paneHide();
    const { openTabs, selectedWorkspaceId } = useDashboardStore.getState();
    const tab = openTabs.find(
      (t) => t.kind === 'plan' && t.planId === planId && t.workspaceId === selectedWorkspaceId,
    ) ?? openTabs.find((t) => t.kind === 'plan' && t.planId === planId);
    if (tab) closeTab(tab.id);
  }, [planId, closeTab]);

  // `degradedFrom` rides the change event, not the projection read; keep the
  // last value so a plain re-fetch doesn't drop the degradation banner.
  const degradedRef = useRef<PlanProjectionView['degradedFrom']>(null);

  const load = useCallback(async () => {
    const p = await window.api.plans.getProjection(planId);
    if (!p) {
      setSections([]);
      setEvents([]);
      setProjection({ parseError: 'Plan not found', warnings: [], degradedFrom: degradedRef.current });
      return;
    }
    // The IPC projection is field-for-field the view model (that endpoint was
    // built for this surface); the extra `tokenEstimate`/`planId` are ignored.
    setSections(p.sections as unknown as PlanSectionView[]);
    setEvents((p.events ?? []) as unknown as PlanEventView[]);
    setProjection({ parseError: p.parseError, warnings: p.warnings, degradedFrom: degradedRef.current });
  }, [planId]);

  // Fix-4 §6 — Tier-3 drill-down fetch. Re-requests the projection scoped to ONE
  // event (`eventDetailId`) and returns just that event's capped witnessed file
  // list; it must NOT touch section/events state (the detail stays local to the
  // expanded row). Opt-in token cost, fired only on first expand of a row.
  const fetchEventDetail = useCallback<FetchEventDetail>(
    async (eventId) => {
      const p = await window.api.plans.getProjection(planId, { eventDetailId: eventId });
      return p?.eventDetail ?? null;
    },
    [planId],
  );

  // Prime the rail on mount / plan switch. The rail serves BOTH surfaces, so it
  // loads unconditionally — independent of the format switch below.
  useEffect(() => {
    void load();
  }, [planId, load]);

  // WP-P4B.1 — resolve the plan format so the document pane can switch surfaces.
  // `plans.list()` with no workspace filter returns every workspace's plans, so
  // the id lookup works at both mount sites (FileViewerPanel + the detached
  // window); an unknown / failed lookup falls back to the folder-native surface
  // (the go-forward default). Prefer the selected workspace when known.
  useEffect(() => {
    let active = true;
    setIsLegacy(null);
    void window.api.plans
      .list(selectedWorkspaceId ?? undefined)
      .then((rows) => {
        if (!active) return;
        const row = rows.find((r) => r.id === planId);
        setIsLegacy(row ? row.format === 'html' : false);
      })
      .catch(() => {
        if (active) setIsLegacy(false);
      });
    return () => {
      active = false;
    };
  }, [planId, selectedWorkspaceId]);

  // Sandboxed WebContentsView lifecycle — ONLY for legacy html plans. Show on
  // entry, hide on exit. For a folder-native plan the tabs own the region, so we
  // never show the pane and proactively hide any pane a prior plan left up.
  useEffect(() => {
    if (isLegacy === true) {
      void window.api.plans.paneShow(planId);
      return () => {
        void window.api.plans.paneHide();
      };
    }
    if (isLegacy === false) {
      void window.api.plans.paneHide();
    }
    return undefined;
  }, [planId, isLegacy]);

  // SC-WP-3I — resolve the plan lens's whole-component candidate selection over the
  // read-only preview channel. Best-effort: any failure (including the engine route
  // not yet being wired) leaves the selection null, so the surface just omits the
  // preview instead of surfacing an error. A `SelectionPreview` with no members means
  // there is nothing to save for this plan yet — also omit.
  useEffect(() => {
    if (!selectedWorkspaceId) {
      setCandidateSelection(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const res = await window.api.plans.previewCandidate({
          workspaceId: selectedWorkspaceId,
          planId,
          selectedComponentIds: [],
          selectedUnattributedEntryIds: [],
          finalizationIds: [],
        });
        if (!active) return;
        const hasWork = res.candidate.members.length > 0;
        setCandidateSelection(hasWork ? res.selection : null);
      } catch {
        if (active) setCandidateSelection(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [planId, selectedWorkspaceId]);

  // Re-fetch + full re-render on the WP4 reparse nudge (this plan only).
  useEffect(() => {
    return window.api.plans.onSurfaceChanged((payload) => {
      if (payload.planId !== planId) return;
      degradedRef.current = payload.degradedFrom;
      void load();
    });
  }, [planId, load]);

  // Stream the document region's rectangle to main (same as the browser pane).
  // Only the legacy WebContentsView needs it; the folder-native tabs are plain
  // renderer DOM with no pane to position.
  useEffect(() => {
    if (isLegacy !== true) return;
    const el = hostRef.current;
    if (!el) return;
    const send = throttle(() => {
      const r = el.getBoundingClientRect();
      void window.api.plans.paneSetBounds({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    }, BOUNDS_THROTTLE_MS);
    send();
    const ro = new ResizeObserver(() => send());
    ro.observe(el);
    // ResizeObserver misses position-only shifts; window resize covers the common one.
    window.addEventListener('resize', send);
    // A capture-phase scroll listener catches ANY ancestor scrolling the host div
    // (a jump inside the rail, an outer pane scroll) — position-only shifts the
    // ResizeObserver can't see, which would otherwise leave the WebContentsView
    // painted at a stale rectangle.
    window.addEventListener('scroll', send, { capture: true, passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', send);
      window.removeEventListener('scroll', send, { capture: true });
      send.cancel();
    };
  }, [planId, isLegacy]);

  return (
    <div className="h-full flex min-h-0" data-testid="plan-surface-container">
      {/* Plan document region. Legacy html plans expose the host div the sandboxed
          WebContentsView glues onto; folder-native plans render the WP-P4B tabbed
          document home in the same region (rail untouched, to its right). */}
      <div className="flex-1 min-w-0 min-h-0" data-testid="plan-doc-region">
        {isLegacy === true ? (
          <div ref={hostRef} className="h-full w-full" data-testid="plan-doc-host" />
        ) : isLegacy === false ? (
          <PlanDocumentTabs planId={planId} />
        ) : (
          <div className="h-full w-full" data-testid="plan-doc-loading" />
        )}
      </div>
      {/* Provenance rail — renderer DOM beside the document (banner + section nav
          + activity trail). The view owns its own scroll region, so the rail is a
          plain flex column, not the scroll container. */}
      <div className="w-[384px] shrink-0 min-h-0 flex flex-col border-l dark:border-white/10 light:border-black/10">
        <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-b dark:border-white/10 light:border-black/10">
          <span className="text-[11px] uppercase tracking-wide text-gray-400">Plan activity</span>
          <button
            onClick={dismiss}
            className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-gray-200"
            title="Close plan"
            aria-label="Close plan"
            data-testid="plan-surface-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <PlanSurfaceView
          projection={projection}
          sections={sections}
          events={events}
          onFetchEventDetail={fetchEventDetail}
          workspaceId={selectedWorkspaceId ?? undefined}
          candidateSelection={candidateSelection}
        />
      </div>
    </div>
  );
}
