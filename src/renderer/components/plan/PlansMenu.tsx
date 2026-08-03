import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Icons from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { PlanListItem } from '../../../shared/types';
import PlanCard, { planLabel } from './PlanCard';
import ProposalReaderPane from './ProposalReaderPane';
import { suspendBrowserPane, resumeBrowserPane } from '../browser/useBrowserSuspension';

// WP5 mount: the toolbar affordance for opening a plan surface. Opens a card
// GALLERY (not a flat list) of the workspace's plan SURFACES — only `format:
// 'html'` rows, since markdown-adopted plans keep their home in the file tree.
// Each card shows the plan's title/slug, a description snippet, and updated time;
// clicking one opens/focuses its tab via `openPlanTab`. Mirrors the other toolbar
// buttons and adds NO new top-level navigation.

/** Only `html` rows are real plan surfaces; the DB also holds ~190 markdown rows
 *  adopted from `plans/*.md`, which belong in the file tree, not this gallery. */
function isPlanSurface(p: PlanListItem): boolean {
  return p.format === 'html';
}

interface PlansMenuProps {
  compact: boolean;
  // View tear-off (Plans detach): when the Plans view is torn off into its own
  // window the button ghosts + stops opening the gallery (the detached window owns
  // the plan surface). Dragging the button out is what triggers the detach.
  detached?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

export default function PlansMenu({ compact, detached = false, onDragStart, onDragEnd }: PlansMenuProps): React.ReactElement {
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const workspaces = useDashboardStore((s) => s.workspaces);
  const openPlanTab = useDashboardStore((s) => s.openPlanTab);
  const [open, setOpen] = useState(false);
  // WP-P1B: the read-only proposal / plan reader overlay (folder-aware).
  const [readerOpen, setReaderOpen] = useState(false);
  const [plans, setPlans] = useState<PlanListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    setPlans(null);
    window.api.plans
      .list(selectedWorkspaceId ?? undefined)
      .then((rows) => setPlans(rows))
      .catch(() => setError('Could not load plans'));
  }, [selectedWorkspaceId]);

  // Fetch fresh each time the menu opens (plans are created/renamed out-of-band).
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // ISSUE #2 — both the plan document and the browser page render in native
  // WebContentsViews that composite ABOVE renderer DOM; this z-30 popover cannot
  // beat them. While the gallery is open, hide the plan pane (visibility-only, no
  // reload) and suspend the browser pane (established ref-counted precedent). On
  // close/unmount the plan pane's own container re-shows the correct plan and the
  // browser pane resumes. This — not z-index — is what makes the gallery win.
  useEffect(() => {
    if (!open) return;
    void window.api.plans.paneSetVisible(false);
    suspendBrowserPane();
    return () => {
      void window.api.plans.paneSetVisible(true);
      resumeBrowserPane();
    };
  }, [open]);

  const pick = (p: PlanListItem) => {
    openPlanTab(p.id, planLabel(p), p.workspaceId);
    setOpen(false);
  };

  const surfaces = plans?.filter(isPlanSurface) ?? null;
  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;

  const openReader = () => {
    setOpen(false);
    setReaderOpen(true);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        data-testid="view-btn-plans"
        draggable={!detached}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={() => { if (!detached) setOpen((v) => !v); }}
        aria-disabled={detached}
        className={`ui-btn ui-btn-outline shrink-0 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium ${
          detached ? 'opacity-40 cursor-not-allowed' : open ? 'is-active' : ''
        }`}
        style={detached ? { borderStyle: 'dashed' } : undefined}
        title={detached ? 'Plans is open in a separate window — close it to restore' : 'Open a plan surface — drag out to open in its own window'}
      >
        <Icons.Map className="w-4 h-4 shrink-0" />
        {!compact && 'Plans'}
      </button>

      {open &&
        buttonRef.current &&
        createPortal(
          (() => {
            const r = buttonRef.current!.getBoundingClientRect();
            return (
              <div
                ref={popoverRef}
                className="fixed z-50 max-h-[70vh] overflow-y-auto panel-shell rounded-lg p-3 shadow-xl"
                style={{
                  top: r.bottom + 4,
                  right: Math.max(8, window.innerWidth - r.right),
                  width: `min(560px, ${window.innerWidth - 16}px)`,
                }}
                role="menu"
                data-testid="plans-gallery"
              >
                <button
                  onClick={openReader}
                  data-testid="open-proposal-reader"
                  className="mb-2 flex w-full items-center gap-2 rounded-md border border-white/10 px-2 py-1.5 text-left text-[12px] text-gray-300 hover:bg-white/[0.06] hover:text-gray-100"
                >
                  <Icons.BookOpen className="h-4 w-4 shrink-0 text-accent-blue" />
                  Browse proposals &amp; plans (read-only)
                </button>
                {error ? (
                  <div className="px-1 py-2 text-[12px] text-accent-red">{error}</div>
                ) : surfaces === null ? (
                  <div className="px-1 py-2 text-[12px] text-gray-400">Loading…</div>
                ) : surfaces.length === 0 ? (
                  <div className="px-1 py-2 text-[12px] text-gray-400">No plan surfaces in this workspace</div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {surfaces.map((p) => (
                      <PlanCard key={p.id} plan={p} onOpen={pick} />
                    ))}
                  </div>
                )}
              </div>
            );
          })(),
          document.body,
        )}

      {readerOpen && (
        <ProposalReaderPane
          workspaceRoot={selectedWorkspace?.path ?? null}
          pathType={selectedWorkspace?.pathType ?? 'windows'}
          workspaceId={selectedWorkspaceId}
          onClose={() => setReaderOpen(false)}
        />
      )}
    </div>
  );
}
