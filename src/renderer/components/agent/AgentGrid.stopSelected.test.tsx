// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentGrid from './AgentGrid';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { Agent, BulkStopResult } from '../../../shared/types';

// §B8 acceptance for "Stop selected":
//   1. it is TWO-STEP — the first click arms a confirm, it never stops;
//   2. the confirm names `launching` agents as a distinct risk;
//   3. the request carries mode:'explicit' + confirmActive:true and NO reason;
//   4. changing the selection disarms a primed confirm;
//   5. a `failed` item is reported as a failure, not as stopped.

let container: HTMLDivElement;
let root: Root;

const stopBulkSpy = vi.fn();
let stopResult: BulkStopResult;

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    workspaceId: 'ws',
    title: over.id,
    slug: over.id,
    roleDescription: '',
    workingDirectory: 'C:/ws',
    command: 'claude',
    provider: 'claude',
    isSupervisor: false,
    isSupervised: false,
    isWorker: false,
    isResearcher: false,
    tmuxSessionName: null,
    autoRestartEnabled: false,
    resumeSessionId: null,
    status: 'idle',
    ownerAgentId: null,
    ...over,
  } as Agent;
}

async function render() {
  await act(async () => {
    root = createRoot(container);
    root.render(<AgentGrid />);
  });
}

async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').trim().startsWith(text),
  ) as HTMLButtonElement | undefined;
}

/**
 * Drive the grid's real selection gesture. AgentCard toggles multi-selection on
 * shift+MOUSEDOWN (not click) because Chromium eats the click on draggable
 * content — so the test uses the same event the human does.
 */
async function select(titles: string[]) {
  for (const title of titles) {
    const card = Array.from(container.querySelectorAll('.agent-card')).find((el) =>
      (el.textContent ?? '').includes(title),
    );
    expect(card, `card for ${title}`).toBeTruthy();
    await act(async () => {
      (card as HTMLElement).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, shiftKey: true, button: 0 }),
      );
    });
  }
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  stopBulkSpy.mockClear();
  stopResult = {
    items: [
      { agentId: 'a1', result: 'stopped', codes: [] },
      { agentId: 'a2', result: 'stopped', codes: [] },
    ],
  };
  (window as any).api = {
    agents: {
      stopBulk: vi.fn(async (req: unknown) => { stopBulkSpy(req); return stopResult; }),
      // AgentCard's own mount effects — stubbed so the grid can render real cards.
      getContextStats: vi.fn(async () => null),
      updateSupervised: vi.fn(async () => {}),
    },
  };
  useDashboardStore.setState({
    selectedWorkspaceId: 'ws',
    agents: [
      agent({ id: 'a1', title: 'Alpha', status: 'idle' }),
      agent({ id: 'a2', title: 'Beta', status: 'launching' }),
      agent({ id: 'a3', title: 'Gamma', status: 'idle' }),
    ],
  } as any);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AgentGrid — Stop selected', () => {
  it('arms a confirm on the first click and does not stop', async () => {
    await render();
    await select(['Alpha']);
    await click(buttonByText('Stop selected'));
    expect(stopBulkSpy).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(buttonByText('Yes, stop 1')).toBeTruthy();
  });

  it('calls out launching agents as a distinct risk in the confirm', async () => {
    await render();
    await select(['Alpha', 'Beta']);
    await click(buttonByText('Stop selected'));
    const confirm = container.querySelector('[role="alertdialog"]')!.textContent ?? '';
    expect(confirm).toContain('LAUNCHING');
    expect(confirm).toContain('Beta');
    expect(confirm).not.toContain('Alpha'); // only the launching one is named as such
  });

  it('sends explicit mode with confirmActive and no reason on the second click', async () => {
    await render();
    await select(['Alpha', 'Beta']);
    await click(buttonByText('Stop selected'));
    await click(buttonByText('Yes, stop 2'));
    expect(stopBulkSpy).toHaveBeenCalledTimes(1);
    const req = stopBulkSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(req.mode).toBe('explicit');
    expect(req.confirmActive).toBe(true);
    expect(new Set(req.agentIds as string[])).toEqual(new Set(['a1', 'a2']));
    // The renderer must never claim a stop reason — main assigns it per endpoint.
    expect(req).not.toHaveProperty('reason');
  });

  it('disarms the confirm when the selection changes', async () => {
    await render();
    await select(['Alpha']);
    await click(buttonByText('Stop selected'));
    expect(buttonByText('Yes, stop 1')).toBeTruthy();
    await select(['Gamma']);
    expect(buttonByText('Yes, stop 2')).toBeFalsy();
    expect(buttonByText('Stop selected')).toBeTruthy();
    expect(stopBulkSpy).not.toHaveBeenCalled();
  });

  it('reports a failed item as a failure, never as stopped', async () => {
    stopResult = {
      items: [
        { agentId: 'a1', result: 'failed', codes: [], outcome: 'failed' },
        { agentId: 'a2', result: 'skipped', codes: ['browser_lease'] },
      ],
    };
    await render();
    await select(['Alpha', 'Beta']);
    await click(buttonByText('Stop selected'));
    await click(buttonByText('Yes, stop 2'));
    const status = container.querySelector('[role="status"]')!.textContent ?? '';
    expect(status).toContain('Stopped 0 of 2');
    expect(status).toContain('may still be running');
    expect(status).toContain('Browser in use');
  });

  it('surfaces a stopBulk rejection instead of implying success', async () => {
    (window as any).api.agents.stopBulk = vi.fn(async () => { throw new Error('ipc down'); });
    await render();
    await select(['Alpha']);
    await click(buttonByText('Stop selected'));
    await click(buttonByText('Yes, stop 1'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('ipc down');
    expect(container.querySelector('[role="status"]')).toBeFalsy();
  });
});
