// @vitest-environment jsdom
//
// The read-only proposal / plan reader. Guarantees under test:
//   • `planning-reader:list` runs on mount; NO demand-probe fires on mount /
//     initial render / refresh.
//   • A user click that opens a document reads it AND fires exactly one
//     `reader_open` demand-probe.
//   • A plan-folder row enters the folder view: plan.md in the pane, a sibling
//     list, and a disk-derived intent lifecycle strip whose `ran` rung is
//     "unavailable (pre-ledger)" and never a self-declared orchestration id.
//   • Empty / no-workspace states render; the surface is read-only.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ProposalReaderPane from './ProposalReaderPane';
import type {
  PlanningReaderEntry,
  PlanningReaderListResult,
  PlanningReaderReadResult,
} from '../../../shared/types';

vi.mock('../browser/useBrowserSuspension', () => ({
  suspendBrowserPane: vi.fn(),
  resumeBrowserPane: vi.fn(),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let listMock: ReturnType<typeof vi.fn>;
let readMock: ReturnType<typeof vi.fn>;
let recordMock: ReturnType<typeof vi.fn>;

const PROPOSAL: PlanningReaderEntry = {
  entryId: 'e-prop',
  kind: 'proposal',
  title: 'auth-revamp',
  mtimeMs: Date.parse('2026-07-30T10:00:00Z'),
  documents: [
    { docId: 'd-prop', name: '2026-07-30-auth-revamp.md', category: 'proposal', sizeBytes: 100, mtimeMs: 0 },
  ],
};

const FOLDER: PlanningReaderEntry = {
  entryId: 'e-folder',
  kind: 'plan-folder',
  title: 'billing-plan',
  mtimeMs: Date.parse('2026-08-01T12:00:00Z'),
  planArtifactId: 'plan-1',
  planSku: 'BILL-1',
  documents: [
    { docId: 'd-plan', name: 'plan.md', category: 'plan', sizeBytes: 200, mtimeMs: 0 },
    { docId: 'd-delib', name: 'deliberation-1.md', category: 'deliberation', sizeBytes: 50, mtimeMs: 0 },
    { docId: 'd-res', name: 'research-1.md', category: 'research', sizeBytes: 60, mtimeMs: 0 },
  ],
  intents: [
    {
      intentId: 'PLAN-INTENT-abc',
      part: 'P1',
      kind: 'deliberation',
      targets: [{ provider: 'anthropic', model: 'opus' }],
      reason: null,
      supersedesIntentId: null,
      status: 'active',
      marked: true,
      ran: 'unavailable-pre-ledger',
      returned: true,
      fullyFoldedIn: false,
      outputs: [
        {
          relPath: 'deliberation-1.md',
          intentId: 'PLAN-INTENT-abc',
          orchestrationIdSelfDeclared: 'orch-SHOULD-NOT-RENDER',
          presentOnDisk: true,
          disposition: 'active',
          foldedIn: false,
          integrationNote: null,
        },
      ],
    },
  ],
};

function listResult(over?: Partial<PlanningReaderListResult>): PlanningReaderListResult {
  return { entries: [PROPOSAL, FOLDER], warnings: [], ...over };
}

function readResult(over?: Partial<PlanningReaderReadResult>): PlanningReaderReadResult {
  return { docId: 'd-prop', name: 'doc.md', content: '# Doc\n\nhello', truncated: false, sizeBytes: 10, ...over };
}

beforeEach(() => {
  listMock = vi.fn(async () => listResult());
  readMock = vi.fn(async () => readResult());
  recordMock = vi.fn(async () => ({ appended: true, duplicate: false }));
  (window as unknown as { api: unknown }).api = {
    planningReader: { list: listMock, read: readMock },
    demandProbe: { record: recordMock },
    plans: {},
  };
});

async function render(el: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(el); });
  // Let the mount `list` promise resolve + re-render.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

const pane = () => document.querySelector('[data-testid="proposal-reader-pane"]') as HTMLElement;
const entries = () => document.querySelectorAll('[data-testid="reader-entry"]');
const onClose = () => {};

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('ProposalReaderPane', () => {
  it('lists on mount and fires NO demand-probe on mount/refresh', async () => {
    await render(
      <ProposalReaderPane workspaceRoot="/ws" pathType="windows" workspaceId="ws-1" onClose={onClose} />,
    );
    expect(listMock).toHaveBeenCalledWith('/ws', 'windows');
    expect(entries().length).toBe(2);
    // The crux: no open was recorded just by mounting.
    expect(recordMock).not.toHaveBeenCalled();

    // A manual refresh is also not an open.
    const refresh = document.querySelector('[data-testid="reader-refresh"]') as HTMLButtonElement;
    await act(async () => { refresh.click(); });
    await flush();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('opens a proposal on click: reads the doc and records exactly one reader_open', async () => {
    readMock.mockResolvedValue(readResult({ docId: 'd-prop', name: 'auth.md', content: '# Auth\n\nbody' }));
    await render(
      <ProposalReaderPane workspaceRoot="/ws" pathType="windows" workspaceId="ws-1" onClose={onClose} />,
    );
    // Proposal row (FileText). Click it.
    const propRow = [...entries()].find((e) => e.getAttribute('data-entry-kind') === 'proposal') as HTMLButtonElement;
    await act(async () => { propRow.click(); });
    await flush();

    expect(readMock).toHaveBeenCalledWith('d-prop', 'windows');
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', kind: 'reader_open' }),
    );
    expect(pane().textContent).toContain('body');
  });

  it('folder view: shows siblings + lifecycle strip; sibling click reads + records', async () => {
    await render(
      <ProposalReaderPane workspaceRoot="/ws" pathType="windows" workspaceId="ws-1" onClose={onClose} />,
    );
    const folderRow = [...entries()].find((e) => e.getAttribute('data-entry-kind') === 'plan-folder') as HTMLButtonElement;
    // Opening the folder reads plan.md + one probe.
    readMock.mockResolvedValueOnce(readResult({ docId: 'd-plan', name: 'plan.md', content: '# Plan' }));
    await act(async () => { folderRow.click(); });
    await flush();

    expect(readMock).toHaveBeenLastCalledWith('d-plan', 'windows');
    expect(recordMock).toHaveBeenCalledTimes(1);

    // Siblings listed (deliberation + research), lifecycle strip present.
    const siblings = document.querySelectorAll('[data-testid="reader-sibling"]');
    expect(siblings.length).toBe(2);
    expect(document.querySelector('[data-testid="lifecycle-strip"]')).not.toBeNull();

    // Click a sibling → another read + another probe.
    readMock.mockResolvedValueOnce(readResult({ docId: 'd-delib', name: 'deliberation-1.md', content: '# Delib' }));
    await act(async () => { (siblings[0] as HTMLButtonElement).click(); });
    await flush();
    expect(readMock).toHaveBeenLastCalledWith('d-delib', 'windows');
    expect(recordMock).toHaveBeenCalledTimes(2);
  });

  it('lifecycle strip renders ran as unavailable and never leaks a self-declared orchestration id', async () => {
    await render(
      <ProposalReaderPane workspaceRoot="/ws" pathType="windows" workspaceId="ws-1" onClose={onClose} />,
    );
    const folderRow = [...entries()].find((e) => e.getAttribute('data-entry-kind') === 'plan-folder') as HTMLButtonElement;
    await act(async () => { folderRow.click(); });
    await flush();

    const strip = document.querySelector('[data-testid="lifecycle-strip"]') as HTMLElement;
    expect(strip.textContent).toContain('unavailable (pre-ledger)');
    expect(strip.textContent).not.toContain('orch-SHOULD-NOT-RENDER');
    // returned=true, fullyFoldedIn=false reflected on the rungs.
    expect(strip.querySelector('[data-testid="rung-returned"]')?.getAttribute('data-on')).toBe('true');
    expect(strip.querySelector('[data-testid="rung-folded-in"]')?.getAttribute('data-on')).toBe('false');
    // "a returned artifact implies work occurred" note is allowed.
    expect(strip.textContent).toContain('a returned artifact implies work occurred');
  });

  it('renders an empty state and does not call list when there is no workspace root', async () => {
    await render(
      <ProposalReaderPane workspaceRoot={null} pathType="windows" workspaceId={null} onClose={onClose} />,
    );
    expect(listMock).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="reader-empty"]')?.textContent).toContain('No workspace');
  });

  it('renders an empty state when the workspace has no proposals or plans', async () => {
    listMock.mockResolvedValue(listResult({ entries: [] }));
    await render(
      <ProposalReaderPane workspaceRoot="/ws" pathType="windows" workspaceId="ws-1" onClose={onClose} />,
    );
    expect(document.querySelector('[data-testid="reader-empty"]')?.textContent).toContain('No proposals or plans');
  });

  it('hides the native plan pane while the reader overlay is up', async () => {
    await render(
      <ProposalReaderPane workspaceRoot="/ws" pathType="windows" workspaceId="ws-1" onClose={onClose} />,
    );
  });

  // ── WP-P1C: Request-promotion affordance ──────────────────────────────────
  // The only non-read-only gesture. It logs EXACTLY ONE voluntary-eligible
  // `promotion_requested` demand-probe per gesture (no `feature_exercise` tag),
  // creates no plan/registry row, and is not spammable (once per entry).
  const promotionCalls = () =>
    recordMock.mock.calls.filter((c) => c[0]?.kind === 'promotion_requested');
  const requestBtn = () =>
    document.querySelector('[data-testid="request-promotion"]') as HTMLButtonElement | null;

  it('shows no promotion affordance until an entry is selected, and fires nothing on mount', async () => {
    await render(
      <ProposalReaderPane workspaceRoot="/ws" pathType="windows" workspaceId="ws-1" onClose={onClose} />,
    );
    expect(requestBtn()).toBeNull();
    expect(document.querySelector('[data-testid="promotion-recorded"]')).toBeNull();
    expect(promotionCalls().length).toBe(0);
  });

  it('records exactly one voluntary-eligible promotion_requested per gesture and confirms', async () => {
    await render(
      <ProposalReaderPane workspaceRoot="/ws" pathType="windows" workspaceId="ws-1" onClose={onClose} />,
    );
    const propRow = [...entries()].find((e) => e.getAttribute('data-entry-kind') === 'proposal') as HTMLButtonElement;
    await act(async () => { propRow.click(); });
    await flush();

    // Selecting fired a reader_open, but no promotion request yet.
    expect(promotionCalls().length).toBe(0);

    await act(async () => { requestBtn()!.click(); });
    await flush();

    expect(promotionCalls().length).toBe(1);
    const arg = promotionCalls()[0][0];
    expect(arg).toEqual(expect.objectContaining({ workspaceId: 'ws-1', kind: 'promotion_requested' }));
    // Voluntary-eligible: NO feature_exercise tag on the promotion event.
    expect('feature_exercise' in arg).toBe(false);
    // Button collapses into a confirmation; no request button remains.
    expect(requestBtn()).toBeNull();
    expect(document.querySelector('[data-testid="promotion-recorded"]')).not.toBeNull();
  });

  it('is not spammable: the confirmation replaces the button so a re-request cannot fire twice', async () => {
    await render(
      <ProposalReaderPane workspaceRoot="/ws" pathType="windows" workspaceId="ws-1" onClose={onClose} />,
    );
    const propRow = [...entries()].find((e) => e.getAttribute('data-entry-kind') === 'proposal') as HTMLButtonElement;
    await act(async () => { propRow.click(); });
    await flush();
    await act(async () => { requestBtn()!.click(); });
    await flush();
    // Reselecting the same entry does not revive the request button.
    await act(async () => { propRow.click(); });
    await flush();
    expect(requestBtn()).toBeNull();
    expect(document.querySelector('[data-testid="promotion-recorded"]')).not.toBeNull();
    expect(promotionCalls().length).toBe(1);
  });

  it('tracks per-entry: a second entry can be requested independently', async () => {
    await render(
      <ProposalReaderPane workspaceRoot="/ws" pathType="windows" workspaceId="ws-1" onClose={onClose} />,
    );
    const propRow = [...entries()].find((e) => e.getAttribute('data-entry-kind') === 'proposal') as HTMLButtonElement;
    const folderRow = [...entries()].find((e) => e.getAttribute('data-entry-kind') === 'plan-folder') as HTMLButtonElement;

    await act(async () => { propRow.click(); });
    await flush();
    await act(async () => { requestBtn()!.click(); });
    await flush();
    expect(promotionCalls().length).toBe(1);

    // Switch to the folder entry: its request button is available again.
    await act(async () => { folderRow.click(); });
    await flush();
    expect(requestBtn()).not.toBeNull();
    await act(async () => { requestBtn()!.click(); });
    await flush();
    expect(promotionCalls().length).toBe(2);
  });
});
