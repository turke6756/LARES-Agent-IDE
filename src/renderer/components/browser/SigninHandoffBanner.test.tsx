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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  // A clean idle baseline; each test sets the slice it exercises.
  useBrowserStore.setState({
    signinHandoff: null,
    signinHandoffError: null,
    signinHandoffDone: null,
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

  it('after completion: renders the transient success state naming the hostname', () => {
    useBrowserStore.setState({
      signinHandoff: null,
      signinHandoffDone: { hostname: 'mail.example' },
    });
    render();

    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).toContain('The agent can now use your signed-in session');
    expect(container.textContent).toContain('mail.example');
  });

  it('renders nothing when fully idle', () => {
    render();
    expect(container.textContent).toBe('');
  });
});
