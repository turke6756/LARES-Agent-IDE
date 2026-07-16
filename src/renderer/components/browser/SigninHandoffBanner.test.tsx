// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SigninHandoffBanner from './SigninHandoffBanner';
import { useBrowserStore } from '../../stores/browser-store';

// Slice 12 (Mechanism A) acceptance for the sign-in hand-off banner
// (SigninHandoffBanner.tsx). The banner is driven entirely by store state:
//   - signinHandoff set → the four-point consent banner with the quarantine
//     badge ("Human only — agent can't read this") and a "Cancel hand-off"
//     affordance while the human types credentials into the quarantined tab;
//   - signinHandoffDone set (and signinHandoff cleared) → the transient success
//     flash naming the hostname the agent can now use.

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(SigninHandoffBanner));
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
  container = document.createElement('div');
  document.body.appendChild(container);
  // A clean idle baseline; each test sets the slice it exercises.
  useBrowserStore.setState({
    signinHandoff: null,
    signinHandoffError: null,
    signinHandoffDone: null,
    signinPending: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe('SigninHandoffBanner (Slice 12 — Mechanism A consent banner)', () => {
  it('while a sign-in is pending: shows the quarantine badge + a "Cancel hand-off" affordance', () => {
    useBrowserStore.setState({
      signinHandoff: { tabId: 't1', ruleId: 'r1', hostname: 'mail.example' },
    });
    render();

    // Quarantine badge — the visible login tab is agent-isolated while typing.
    expect(container.textContent).toContain('Human only');
    expect(container.textContent).toContain("agent can't read this");
    // The clearly-labelled abandon affordance.
    expect(buttonByText('Cancel hand-off')).not.toBeNull();
    // And the primary hand-over action.
    expect(buttonByText('Hand to agent')).not.toBeNull();
  });

  it('after completion with no probe: renders an HONEST "You confirmed this session" success (Phase 2 §D line 247)', () => {
    // No verification (unknown site / older main) → the banner must NOT imply
    // automatic verification; it is a human attestation only.
    useBrowserStore.setState({
      signinHandoff: null,
      signinHandoffDone: { hostname: 'mail.example' },
    });
    render();

    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).toContain('You confirmed this session');
    expect(container.textContent).not.toContain('Verified');
    expect(container.textContent).toContain('mail.example');
  });

  it('after a PROBED completion: renders the "Verified" success naming the hostname', () => {
    // A safe adapter probe succeeded → the banner may honestly say "Verified".
    useBrowserStore.setState({
      signinHandoff: null,
      signinHandoffDone: { hostname: 'app.joinhandshake.com', verification: 'probed' },
    });
    render();

    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).toContain('Verified');
    expect(container.textContent).toContain('the agent can now use your signed-in session');
    expect(container.textContent).toContain('app.joinhandshake.com');
  });

  it('renders nothing when fully idle', () => {
    render();
    expect(container.textContent).toBe('');
  });
});

// ── WI-5: JIT sign-in reminder banner ─────────────────────────────────────────
// Distinct from the Mechanism-B consent banner above: this one is agent-initiated
// (main pushed browser:signin-pending-opened because an agent hit an
// allow_signed_in origin with no live session) and is a REMINDER, not a second
// consent gate. It names the origin, offers "Done signing in" (→ access-handoff-
// ready) and "Cancel" (→ signin-pending-cancel), and clears on signin-resolved.
describe('SigninHandoffBanner — WI-5 JIT sign-in reminder banner', () => {
  const readyCalls: string[] = [];
  const cancelCalls: string[] = [];

  const pending = {
    origin: 'https://boards.example',
    tabId: 't9',
    workspaceId: null,
    reason: 'warm_session_expired',
  };

  // Flush the async store actions the buttons fire (void complete()/cancel()).
  async function flush() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  beforeEach(() => {
    readyCalls.length = 0;
    cancelCalls.length = 0;
    (window as unknown as { api: unknown }).api = {
      browser: {
        getSharedSessions: async () => ({ handedTabs: [], signedInOrigins: [] }),
        access: {
          handoffReady: async (tabId: string) => {
            readyCalls.push(tabId);
          },
          signinPendingCancel: async (tabId: string) => {
            cancelCalls.push(tabId);
          },
        },
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api;
  });

  it('appears on signin-pending-opened, names the origin, and offers the two actions', () => {
    act(() =>
      useBrowserStore.getState().handleSigninPendingOpened(pending),
    );
    render();

    expect(container.textContent).toContain('An agent is waiting');
    // The origin renders as plain escaped text (never markup / a link).
    expect(container.textContent).toContain('boards.example');
    expect(buttonByText('Done signing in')).not.toBeNull();
    expect(buttonByText('Cancel')).not.toBeNull();
    // The Mechanism-B "Cancel hand-off" affordance is NOT this banner.
    expect(buttonByText('Cancel hand-off')).toBeNull();
  });

  it('"Done signing in" fires access-handoff-ready for the tab and clears the banner', async () => {
    useBrowserStore.setState({ signinPending: pending });
    render();

    click(buttonByText('Done signing in'));
    await flush();
    expect(readyCalls).toEqual(['t9']);
    expect(useBrowserStore.getState().signinPending).toBeNull();
  });

  it('"Cancel" fires signin-pending-cancel for the tab and clears the banner', async () => {
    useBrowserStore.setState({ signinPending: pending });
    render();

    click(buttonByText('Cancel'));
    await flush();
    expect(cancelCalls).toEqual(['t9']);
    expect(useBrowserStore.getState().signinPending).toBeNull();
  });

  it('clears when main pushes signin-resolved for the named origin', () => {
    useBrowserStore.setState({ signinPending: pending });
    render();
    expect(container.textContent).toContain('An agent is waiting');

    act(() =>
      useBrowserStore
        .getState()
        .handleSigninResolved({ origin: 'https://boards.example', state: 'ready' }),
    );
    expect(container.textContent).not.toContain('An agent is waiting');
  });

  it('a signin-resolved for a DIFFERENT origin leaves a live prompt up', () => {
    useBrowserStore.setState({ signinPending: pending });
    render();

    act(() =>
      useBrowserStore
        .getState()
        .handleSigninResolved({ origin: 'https://other.example', state: 'ready' }),
    );
    expect(container.textContent).toContain('An agent is waiting');
    expect(container.textContent).toContain('boards.example');
  });
});
