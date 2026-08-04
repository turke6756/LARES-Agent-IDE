// @vitest-environment jsdom
//
// WP-P4C-editor — the in-place per-tab overview editor inside PlanDocumentTabs.
// Guarantees under test:
//   • The edit affordance is gated to supervisors: with no same-workspace
//     privileged agent, no edit control appears at all.
//   • With a supervisor present, the Overview tab exposes an "Edit" control that
//     opens an inline editor seeded with the current overview body.
//   • Saving calls `plans.setOverview` with the active PlanTabKey + the chosen
//     supervisor identity, then re-fetches `getOverview` so the shown revision
//     bumps.
//   • A populated tab with no overview shows "Add overview" and can author one.
//   • A server rejection (setOverview throws) keeps the editor open, surfaces the
//     reason, and does NOT assume the write landed.
//   • The Packages placeholder (populated:false) exposes no editor.
//   • With multiple supervisors, a picker is shown and its selection is sent.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlanDocumentTabs from './PlanDocumentTabs';
import { useDashboardStore } from '../../stores/dashboard-store';
import type {
  PlanDocumentsModel,
  PlanDocumentReadResult,
  PlanTabOverview,
} from '../../../shared/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let documentsMock: ReturnType<typeof vi.fn>;
let readDocumentMock: ReturnType<typeof vi.fn>;
let getOverviewMock: ReturnType<typeof vi.fn>;
let setOverviewMock: ReturnType<typeof vi.fn>;
// The overview store the mocked IPC reads/writes, keyed by tab. `setOverview`
// mutates it and bumps the revision; `getOverview` reflects the latest — exactly
// the round-trip the editor relies on to show a bumped revision after a save.
let overviews: Record<string, PlanTabOverview | null>;

function overview(over?: Partial<PlanTabOverview>): PlanTabOverview {
  return {
    planId: 'plan-1',
    tab: 'overview',
    body: 'Supervisor summary of the plan.',
    revision: 1,
    updatedBy: 'sup-1',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

function model(): PlanDocumentsModel {
  return {
    planId: 'plan-1',
    warnings: [],
    tabs: [
      {
        key: 'overview',
        populated: true,
        documents: [{ ref: { source: 'folder', documentId: 'd-arc' }, name: 'ARC.md', kind: 'arc', sizeBytes: 100, mtimeMs: 1 }],
      },
      {
        key: 'plan',
        populated: true,
        documents: [{ ref: { source: 'folder', documentId: 'd-plan' }, name: 'plan.md', kind: 'plan', sizeBytes: 200, mtimeMs: 1 }],
      },
      {
        key: 'packages',
        populated: false,
        documents: [],
        placeholder: 'not yet implemented — pull Implement to begin',
      },
    ],
  };
}

function readResult(over?: Partial<PlanDocumentReadResult>): PlanDocumentReadResult {
  return {
    ref: { source: 'folder', documentId: 'd-arc' },
    name: 'ARC.md',
    content: '# ARC\n\narc body',
    truncated: false,
    sizeBytes: 10,
    ...over,
  };
}

/** Seed the dashboard store with `n` privileged, same-workspace supervisors. */
function seedSupervisors(count: number): void {
  const agents = Array.from({ length: count }, (_v, i) => ({
    id: `sup-${i + 1}`,
    title: `Supervisor ${i + 1}`,
    workspaceId: 'ws-1',
    isSupervisor: true,
  }));
  useDashboardStore.setState({ agents: agents as never, selectedWorkspaceId: 'ws-1' } as never);
}

beforeEach(() => {
  overviews = { overview: overview() };
  documentsMock = vi.fn(async () => model());
  readDocumentMock = vi.fn(async (_planId: string, ref: { documentId: string }) => {
    const map: Record<string, string> = { 'd-arc': '# ARC\n\narc body', 'd-plan': '# Plan\n\nplan body' };
    return readResult({ ref: ref as PlanDocumentReadResult['ref'], name: `${ref.documentId}.md`, content: map[ref.documentId] ?? '' });
  });
  getOverviewMock = vi.fn(async (_planId: string, tab: string) => overviews[tab] ?? null);
  setOverviewMock = vi.fn(async (input: { planId: string; tab: string; body: string | null; supervisorId: string }) => {
    const prev = overviews[input.tab];
    const next: PlanTabOverview = {
      planId: input.planId,
      tab: input.tab as PlanTabOverview['tab'],
      body: input.body,
      revision: (prev?.revision ?? 0) + 1,
      updatedBy: input.supervisorId,
      createdAt: prev?.createdAt ?? '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
    };
    overviews[input.tab] = next;
    return next;
  });
  (window as unknown as { api: unknown }).api = {
    plans: { documents: documentsMock, readDocument: readDocumentMock, getOverview: getOverviewMock, setOverview: setOverviewMock },
  };
  // Default: no supervisors — the gated affordance stays hidden unless seeded.
  useDashboardStore.setState({ agents: [] as never, selectedWorkspaceId: null } as never);
});

async function render(el: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(el);
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  useDashboardStore.setState({ agents: [] as never, selectedWorkspaceId: null } as never);
  vi.clearAllMocks();
});

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
// React tracks the controlled value internally, so a bare `node.value = …` is
// deduped away; drive the native setter then fire `input` so onChange sees it.
function type(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}
const tabButtons = () => [...document.querySelectorAll('[data-testid="plan-tab"]')] as HTMLButtonElement[];
const tabByKey = (key: string) => tabButtons().find((b) => b.getAttribute('data-tab-key') === key)!;

describe('PlanDocumentTabs (WP-P4C-editor overview editor)', () => {
  it('shows NO edit affordance when there is no supervisor in the workspace', async () => {
    await render(<PlanDocumentTabs planId="plan-1" />);
    // Overview renders (WP-P4B) but the edit control is gated away.
    expect(q('plan-tab-overview-body')).not.toBeNull();
    expect(q('plan-overview-edit')).toBeNull();
  });

  it('a supervisor opens the inline editor seeded with the current overview body', async () => {
    seedSupervisors(1);
    await render(<PlanDocumentTabs planId="plan-1" />);

    const edit = q('plan-overview-edit') as HTMLButtonElement;
    expect(edit).not.toBeNull();
    expect(edit.textContent).toContain('Edit');

    await act(async () => {
      edit.click();
    });
    await flush();

    const textarea = q('plan-overview-textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe('Supervisor summary of the plan.');
    // Single supervisor ⇒ no picker.
    expect(q('plan-overview-supervisor-select')).toBeNull();
  });

  it('saving calls setOverview with the active key + supervisor, then re-fetches getOverview (revision bumps)', async () => {
    seedSupervisors(1);
    await render(<PlanDocumentTabs planId="plan-1" />);

    await act(async () => {
      (q('plan-overview-edit') as HTMLButtonElement).click();
    });
    await flush();

    const textarea = q('plan-overview-textarea') as HTMLTextAreaElement;
    await act(async () => {
      type(textarea, 'Rewritten overview.');
    });
    await flush();

    const getCallsBefore = getOverviewMock.mock.calls.length;
    await act(async () => {
      (q('plan-overview-save') as HTMLButtonElement).click();
    });
    await flush();

    expect(setOverviewMock).toHaveBeenCalledWith({
      planId: 'plan-1',
      tab: 'overview',
      body: 'Rewritten overview.',
      supervisorId: 'sup-1',
    });
    // Re-fetched after the write so the shown revision bumps.
    expect(getOverviewMock.mock.calls.length).toBeGreaterThan(getCallsBefore);
    expect(overviews.overview!.revision).toBe(2);
    // Editor closed; the new body is rendered.
    expect(q('plan-overview-textarea')).toBeNull();
    expect(q('plan-tab-overview-body')?.textContent).toContain('Rewritten overview.');
  });

  it('a populated tab with no overview offers "Add overview" and can author one', async () => {
    seedSupervisors(1);
    await render(<PlanDocumentTabs planId="plan-1" />);

    await act(async () => {
      tabByKey('plan').click();
    });
    await flush();
    // plan tab has no overview → pending + an add affordance.
    expect(q('plan-overview-pending')).not.toBeNull();
    const add = q('plan-overview-edit') as HTMLButtonElement;
    expect(add.textContent).toContain('Add overview');

    await act(async () => {
      add.click();
    });
    await flush();
    const textarea = q('plan-overview-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    await act(async () => {
      type(textarea, 'Plan tab overview.');
    });
    await flush();
    await act(async () => {
      (q('plan-overview-save') as HTMLButtonElement).click();
    });
    await flush();

    expect(setOverviewMock).toHaveBeenCalledWith({
      planId: 'plan-1',
      tab: 'plan',
      body: 'Plan tab overview.',
      supervisorId: 'sup-1',
    });
    expect(q('plan-tab-overview-body')?.textContent).toContain('Plan tab overview.');
  });

  it('a server rejection keeps the editor open, surfaces the reason, and does not assume success', async () => {
    seedSupervisors(1);
    setOverviewMock.mockRejectedValueOnce(new Error('not a supervisor'));
    await render(<PlanDocumentTabs planId="plan-1" />);

    await act(async () => {
      (q('plan-overview-edit') as HTMLButtonElement).click();
    });
    await flush();
    const textarea = q('plan-overview-textarea') as HTMLTextAreaElement;
    await act(async () => {
      type(textarea, 'Denied edit.');
    });
    await flush();
    await act(async () => {
      (q('plan-overview-save') as HTMLButtonElement).click();
    });
    await flush();

    // Editor still open, error shown, stored overview unchanged (rev still 1).
    expect(q('plan-overview-textarea')).not.toBeNull();
    expect(q('plan-overview-error')?.textContent).toContain('supervisor');
    expect(overviews.overview!.revision).toBe(1);
  });

  it('the Packages placeholder exposes no editor', async () => {
    seedSupervisors(1);
    await render(<PlanDocumentTabs planId="plan-1" />);
    await act(async () => {
      tabByKey('packages').click();
    });
    await flush();
    expect(q('plan-packages-placeholder')).not.toBeNull();
    expect(q('plan-tab-overview')).toBeNull();
    expect(q('plan-overview-edit')).toBeNull();
  });

  it('with multiple supervisors a picker is shown and its selection is sent', async () => {
    seedSupervisors(2);
    await render(<PlanDocumentTabs planId="plan-1" />);

    await act(async () => {
      (q('plan-overview-edit') as HTMLButtonElement).click();
    });
    await flush();

    const select = q('plan-overview-supervisor-select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.options.length).toBe(2);

    await act(async () => {
      select.value = 'sup-2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    await act(async () => {
      (q('plan-overview-save') as HTMLButtonElement).click();
    });
    await flush();

    expect(setOverviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ tab: 'overview', supervisorId: 'sup-2' }),
    );
  });
});
