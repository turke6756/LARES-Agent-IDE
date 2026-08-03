// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Workspace } from '../../../shared/types';
import AgentLaunchDialog from './AgentLaunchDialog';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const storeState = {
  agents: [],
  loadAgents: vi.fn().mockResolvedValue(undefined),
  checkHealth: vi.fn().mockResolvedValue(undefined),
  openPrerequisitesDialog: vi.fn(),
};

vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
}));

vi.mock('../browser/useBrowserSuspension', () => ({
  useBrowserSuspension: () => undefined,
}));

const workspace: Workspace = {
  id: 'ws-agy',
  title: 'Agy workspace',
  path: 'C:\\work\\agy',
  pathType: 'windows',
  description: '',
  defaultCommand: '',
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  lastOpenedAt: null,
};

describe('AgentLaunchDialog agy enablement', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        templates: { list: vi.fn().mockResolvedValue([]) },
        personas: { list: vi.fn().mockResolvedValue([]) },
        agents: {
          checkAgentMd: vi.fn().mockResolvedValue({ found: false, fileName: null }),
          launch: vi.fn().mockResolvedValue({ id: 'new-agent' }),
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<AgentLaunchDialog workspace={workspace} onClose={vi.fn()} />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('offers Antigravity and selecting it applies the agy command and teal first-run notice', async () => {
    const button = [...container.querySelectorAll('button')]
      .find(candidate => candidate.textContent?.trim() === 'Antigravity');
    expect(button).toBeTruthy();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(button!.className).toContain('text-teal-400');
    expect(container.textContent).toContain(
      'First launch signs in with Google in your browser; credentials persist per-machine.',
    );

    const commandLabel = [...container.querySelectorAll('label')]
      .find(label => label.textContent?.trim() === 'Command');
    const commandInput = commandLabel?.parentElement?.querySelector('input');
    expect(commandInput?.value).toBe('agy');
  });
});
