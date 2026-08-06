// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Workspace } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import PromoteToPlanPanel from './PromoteToPlanPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const workspace = { id: 'ws-1', path: 'C:\\work', pathType: 'windows', title: 'Work' } as Workspace;
const proposalFilePath = 'C:\\work\\.lares\\proposals\\idea.md';
const validArtifactId = 'prop_0e1425af';
const agent = (id: string, title: string, status: Agent['status'], isSupervisor = true): Agent => ({
  id, title, status, isSupervisor, workspaceId: 'ws-1',
} as Agent);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let host: HTMLDivElement;
let root: Root;

async function renderPanel(proposalArtifactId: string | null = validArtifactId): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <PromoteToPlanPanel
        workspace={workspace}
        proposalFilePath={proposalFilePath}
        proposalArtifactId={proposalArtifactId}
        onClose={() => {}}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(selector: string): void {
  const element = host.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  act(() => element!.click());
}

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (window as unknown as { api: unknown }).api = {
    agents: {
      getSupervisor: vi.fn(async () => null),
      list: vi.fn(async () => useDashboardStore.getState().agents),
      sendInput: vi.fn(async () => undefined),
      launch: vi.fn(),
    },
    system: { getApiToken: vi.fn(async () => 'token') },
  };
  useDashboardStore.setState({ agents: [] });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PromoteToPlanPanel supervisor picker', () => {
  it('lists live and terminal structural supervisors plus the new path, excluding workers', async () => {
    useDashboardStore.setState({ agents: [
      agent('live', 'Live owner', 'idle'),
      agent('done', 'Done owner', 'done'),
      agent('worker', 'Ordinary worker', 'idle', false),
      { ...agent('foreign', 'Foreign owner', 'idle'), workspaceId: 'ws-2' },
    ] });
    await renderPanel();

    const text = host.textContent ?? '';
    expect(text).toContain('Live owner');
    expect(text).toContain('Done owner');
    expect(text).toContain('done · revive');
    expect(text).toContain('New supervisor');
    expect(text).not.toContain('Ordinary worker');
    expect(text).not.toContain('Foreign owner');
    expect(text).not.toContain('Idea');
    const options = [...host.querySelectorAll('[data-testid$="supervisor-option"]')];
    expect(options[0]?.getAttribute('data-testid')).toBe('promote-new-supervisor-option');
    expect(options.slice(1).map((option) => option.textContent)).toEqual([
      expect.stringContaining('Live owner'),
      expect.stringContaining('Done owner'),
    ]);
  });

  it('selects the resolved structural workspace supervisor by default', async () => {
    const supervisor = agent('default', 'Default owner', 'idle');
    useDashboardStore.setState({ agents: [supervisor] });
    vi.mocked(window.api.agents.getSupervisor).mockResolvedValue(supervisor);

    await renderPanel();

    expect(host.querySelector('[data-testid="promote-supervisor-option"]')?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(host.querySelector('[data-testid="promote-new-supervisor-option"]')?.getAttribute('aria-pressed'))
      .toBe('false');
  });

  it('visibly selects an API-resolved supervisor absent from the store', async () => {
    const supervisor = agent('api-only', 'API-only owner', 'idle');
    vi.mocked(window.api.agents.getSupervisor).mockResolvedValue(supervisor);

    await renderPanel();

    const option = host.querySelector('[data-testid="promote-supervisor-option"]');
    expect(option?.textContent).toContain('API-only owner');
    expect(option?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps New supervisor selected when structural resolution returns null', async () => {
    await renderPanel();

    expect(host.querySelector('[data-testid="promote-new-supervisor-option"]')?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(host.querySelector('[data-testid="promote-new-supervisor-title"]')).not.toBeNull();
  });

  it('does not overwrite a manual picker choice when default resolution arrives late', async () => {
    const late = deferred<Agent | null>();
    const manual = agent('manual', 'Manual owner', 'idle');
    const resolved = agent('resolved', 'Resolved owner', 'idle');
    useDashboardStore.setState({ agents: [manual] });
    vi.mocked(window.api.agents.getSupervisor).mockReturnValue(late.promise);
    await renderPanel();

    click('[data-testid="promote-supervisor-option"]');
    late.resolve(resolved);
    await flush();

    const options = [...host.querySelectorAll('[data-testid="promote-supervisor-option"]')];
    expect(options.find((option) => option.textContent?.includes('Manual owner'))?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(options.find((option) => option.textContent?.includes('Resolved owner'))?.getAttribute('aria-pressed'))
      .toBe('false');
  });

  it('does not overwrite a New-supervisor title edit when default resolution arrives late', async () => {
    const late = deferred<Agent | null>();
    vi.mocked(window.api.agents.getSupervisor).mockReturnValue(late.promise);
    await renderPanel();

    const title = host.querySelector<HTMLInputElement>('[data-testid="promote-new-supervisor-title"]')!;
    changeInput(title, 'My plan owner');
    late.resolve(agent('resolved', 'Resolved owner', 'idle'));
    await flush();

    expect(host.querySelector<HTMLInputElement>('[data-testid="promote-new-supervisor-title"]')?.value)
      .toBe('My plan owner');
    expect(host.querySelector('[data-testid="promote-new-supervisor-option"]')?.getAttribute('aria-pressed'))
      .toBe('true');
  });

  it('revives a terminal default supervisor', async () => {
    const terminal = agent('terminal', 'Terminal owner', 'done');
    useDashboardStore.setState({ agents: [terminal] });
    vi.mocked(window.api.agents.getSupervisor).mockResolvedValue(terminal);
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    await renderPanel();

    click('[data-testid="promote-dispatch"]');
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:24678/api/agents/terminal/revive',
      expect.objectContaining({ body: expect.stringContaining('Proposal artifact_id: prop_0e1425af') }),
    );
    expect(host.querySelector('[data-testid="promote-confirmation"]')?.textContent).toContain('(revived)');
  });
});

describe('PromoteToPlanPanel proposal artifact id', () => {
  it('enables dispatch for a valid id and sends that id in the instruction', async () => {
    const supervisor = agent('live', 'Live owner', 'idle');
    useDashboardStore.setState({ agents: [supervisor] });
    vi.mocked(window.api.agents.getSupervisor).mockResolvedValue(supervisor);
    await renderPanel(' prop_0e1425af ');

    const button = host.querySelector<HTMLButtonElement>('[data-testid="promote-dispatch"]')!;
    expect(button.disabled).toBe(false);
    click('[data-testid="promote-dispatch"]');
    await flush();

    expect(window.api.agents.sendInput).toHaveBeenCalledWith(
      'live',
      expect.stringContaining('Proposal artifact_id: prop_0e1425af'),
    );
  });

  it.each([
    ['missing', null],
    ['malformed', 'proposal_0e1425af'],
  ])('shows an actionable error and disables dispatch for a %s artifact id', async (_label, artifactId) => {
    await renderPanel(artifactId);

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('add a valid artifact_id');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="promote-dispatch"]')?.disabled).toBe(true);
  });
});
