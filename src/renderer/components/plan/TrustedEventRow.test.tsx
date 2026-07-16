// @vitest-environment jsdom
//
// Fix-4 §6 — the per-row witnessed repo-activity evidence + Tier-3 drill-down. The
// row owns its own open/loading/error/detail state; these tests exercise the digest
// line (verbatim, never re-synthesized), the expander gate, and the fetch-once /
// cache-on-re-expand / retryable-error state machine.
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import TrustedEventRow from './TrustedEventRow';
import type { PlanEventView, RepoActivityDigest, RepoActivityDetail } from './plan-surface-model';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(el: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(el); });
  return container;
}

// A microtask flush wrapped in act() so React commits state set inside a resolved
// fetch promise.
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

const capturedDigest = (over: Partial<RepoActivityDigest> = {}): RepoActivityDigest => ({
  status: 'captured',
  totals: {
    filesRead: 14, filesEdited: 9, filesCreated: 2, fileEvents: 40, distinctFiles: 25,
    testsRun: 0, testsPassed: 0, testsFailed: 0,
  },
  line: 'witnessed: 9 repo files edited; 2 created; 14 read',
  ...over,
});

const event = (over: Partial<PlanEventView> = {}): PlanEventView => ({
  id: 'e1', agentId: 'agent-1', agentTitle: 'Worker 1', createdAt: '2026-07-05T00:00:00.000Z',
  observedSectionAnchor: 'sec_a1', dispatchedSectionAnchor: 'sec_a1', observedVia: 'edit-target',
  attributionConfidence: 'high', sectionMismatch: false, mismatchReason: null,
  changeCount: 1, writtenSectionAnchors: ['sec_a1'],
  repoActivityDigest: capturedDigest(),
  ...over,
});

const detail = (over: Partial<RepoActivityDetail> = {}): RepoActivityDetail => ({
  planEventId: 'e1',
  files: {
    truncated: false,
    items: [
      { path: 'src/main/index.ts', operations: ['read', 'write'], counts: { read: 3, write: 1, create: 0 }, firstAt: 'a', lastAt: 'b' },
      { path: 'src/shared/types.ts', operations: ['read'], counts: { read: 2, write: 0, create: 0 }, firstAt: 'a', lastAt: 'b' },
    ],
  },
  totals: {
    filesRead: 14, filesEdited: 9, filesCreated: 2, fileEvents: 40, distinctFiles: 25,
    testsRun: 0, testsPassed: 0, testsFailed: 0,
  },
  window: { sinceIso: 's', untilIso: 'u' },
  ...over,
});

describe('TrustedEventRow — witnessed digest line', () => {
  it('renders digest.line VERBATIM (does not re-synthesize from counts)', () => {
    const c = render(
      <TrustedEventRow
        event={event({ repoActivityDigest: capturedDigest({ line: 'witnessed: 7 repo files edited' }) })}
      />,
    );
    const evidence = c.querySelector('[data-testid="repo-evidence"]')!;
    expect(evidence.textContent).toContain('witnessed: 7 repo files edited');
    // The counts (9 edited) must NOT leak in — only the frozen line is shown.
    expect(evidence.textContent).not.toContain('9 repo files edited');
  });

  it('not-captured → muted pre-fix-4 label, NO expander', () => {
    const c = render(
      <TrustedEventRow
        event={event({ repoActivityDigest: { status: 'not-captured', totals: null, line: null } })}
        onFetchEventDetail={vi.fn()}
      />,
    );
    const line = c.querySelector('[data-testid="repo-evidence-line"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toMatch(/not captured \(pre-fix-4\)/);
    expect(c.querySelector('[data-testid="repo-evidence-toggle"]')).toBeNull();
  });

  it('missing digest (undefined) → muted pre-fix-4 label, NO expander', () => {
    const c = render(<TrustedEventRow event={event({ repoActivityDigest: undefined })} onFetchEventDetail={vi.fn()} />);
    expect(c.querySelector('[data-testid="repo-evidence-line"]')!.textContent).toMatch(/not captured/);
    expect(c.querySelector('[data-testid="repo-evidence-toggle"]')).toBeNull();
  });

  it('captured-empty (line === null) → renders no evidence block at all', () => {
    const c = render(
      <TrustedEventRow
        event={event({ repoActivityDigest: capturedDigest({ line: null }) })}
        onFetchEventDetail={vi.fn()}
      />,
    );
    expect(c.querySelector('[data-testid="repo-evidence"]')).toBeNull();
    expect(c.querySelector('[data-testid="repo-evidence-toggle"]')).toBeNull();
  });

  it('captured-with-line but NO fetch fn → shows the line, exposes no expander', () => {
    const c = render(<TrustedEventRow event={event()} />);
    expect(c.querySelector('[data-testid="repo-evidence-line"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="repo-evidence-toggle"]')).toBeNull();
  });
});

describe('TrustedEventRow — Tier-3 drill-down state machine', () => {
  it('expand fetches ONCE with event.id and renders the capped file list', async () => {
    const onFetch = vi.fn(async () => detail());
    const c = render(<TrustedEventRow event={event({ id: 'evt-42' })} onFetchEventDetail={onFetch} />);
    const toggle = c.querySelector('[data-testid="repo-evidence-toggle"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    await act(async () => { toggle.click(); });
    await flush();
    expect(onFetch).toHaveBeenCalledTimes(1);
    expect(onFetch).toHaveBeenCalledWith('evt-42');
    const files = c.querySelector('[data-testid="repo-evidence-files"]')!;
    expect(files.textContent).toContain('src/main/index.ts');
    expect(files.textContent).toContain('src/shared/types.ts');
    // path · ops · counts grammar present.
    expect(files.textContent).toMatch(/read, write/);
    expect(files.textContent).toMatch(/3 read, 1 edit/);
  });

  it('collapse → re-expand does NOT refetch (cached in row state)', async () => {
    const onFetch = vi.fn(async () => detail());
    const c = render(<TrustedEventRow event={event()} onFetchEventDetail={onFetch} />);
    const toggle = c.querySelector('[data-testid="repo-evidence-toggle"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); });   // expand → fetch
    await flush();
    await act(async () => { toggle.click(); });   // collapse
    await act(async () => { toggle.click(); });   // re-expand
    await flush();
    expect(onFetch).toHaveBeenCalledTimes(1);
    // Detail still rendered after re-expand.
    expect(c.querySelector('[data-testid="repo-evidence-files"]')).not.toBeNull();
  });

  it('a rejected fetch surfaces a retryable error affordance; retry re-fetches', async () => {
    const onFetch = vi
      .fn<[string], Promise<RepoActivityDetail | null>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(detail());
    const c = render(<TrustedEventRow event={event()} onFetchEventDetail={onFetch} />);
    const toggle = c.querySelector('[data-testid="repo-evidence-toggle"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    await flush();
    const err = c.querySelector('[data-testid="repo-evidence-error"]') as HTMLButtonElement;
    expect(err).not.toBeNull();
    expect(err.textContent).toMatch(/retry/i);
    expect(c.querySelector('[data-testid="repo-evidence-files"]')).toBeNull();
    // Retry re-fetches and renders the list.
    await act(async () => { err.click(); });
    await flush();
    expect(onFetch).toHaveBeenCalledTimes(2);
    expect(c.querySelector('[data-testid="repo-evidence-error"]')).toBeNull();
    expect(c.querySelector('[data-testid="repo-evidence-files"]')).not.toBeNull();
  });

  it('files.truncated surfaces a "+N more (capped)" affordance', async () => {
    const onFetch = vi.fn(async () =>
      detail({
        files: { truncated: true, items: detail().files.items },
        totals: { ...detail().totals, distinctFiles: 202 },
      }),
    );
    const c = render(<TrustedEventRow event={event()} onFetchEventDetail={onFetch} />);
    await act(async () => { (c.querySelector('[data-testid="repo-evidence-toggle"]') as HTMLButtonElement).click(); });
    await flush();
    const more = c.querySelector('[data-testid="repo-evidence-more"]')!;
    expect(more).not.toBeNull();
    // 202 distinct − 2 shown = 200 elided.
    expect(more.textContent).toMatch(/\+200 more \(capped\)/);
  });

  it('shows a spinner while the fetch is in flight', async () => {
    let resolveFetch: (d: RepoActivityDetail) => void = () => {};
    const onFetch = vi.fn(() => new Promise<RepoActivityDetail>((res) => { resolveFetch = res; }));
    const c = render(<TrustedEventRow event={event()} onFetchEventDetail={onFetch} />);
    await act(async () => { (c.querySelector('[data-testid="repo-evidence-toggle"]') as HTMLButtonElement).click(); });
    // Still pending — loading indicator visible, no file list yet.
    expect(c.querySelector('[data-testid="repo-evidence-loading"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="repo-evidence-files"]')).toBeNull();
    await act(async () => { resolveFetch(detail()); await Promise.resolve(); });
    await flush();
    expect(c.querySelector('[data-testid="repo-evidence-loading"]')).toBeNull();
    expect(c.querySelector('[data-testid="repo-evidence-files"]')).not.toBeNull();
  });
});
