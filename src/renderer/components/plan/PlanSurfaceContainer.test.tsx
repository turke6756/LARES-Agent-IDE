// @vitest-environment jsdom
//
// WP5 mount container. Exercises the two jobs it owns: driving the sandboxed
// render pane (show on mount / hide on unmount + bounds handoff) and feeding the
// provenance rail from the IPC projection, re-fetching on the reparse nudge.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlanSurfaceContainer from './PlanSurfaceContainer';
import type { PlanActivityProjection, PlanActivityEvent, RepoActivityDetail } from '../../../shared/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// jsdom has no ResizeObserver; the bounds effect constructs one.
class FakeRO {
  observe() {}
  disconnect() {}
}

type SurfaceCb = (p: { planId: string; parseError: string | null; degradedFrom: 'memory' | 'snapshot' | 'empty' | null }) => void;
let surfaceCbs: SurfaceCb[] = [];

const projection = (over: Partial<PlanActivityProjection> = {}): PlanActivityProjection => ({
  planId: 'plan-1',
  sections: [{
    anchor: 'sec_a1', zone: 'goal', heading: 'Goal', tokenEstimate: 10, archived: false, eventCount: 0, lastEventAt: null,
    // Fix-4: witnessed per-section rollup (inert here — no repo activity by default).
    repoFilesRead: 0, repoFilesEdited: 0, repoFilesCreated: 0,
    testsRun: 0, testsPassed: 0, testsFailed: 0, lastCommit: null,
  }],
  parseError: null,
  warnings: [],
  events: [],
  ...over,
});

// A captured write event carrying a Tier-2 digest (counts only) — its expander
// triggers the Tier-3 `fetchEventDetail` round-trip.
const capturedEvent = (over: Partial<PlanActivityEvent> = {}): PlanActivityEvent => ({
  id: 'e1', agentId: 'agent-1', agentTitle: 'Worker 1', createdAt: '2026-07-05T00:00:00.000Z',
  observedSectionAnchor: 'sec_a1', dispatchedSectionAnchor: 'sec_a1', observedVia: 'edit-target',
  attributionConfidence: 'high', sectionMismatch: false, mismatchReason: null,
  claimedSectionAnchor: null, claimedPayload: null,
  // Render-side fields (PlanEventView) so it groups as a visible WRITE row.
  changeCount: 1, writtenSectionAnchors: ['sec_a1'],
  repoActivityDigest: {
    status: 'captured',
    totals: { filesRead: 14, filesEdited: 9, filesCreated: 2, fileEvents: 40, distinctFiles: 25, testsRun: 0, testsPassed: 0, testsFailed: 0 },
    line: 'witnessed: 9 repo files edited; 2 created; 14 read',
  },
  ...over,
}) as PlanActivityEvent;

const detail = (): RepoActivityDetail => ({
  planEventId: 'e1',
  files: {
    truncated: false,
    items: [
      { path: 'src/main/index.ts', operations: ['read', 'write'], counts: { read: 3, write: 1, create: 0 }, firstAt: 'a', lastAt: 'b' },
    ],
  },
  totals: { filesRead: 14, filesEdited: 9, filesCreated: 2, fileEvents: 40, distinctFiles: 25, testsRun: 0, testsPassed: 0, testsFailed: 0 },
  window: { sinceIso: 's', untilIso: 'u' },
});

let getProjection: ReturnType<typeof vi.fn>;
let paneShow: ReturnType<typeof vi.fn>;
let paneHide: ReturnType<typeof vi.fn>;
let paneSetBounds: ReturnType<typeof vi.fn>;

beforeEach(() => {
  surfaceCbs = [];
  getProjection = vi.fn(async () => projection());
  paneShow = vi.fn(async () => {});
  paneHide = vi.fn(async () => {});
  paneSetBounds = vi.fn(async () => {});
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeRO;
  (window as unknown as { api: unknown }).api = {
    plans: {
      getProjection,
      paneShow,
      paneHide,
      paneSetBounds,
      onSurfaceChanged: (cb: SurfaceCb) => {
        surfaceCbs.push(cb);
        return () => { surfaceCbs = surfaceCbs.filter((c) => c !== cb); };
      },
    },
  };
});

async function render(el: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(el); });
  return container;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('PlanSurfaceContainer', () => {
  it('shows the pane, streams bounds, and renders the rail from the projection on mount', async () => {
    const c = await render(<PlanSurfaceContainer planId="plan-1" />);
    expect(paneShow).toHaveBeenCalledWith('plan-1');
    expect(getProjection).toHaveBeenCalledWith('plan-1');
    // Bounds handoff fired at least once (leading call).
    expect(paneSetBounds).toHaveBeenCalled();
    // The document host div is present for the WebContentsView to glue onto.
    expect(c.querySelector('[data-testid="plan-doc-host"]')).not.toBeNull();
    // The provenance rail rendered (activity trail).
    expect(c.querySelector('[data-testid="plan-surface"]')).not.toBeNull();
    // The rail is the widened single-scroll column (WP1).
    expect(c.querySelector('.w-\\[384px\\]')).not.toBeNull();
  });

  it('re-fetches on the reparse nudge for this plan, and ignores other plans', async () => {
    await render(<PlanSurfaceContainer planId="plan-1" />);
    expect(getProjection).toHaveBeenCalledTimes(1);

    await act(async () => { surfaceCbs.forEach((cb) => cb({ planId: 'other', parseError: null, degradedFrom: null })); });
    expect(getProjection).toHaveBeenCalledTimes(1); // unchanged — different plan

    await act(async () => { surfaceCbs.forEach((cb) => cb({ planId: 'plan-1', parseError: 'boom', degradedFrom: 'memory' })); });
    expect(getProjection).toHaveBeenCalledTimes(2);
  });

  it('surfaces the degradation banner using degradedFrom from the change event', async () => {
    getProjection.mockResolvedValue(projection({ parseError: 'boom' }));
    const c = await render(<PlanSurfaceContainer planId="plan-1" />);
    await act(async () => { surfaceCbs.forEach((cb) => cb({ planId: 'plan-1', parseError: 'boom', degradedFrom: 'memory' })); });
    const banner = c.querySelector('[data-testid="plan-surface-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.className).toContain('plan-surface__banner--error');
  });

  it('hides the pane on unmount', async () => {
    await render(<PlanSurfaceContainer planId="plan-1" />);
    act(() => { root?.unmount(); root = null; });
    expect(paneHide).toHaveBeenCalled();
  });

  it('roots the surface at h-full (adopts the sibling-panel height convention, not flex-1)', async () => {
    const c = await render(<PlanSurfaceContainer planId="plan-1" />);
    const surfaceRoot = c.querySelector('[data-testid="plan-surface-container"]') as HTMLElement;
    expect(surfaceRoot).not.toBeNull();
    expect(surfaceRoot.classList.contains('h-full')).toBe(true);
    // flex-1 is a no-op inside the block mount wrapper — it must be gone.
    expect(surfaceRoot.classList.contains('flex-1')).toBe(false);
  });

  it('Tier-3: expanding a row fetches the projection scoped to that event id, without replacing the rail state', async () => {
    getProjection.mockImplementation(async (_planId: string, opts?: { eventDetailId?: string }) => {
      if (opts?.eventDetailId) return projection({ events: [capturedEvent()], eventDetail: detail() });
      return projection({ events: [capturedEvent()] });
    });
    const c = await render(<PlanSurfaceContainer planId="plan-1" />);
    // The initial load called getProjection with a single arg (no detail id).
    expect(getProjection).toHaveBeenCalledWith('plan-1');
    // The write row + its witnessed digest expander are present.
    const toggle = c.querySelector('[data-testid="repo-evidence-toggle"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();

    await act(async () => { toggle.click(); await Promise.resolve(); await Promise.resolve(); });

    // The Tier-3 fetch reached getProjection with the event id.
    expect(getProjection).toHaveBeenCalledWith('plan-1', { eventDetailId: 'e1' });
    // The drill-down file list rendered from the returned eventDetail.
    const files = c.querySelector('[data-testid="repo-evidence-files"]');
    expect(files).not.toBeNull();
    expect(files!.textContent).toContain('src/main/index.ts');
    // The rail (section trail) is untouched — the original event row is still there.
    expect(c.querySelectorAll('[data-testid="plan-event"]').length).toBe(1);
  });

  it('Tier-3: a null eventDetail from the fetch renders no file list (no crash)', async () => {
    getProjection.mockImplementation(async (_planId: string, opts?: { eventDetailId?: string }) => {
      if (opts?.eventDetailId) return projection({ events: [capturedEvent()], eventDetail: null });
      return projection({ events: [capturedEvent()] });
    });
    const c = await render(<PlanSurfaceContainer planId="plan-1" />);
    const toggle = c.querySelector('[data-testid="repo-evidence-toggle"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(getProjection).toHaveBeenCalledWith('plan-1', { eventDetailId: 'e1' });
    // Detail container opened but there is no file list (null detail).
    expect(c.querySelector('[data-testid="repo-evidence-files"]')).toBeNull();
    expect(c.querySelector('[data-testid="repo-evidence-error"]')).toBeNull();
  });

  it('registers a capture-phase scroll listener to re-stream the pane rect, and removes it on unmount', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    await render(<PlanSurfaceContainer planId="plan-1" />);
    const scrollAdd = addSpy.mock.calls.find(
      ([type, , opts]) => type === 'scroll' && !!(opts as AddEventListenerOptions)?.capture,
    );
    expect(scrollAdd).toBeDefined();
    const handler = scrollAdd![1];

    act(() => { root?.unmount(); root = null; });
    const scrollRemove = removeSpy.mock.calls.find(
      ([type, fn]) => type === 'scroll' && fn === handler,
    );
    expect(scrollRemove).toBeDefined();
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
