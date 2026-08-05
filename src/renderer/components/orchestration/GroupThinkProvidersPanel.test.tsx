// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAUNCHABLE_AGENT_PROVIDERS, type OrchestrationProviderSettings } from '../../../shared/types';
import { DEFAULT_ORCHESTRATION_PROVIDER_SETTINGS } from '../../../shared/constants';
import { useDashboardStore } from '../../stores/dashboard-store';
import GroupThinkProvidersPanel from './GroupThinkProvidersPanel';

const settings = (lead: 'claude' | 'codex' | 'grok' | 'agy', reviewer: 'claude' | 'codex' | 'grok' | 'agy'): OrchestrationProviderSettings => ({
  groupthink: { defaultLeadProvider: lead, defaultReviewerProvider: reviewer },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let changed: ((event: { workspaceId: string; settings: OrchestrationProviderSettings }) => void) | null;
let getSettings: ReturnType<typeof vi.fn>;
let updateSettings: ReturnType<typeof vi.fn>;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

async function renderPanel(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(<GroupThinkProvidersPanel />);
  });
  await flush();
}

function selects(): HTMLSelectElement[] {
  return [...container.querySelectorAll('select')];
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  changed = null;
  getSettings = vi.fn(async () => settings('claude', 'codex'));
  updateSettings = vi.fn(async (_workspaceId: string, next: OrchestrationProviderSettings) => next);
  (window as any).api = {
    orchestrationProviderSettings: {
      get: getSettings,
      update: updateSettings,
      onChanged: vi.fn((callback) => { changed = callback; return vi.fn(); }),
    },
  };
  useDashboardStore.setState({ selectedWorkspaceId: 'ws-1' } as any);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  useDashboardStore.setState({ selectedWorkspaceId: null } as any);
});

describe('GroupThinkProvidersPanel', () => {
  it('loads the selected workspace and renders the canonical provider options exactly', async () => {
    getSettings.mockResolvedValue(settings('grok', 'agy'));
    await renderPanel();

    expect(getSettings).toHaveBeenCalledWith('ws-1');
    expect(selects().map((select) => select.value)).toEqual(['grok', 'agy']);
    for (const select of selects()) {
      expect([...select.options].map((option) => option.value)).toEqual([...LAUNCHABLE_AGENT_PROVIDERS]);
    }
  });

  it('reloads on workspace switch and drops a stale load that resolves later', async () => {
    const ws1 = deferred<OrchestrationProviderSettings>();
    const ws2 = deferred<OrchestrationProviderSettings>();
    getSettings.mockImplementation((workspaceId: string) => workspaceId === 'ws-1' ? ws1.promise : ws2.promise);
    await renderPanel();

    await act(async () => { useDashboardStore.setState({ selectedWorkspaceId: 'ws-2' }); });
    ws2.resolve(settings('agy', 'grok'));
    await flush();
    expect(selects().map((select) => select.value)).toEqual(['agy', 'grok']);

    ws1.resolve(settings('codex', 'claude'));
    await flush();
    expect(selects().map((select) => select.value)).toEqual(['agy', 'grok']);
    expect(getSettings.mock.calls.map(([workspaceId]) => workspaceId)).toEqual(['ws-1', 'ws-2']);
  });

  it('ignores other-workspace broadcasts, including old-workspace events after a switch', async () => {
    getSettings.mockImplementation(async (workspaceId: string) => workspaceId === 'ws-1'
      ? settings('claude', 'codex')
      : settings('grok', 'agy'));
    await renderPanel();

    await act(async () => { useDashboardStore.setState({ selectedWorkspaceId: 'ws-2' }); });
    await flush();
    expect(selects().map((select) => select.value)).toEqual(['grok', 'agy']);

    act(() => changed?.({ workspaceId: 'ws-1', settings: settings('codex', 'claude') }));
    expect(selects().map((select) => select.value)).toEqual(['grok', 'agy']);

    act(() => changed?.({ workspaceId: 'ws-3', settings: settings('agy', 'claude') }));
    expect(selects().map((select) => select.value)).toEqual(['grok', 'agy']);
  });

  it('saves edited values and resets through the workspace-scoped update bridge', async () => {
    await renderPanel();
    const [lead] = selects();
    await act(async () => {
      lead.value = 'grok';
      lead.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    await act(async () => { save.click(); });
    await flush();
    expect(updateSettings).toHaveBeenNthCalledWith(1, 'ws-1', settings('grok', 'codex'));

    const reset = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reset to defaults')!;
    await act(async () => { reset.click(); });
    await flush();
    expect(updateSettings).toHaveBeenNthCalledWith(2, 'ws-1', DEFAULT_ORCHESTRATION_PROVIDER_SETTINGS);
    expect(selects().map((select) => select.value)).toEqual(['claude', 'codex']);
  });
});
