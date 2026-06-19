// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WebsiteAccessSettings from './WebsiteAccessSettings';
import { __resetSuspendCount } from './useBrowserSuspension';
import {
  useBrowserStore,
  type AccessRule,
  type HandedTabInfo,
  type SharedAgentSessions,
  type SignedInOrigin,
} from '../../stores/browser-store';

// Slice 12 (HALF B) acceptance for the "Sessions shared with agents" section
// (WebsiteAccessSettings.tsx ~line 444). The section renders the live handed
// tabs + persisted signed-in origins from store.sharedSessions and wires the
// three per-row actions to the store. The destructive "Clear site session" uses
// the SAME asymmetric confirm step as the allowSignedIn ON→OFF flow.

// ── recorded store→IPC calls (spied via the window.api.browser stub) ──────────
const updateCalls: Array<{ id: string; patch: unknown }> = [];
const clearCalls: string[] = [];
const returnCalls: string[] = [];
let sharedFixture: SharedAgentSessions = { handedTabs: [], signedInOrigins: [] };
let rulesFixture: AccessRule[] = [];

function origin(
  over: Partial<SignedInOrigin> & { ruleId: string; hostname: string },
): SignedInOrigin {
  return {
    origin: `https://${over.hostname}`,
    workspaceId: null,
    allowSignedIn: true,
    signedInAt: Date.now() - 3 * 3600_000,
    lastUsedAt: Date.now() - 10 * 60_000,
    verifiedAt: null,
    stale: false,
    ...over,
  };
}

function handed(over: Partial<HandedTabInfo> & { tabId: string }): HandedTabInfo {
  return { url: 'https://mail.example/inbox', title: 'Inbox', workspaceId: null, ...over };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(WebsiteAccessSettings));
  });
}

// Flush the on-mount loads (loadAccessRules / loadAccessRequests /
// loadSharedSessions) which resolve via the async api stub.
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null
  ) as HTMLButtonElement | null;
}

function click(btn: HTMLElement | null) {
  if (!btn) throw new Error('button not found');
  act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

beforeEach(() => {
  __resetSuspendCount();
  updateCalls.length = 0;
  clearCalls.length = 0;
  returnCalls.length = 0;
  sharedFixture = { handedTabs: [], signedInOrigins: [] };
  rulesFixture = [];
  (window as unknown as { api: unknown }).api = {
    browser: {
      setVisible: () => {},
      getSharedSessions: async () => sharedFixture,
      access: {
        list: async () => rulesFixture,
        requestList: async () => [],
        update: async (id: string, patch: unknown) => {
          updateCalls.push({ id, patch });
          return {} as AccessRule;
        },
        remove: async () => {},
        add: async () => ({}) as AccessRule,
        onChanged: () => () => {},
        onRequestsChanged: () => () => {},
        requestDecide: async () => {},
        handoffSignin: async () => ({ tabId: 'x' }),
        handoffReady: async () => {},
        tabHandToAgent: async () => {},
        tabReturnToHuman: async (tabId: string) => {
          returnCalls.push(tabId);
        },
        clearSiteSession: async (ruleId: string) => {
          clearCalls.push(ruleId);
        },
      },
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  useBrowserStore.setState({
    accessViewOpen: true,
    accessRules: [],
    accessRequests: [],
    sharedSessions: { handedTabs: [], signedInOrigins: [] },
    handedTabIds: {},
    tabs: [],
    activeTabId: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  delete (window as unknown as { api?: unknown }).api;
});

describe('WebsiteAccessSettings — "Sessions shared with agents" (Slice 12 Half B)', () => {
  it('renders handed tabs + signed-in origin rows from store.sharedSessions', async () => {
    sharedFixture = {
      handedTabs: [handed({ tabId: 't1', title: 'Inbox' })],
      signedInOrigins: [origin({ ruleId: 'r1', hostname: 'mail.example' })],
    };
    render();
    await settle();

    expect(container.textContent).toContain('Sessions shared with agents');
    // Handed-tab row (Mechanism B).
    expect(container.textContent).toContain('Inbox');
    expect(buttonByText('Return tab')).not.toBeNull();
    // Signed-in origin row (Mechanism A).
    expect(container.textContent).toContain('mail.example');
    expect(buttonByText('Disable signed-in access')).not.toBeNull();
    expect(buttonByText('Clear site session')).not.toBeNull();
  });

  it('"Return tab" calls tabReturnToHuman for the handed tab', async () => {
    sharedFixture = { handedTabs: [handed({ tabId: 't1' })], signedInOrigins: [] };
    render();
    await settle();

    click(buttonByText('Return tab'));
    expect(returnCalls).toEqual(['t1']);
  });

  it('"Disable signed-in access" calls updateAccessRule with allowSignedIn:false', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r1', hostname: 'mail.example' })],
    };
    render();
    await settle();

    click(buttonByText('Disable signed-in access'));
    expect(updateCalls).toEqual([{ id: 'r1', patch: { allowSignedIn: false } }]);
  });

  it('"Clear site session" asks first, then clears on confirm (asymmetric confirm step)', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r1', hostname: 'mail.example' })],
    };
    render();
    await settle();

    // First click surfaces the confirm prompt — no IPC clear yet.
    click(buttonByText('Clear site session'));
    expect(clearCalls).toEqual([]);
    expect(container.textContent).toContain("Clear the agent's stored session");

    // Second click (the explicit confirm) performs the wipe.
    click(buttonByText('Clear session'));
    await settle();
    expect(clearCalls).toEqual(['r1']);
  });

  it('a stale origin renders the amber "Session may have expired — re-sign-in" chip', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r1', hostname: 'mail.example', stale: true })],
    };
    render();
    await settle();

    expect(container.textContent).toContain('Session may have expired');
  });
});
