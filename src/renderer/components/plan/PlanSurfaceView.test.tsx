// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlanSurfaceView from './PlanSurfaceView';
import type { PlanSectionView, PlanEventView, RepoActivityDigest, RepoActivityDetail } from './plan-surface-model';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(el: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(el); });
  return container;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

const section = (over: Partial<PlanSectionView> = {}): PlanSectionView => ({
  anchor: 'sec_a1', heading: 'Goal', zone: 'goal', archived: false, eventCount: 0, lastEventAt: null, ...over,
});
// Default factory is a WRITE turn to sec_a1; presence turns override the effect set.
const event = (over: Partial<PlanEventView> = {}): PlanEventView => ({
  id: 'e1', agentId: 'agent-1', agentTitle: 'Worker 1', createdAt: '2026-07-05T00:00:00.000Z',
  observedSectionAnchor: 'sec_a1', dispatchedSectionAnchor: 'sec_a1', observedVia: 'edit-target',
  attributionConfidence: 'high', sectionMismatch: false, mismatchReason: null,
  changeCount: 1, writtenSectionAnchors: ['sec_a1'], ...over,
});
const presence = (over: Partial<PlanEventView> = {}): PlanEventView =>
  event({ changeCount: 0, writtenSectionAnchors: [], ...over });

const capturedDigest = (over: Partial<RepoActivityDigest> = {}): RepoActivityDigest => ({
  status: 'captured',
  totals: {
    filesRead: 14, filesEdited: 9, filesCreated: 2, fileEvents: 40, distinctFiles: 25,
    testsRun: 0, testsPassed: 0, testsFailed: 0,
  },
  line: 'witnessed: 9 repo files edited; 2 created; 14 read',
  ...over,
});

describe('PlanSurfaceView', () => {
  it('renders a parse-error banner over the served projection (F-E)', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: 'boom', warnings: [], degradedFrom: 'memory' }}
        sections={[section()]}
        events={[event()]}
      />,
    );
    const banner = c.querySelector('[data-testid="plan-surface-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.className).toContain('plan-surface__banner--error');
    // The trail still renders under the banner — degradation never blanks the pane.
    expect(c.querySelector('[data-testid="plan-trail"]')).not.toBeNull();
  });

  it('renders sections fully expanded (no collapse toggle) — rows visible without interaction', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section()]}
        events={[event({ claimedSectionAnchor: 'sec_b2', claimedPayload: { note: 'done' } })]}
      />,
    );
    // No disclosure chevron / toggle button remains in the trail.
    expect(c.querySelector('.plan-section-group__disclosure')).toBeNull();
    // Rows are visible immediately — nothing to expand.
    const trusted = c.querySelector('[data-testid="trusted-row"]');
    const claimed = c.querySelector('[data-testid="claimed-payload"]');
    expect(trusted).not.toBeNull();
    expect(claimed).not.toBeNull();
    expect(trusted!.contains(claimed!)).toBe(false); // structurally distinct
    expect(claimed!.textContent).toMatch(/self-report/i);
  });

  it('renders a side navigation pane; clicking an entry scrolls the rail container (not scrollIntoView) and marks it active', () => {
    // The jump must scroll the rail's OWN container, never scrollIntoView (which
    // walks every scrollable ancestor and shifts the whole clipped layout).
    const intoViewSpy = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = intoViewSpy;
    // Run rAF synchronously so the scroll fires within the test.
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => { cb(0); return 0; });
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[
          section({ anchor: 'sec_a1', heading: 'Goal' }),
          section({ anchor: 'sec_b2', heading: 'Plan' }),
        ]}
        events={[event()]}
      />,
    );
    // Spy on the rail's OWN scroll container so we prove that — not an ancestor — is scrolled.
    const scrollContainer = c.querySelector('[data-testid="plan-surface-scroll"]') as HTMLElement;
    expect(scrollContainer).not.toBeNull();
    const scrollToSpy = vi.fn();
    (scrollContainer as unknown as { scrollTo: unknown }).scrollTo = scrollToSpy;
    const nav = c.querySelector('[data-testid="plan-section-nav"]');
    expect(nav).not.toBeNull();
    const navBtns = nav!.querySelectorAll('.plan-nav__item');
    const goalBtn = navBtns[1] as HTMLButtonElement; // "Plan" section, not the default-active first
    expect(goalBtn.textContent).toMatch(/Plan/);
    act(() => { goalBtn.click(); });
    // Scrolls the scroll container, and never the layout-shifting scrollIntoView.
    expect(scrollToSpy).toHaveBeenCalled();
    expect(intoViewSpy).not.toHaveBeenCalled();
    expect(goalBtn.getAttribute('aria-current')).toBe('true');
    rafSpy.mockRestore();
  });

  it('flashes the matching section when its nav pill is clicked', () => {
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn();
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => { cb(0); return 0; });
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1', heading: 'Goal' })]}
        events={[event()]}
      />,
    );
    const navBtn = c.querySelector('.plan-nav__item') as HTMLButtonElement;
    act(() => { navBtn.click(); });
    const flashed = c.querySelector('.plan-section-group--flash');
    expect(flashed).not.toBeNull();
    expect(flashed!.getAttribute('data-nav-target')).toBe('sec_a1');
    rafSpy.mockRestore();
  });

  it('renders every nav pill for a many-section plan (wrapping index, no truncation)', () => {
    const sections = Array.from({ length: 14 }, (_, i) =>
      section({ anchor: `sec_${i}`, heading: `Section ${i}` }),
    );
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={sections}
        events={[]}
      />,
    );
    const nav = c.querySelector('[data-testid="plan-section-nav"]');
    expect(nav).not.toBeNull();
    expect(nav!.querySelectorAll('.plan-nav__item').length).toBe(14);
  });

  it('renders orphan events under an "Archived section" header (F-E, open by default)', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1' })]}
        events={[event({ id: 'orphan', writtenSectionAnchors: ['sec_gone'], observedSectionAnchor: 'sec_gone' })]}
      />,
    );
    const archived = c.querySelector('.plan-section-group--archived');
    expect(archived).not.toBeNull();
    expect(archived!.textContent).toMatch(/Archived section/);
    // Orphan group defaults open, so the trusted row is already visible.
    expect(archived!.querySelector('[data-testid="trusted-row"]')).not.toBeNull();
  });

  it('surfaces a section-mismatch flag in the trusted row', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section()]}
        events={[event({ sectionMismatch: true, mismatchReason: 'intent-effect-divergence' })]}
      />,
    );
    // No expand step — the mismatch flag is visible in the always-open trail.
    expect(c.querySelector('.mismatch-flag')).not.toBeNull();
  });

  it('shows anchor-repair warnings as a warn banner when the parse succeeded', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: ['duplicate data-anchor sec_a1'] }}
        sections={[section()]}
        events={[]}
      />,
    );
    const banner = c.querySelector('[data-testid="plan-surface-banner"]');
    expect(banner!.className).toContain('plan-surface__banner--warn');
    expect(banner!.textContent).toMatch(/duplicate data-anchor/);
  });

  it('renders writes before collapsed presence, with presence hidden by default (I-3)', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1' })]}
        events={[
          event({ id: 'w1', writtenSectionAnchors: ['sec_a1'] }),
          presence({ id: 'p1', dispatchedSectionAnchor: 'sec_a1' }),
          presence({ id: 'p2', dispatchedSectionAnchor: 'sec_a1' }),
        ]}
      />,
    );
    // The write row is visible; the presence rows are collapsed behind a muted toggle.
    const events = c.querySelectorAll('[data-testid="plan-event"]');
    expect(events.length).toBe(1); // only the write row is rendered until presence expands
    const toggle = c.querySelector('[data-testid="plan-presence-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toMatch(/2 deliberation turns — no changes/);
    expect(c.querySelector('[data-testid="plan-presence-body"]')).toBeNull();
    // Expanding reveals the two presence rows.
    act(() => { (toggle as HTMLButtonElement).click(); });
    expect(c.querySelectorAll('[data-testid="plan-event"]').length).toBe(3);
  });

  it('renders a claim-first headline (claim result) with the trusted row demoted beneath', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1' })]}
        events={[event({ claimedPayload: { status: 'integrated', result: 'wired the toggle' } })]}
      />,
    );
    const headline = c.querySelector('[data-testid="plan-event-headline"]');
    expect(headline!.textContent).toMatch(/wired the toggle/);
    // The trusted attribution row is still present (demoted, never removed).
    const eventEl = c.querySelector('[data-testid="plan-event"]')!;
    expect(eventEl.querySelector('[data-testid="trusted-row"]')).not.toBeNull();
  });

  it('falls back to the observed-via label as the headline when there is no claim', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1' })]}
        events={[event({ observedVia: 'fs-diff', claimedPayload: null })]}
      />,
    );
    expect(c.querySelector('[data-testid="plan-event-headline"]')!.textContent).toMatch(/Observed via file diff/);
  });

  it('marks a write row "✎ wrote" and a presence row "· note" (keyed on changeCount)', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1' })]}
        events={[
          event({ id: 'w1', writtenSectionAnchors: ['sec_a1'] }),
          presence({ id: 'p1', dispatchedSectionAnchor: 'sec_a1' }),
        ]}
      />,
    );
    // Write marker visible up-front.
    const writeMarker = c.querySelector('[data-testid="trusted-row-marker"]');
    expect(writeMarker!.textContent).toMatch(/✎ wrote/);
    // Expand presence to see the note marker.
    act(() => { (c.querySelector('[data-testid="plan-presence-toggle"]') as HTMLButtonElement).click(); });
    const markers = Array.from(c.querySelectorAll('[data-testid="trusted-row-marker"]')).map((m) => m.textContent);
    expect(markers).toContain('· note');
  });

  it('shows a "wrote N sections" affordance from writtenSectionAnchors.length (not changeCount)', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1' }), section({ anchor: 'sec_b2' })]}
        // change_count is raw cardinality (5) — the affordance must count the effect set (2).
        events={[event({ id: 'm', changeCount: 5, writtenSectionAnchors: ['sec_a1', 'sec_b2'] })]}
      />,
    );
    const spanned = c.querySelector('.trusted-row__spanned');
    expect(spanned).not.toBeNull();
    expect(spanned!.textContent).toMatch(/wrote 2 sections/);
  });

  it('§3.6: shows an honest "spanned N sections" hint from observedCandidates on an uncertain turn', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1' })]}
        // Low-confidence: no confident effect set, but the resolver saw 3 candidates.
        events={[event({
          changeCount: 0, writtenSectionAnchors: [], dispatchedSectionAnchor: 'sec_a1',
          observedCandidates: ['sec_a1', 'sec_b2', 'sec_c3'], observedVia: 'multi-section',
          attributionConfidence: 'low',
        })]}
      />,
    );
    // The event is a presence turn here (no effect set) — expand to see its row.
    act(() => { (c.querySelector('[data-testid="plan-presence-toggle"]') as HTMLButtonElement).click(); });
    const spanned = c.querySelector('.trusted-row__spanned--candidates');
    expect(spanned).not.toBeNull();
    expect(spanned!.textContent).toMatch(/spanned 3 sections/);
  });

  it('§3.6: suppresses the observedCandidates hint once "wrote N sections" already conveys breadth', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1' }), section({ anchor: 'sec_b2' })]}
        events={[event({
          writtenSectionAnchors: ['sec_a1', 'sec_b2'],
          observedCandidates: ['sec_a1', 'sec_b2', 'sec_c3'],
        })]}
      />,
    );
    expect(c.querySelector('.trusted-row__spanned--candidates')).toBeNull();
    expect(c.querySelector('.trusted-row__spanned')).not.toBeNull(); // the "wrote N" one is present
  });

  it('Story toggle switches to a flat oldest-first list AND hides the section nav (§3.3)', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1', heading: 'Goal' }), section({ anchor: 'sec_b2', heading: 'Plan' })]}
        events={[
          event({ id: 'a', createdAt: '2026-07-05T01:00:00.000Z', writtenSectionAnchors: ['sec_a1'] }),
          event({ id: 'b', createdAt: '2026-07-05T02:00:00.000Z', writtenSectionAnchors: ['sec_b2'] }),
        ]}
      />,
    );
    // Section mode: nav present, groups rendered.
    expect(c.querySelector('[data-testid="plan-section-nav"]')).not.toBeNull();
    expect(c.querySelector('.plan-section-group')).not.toBeNull();
    // Flip to Story.
    act(() => { (c.querySelector('[data-testid="plan-view-story"]') as HTMLButtonElement).click(); });
    // Nav is hidden and there is no section grouping — just a flat list.
    expect(c.querySelector('[data-testid="plan-section-nav"]')).toBeNull();
    expect(c.querySelector('.plan-section-group')).toBeNull();
    expect(c.querySelector('.plan-trail--story')).not.toBeNull();
    // Both events show as flat rows, oldest-first.
    const rows = c.querySelectorAll('[data-testid="plan-event"]');
    expect(rows.length).toBe(2);
  });
});

describe('PlanSurfaceView — Fix-4 §6 witnessed repo activity', () => {
  it('shows the per-section repo counts on the chip; zero → hidden', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1', repoFilesRead: 14, repoFilesEdited: 9, repoFilesCreated: 2 })]}
        events={[event({ writtenSectionAnchors: ['sec_a1'] })]}
      />,
    );
    const chip = c.querySelector('[data-testid="section-repo-counts"]')!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toMatch(/9 edited/);
    expect(chip.textContent).toMatch(/2 created/);
    expect(chip.textContent).toMatch(/14 read/);
  });

  it('hides the section repo chip entirely when all counts are zero', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1', repoFilesRead: 0, repoFilesEdited: 0, repoFilesCreated: 0 })]}
        events={[event()]}
      />,
    );
    expect(c.querySelector('[data-testid="section-repo-counts"]')).toBeNull();
  });

  it('renders the witnessed evidence line as a DISTINCT element from the claimed-payload block', () => {
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1' })]}
        events={[event({
          repoActivityDigest: capturedDigest(),
          claimedSectionAnchor: 'sec_a1',
          claimedPayload: { note: 'did the thing' },
        })]}
        onFetchEventDetail={vi.fn()}
      />,
    );
    const evidence = c.querySelector('[data-testid="repo-evidence"]');
    const claimed = c.querySelector('[data-testid="claimed-payload"]');
    expect(evidence).not.toBeNull();
    expect(claimed).not.toBeNull();
    // Evidence ≠ narrative: neither element is nested inside the other.
    expect(evidence!.contains(claimed!)).toBe(false);
    expect(claimed!.contains(evidence!)).toBe(false);
    // The frozen digest line is the evidence text; the claimed payload is separate.
    expect(evidence!.textContent).toMatch(/witnessed: 9 repo files edited/);
    expect(claimed!.textContent).toMatch(/self-report/i);
  });

  it('threads onFetchEventDetail down to the row and fires it with event.id on expand', async () => {
    const onFetch = vi.fn<[string], Promise<RepoActivityDetail | null>>(async () => null);
    const c = render(
      <PlanSurfaceView
        projection={{ parseError: null, warnings: [] }}
        sections={[section({ anchor: 'sec_a1' })]}
        events={[event({ id: 'evt-9', writtenSectionAnchors: ['sec_a1'], repoActivityDigest: capturedDigest() })]}
        onFetchEventDetail={onFetch}
      />,
    );
    const toggle = c.querySelector('[data-testid="repo-evidence-toggle"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    await act(async () => { toggle.click(); await Promise.resolve(); });
    expect(onFetch).toHaveBeenCalledTimes(1);
    expect(onFetch).toHaveBeenCalledWith('evt-9');
  });
});
