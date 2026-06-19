// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentActionsToggle from './AgentActionsToggle';
import { __resetSuspendCount } from './useBrowserSuspension';
import {
  useBrowserStore,
  type AgentActionsCommand,
  type AgentActionsState,
  type BrowserTabState,
} from '../../stores/browser-store';

// Slice 12 (HALF A) acceptance for the armed-actions popover:
//   1. "Enable for 15 min" issues an armed command with a finite duration;
//   2. when sign-in handoffs are pending, enabling shows a confirm step first
//      (the command is held back until the human confirms).

const setCmds: AgentActionsCommand[] = [];
let stubState: AgentActionsState = { mode: 'disabled', armedUntil: null, lastChangedAt: 0 };

function tab(over: Partial<BrowserTabState> & { tabId: string }): BrowserTabState {
  return {
    url: 'https://a.example/',
    title: 'A',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    partition: 'agent',
    workspaceId: 'ws-A',
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(AgentActionsToggle));
  });
}

function clickToggle() {
  const btn = container.querySelector('button');
  if (!btn) throw new Error('toggle button not found');
  act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null
  ) as HTMLButtonElement | null;
}

function popoverOpen(): boolean {
  return container.querySelector('[role="dialog"]') !== null;
}

beforeEach(() => {
  __resetSuspendCount();
  setCmds.length = 0;
  stubState = { mode: 'disabled', armedUntil: null, lastChangedAt: 0 };
  (window as unknown as { api: unknown }).api = {
    browser: {
      setVisible: () => {},
      getActionsState: async () => stubState,
      setActionsState: async (cmd: AgentActionsCommand) => {
        setCmds.push(cmd);
        return stubState;
      },
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  useBrowserStore.setState({
    tabs: [],
    accessRules: [],
    accessRequests: [],
    actionsState: { mode: 'disabled', armedUntil: null, lastChangedAt: 0 },
    actionsEnabled: false,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  delete (window as unknown as { api?: unknown }).api;
});

describe('AgentActionsToggle (Slice 12 armed popover)', () => {
  it('"Enable for 15 min" issues an armed command with a finite duration', () => {
    render();
    expect(popoverOpen()).toBe(false);
    clickToggle();
    expect(popoverOpen()).toBe(true);

    const enable15 = buttonByText('Enable for 15 min');
    expect(enable15).not.toBeNull();
    act(() => enable15!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(setCmds).toHaveLength(1);
    expect(setCmds[0]).toEqual({ mode: 'armed', durationMs: 15 * 60 * 1000 });
  });

  it('shows a confirm step before enabling when sign-in handoffs are pending', () => {
    useBrowserStore.setState({
      tabs: [tab({ tabId: 't1', signinPending: true })],
    });
    render();
    clickToggle();

    // Clicking enable does NOT immediately issue a command — it surfaces confirm.
    const enable15 = buttonByText('Enable for 15 min');
    act(() => enable15!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(setCmds).toHaveLength(0);

    const armAnyway = buttonByText('Arm anyway');
    expect(armAnyway).not.toBeNull();
    act(() => armAnyway!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(setCmds).toEqual([{ mode: 'armed', durationMs: 15 * 60 * 1000 }]);
  });
});
