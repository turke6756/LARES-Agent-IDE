// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WebsiteAccessSettings from './WebsiteAccessSettings';
import { __resetSuspendCount } from './useBrowserSuspension';
import {
  useBrowserStore,
  type AccessRequest,
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
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
const clearCalls: string[] = [];
const returnCalls: string[] = [];
const decideCalls: Array<{ id: string; decision: string }> = [];
const signinCalls: string[] = [];
// WI-E: track "Import my session" calls + drive the imported count the mock returns.
const importCalls: string[] = [];
let importResult: { imported: number; origin: string } = { imported: 1, origin: '' };
let sharedFixture: SharedAgentSessions = { handedTabs: [], signedInOrigins: [] };
let rulesFixture: AccessRule[] = [];
let requestsFixture: AccessRequest[] = [];

function makeRule(over: Partial<AccessRule> & { id: string }): AccessRule {
  return {
    hostname: 'mail.example',
    includeSubdomains: false,
    scheme: 'https',
    allowSignedIn: false,
    enabled: true,
    createdAt: 0,
    ...over,
  };
}

function request(over: Partial<AccessRequest> & { id: string }): AccessRequest {
  return {
    hostname: 'boards.example',
    includeSubdomains: false,
    scheme: 'https',
    wantSignedIn: true,
    requestedBy: 'agent-1',
    requestedByTitle: 'Researcher',
    status: 'pending',
    createdAt: Date.now() - 60_000,
    ...over,
  };
}

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
    sessionState: 'active',
    // Proactive-signin: default `state` tracks the legacy `stale` flag so the
    // existing stale-row test still renders the re-sign-in chip; new tests pass
    // `state` explicitly (e.g. 'never').
    state: over.stale ? 'expired' : 'signed_in',
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

function buttonByIncludes(text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) ?? null
  ) as HTMLButtonElement | null;
}

function byTitle(title: string): HTMLElement | null {
  return container.querySelector(`[title="${title}"]`) as HTMLElement | null;
}

function byAriaLabel(label: string): HTMLElement | null {
  return container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
}

function click(btn: HTMLElement | null) {
  if (!btn) throw new Error('button not found');
  act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

// Drive a React-controlled textarea: set the native value via the prototype
// setter (so React's value tracker sees the change) then dispatch a bubbling
// input event so onChange fires.
function setTextarea(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  __resetSuspendCount();
  updateCalls.length = 0;
  clearCalls.length = 0;
  returnCalls.length = 0;
  decideCalls.length = 0;
  signinCalls.length = 0;
  importCalls.length = 0;
  importResult = { imported: 1, origin: 'https://imported.example' };
  sharedFixture = { handedTabs: [], signedInOrigins: [] };
  rulesFixture = [];
  requestsFixture = [];
  (window as unknown as { api: unknown }).api = {
    browser: {
      setVisible: () => {},
      getSharedSessions: async () => sharedFixture,
      access: {
        list: async () => rulesFixture,
        requestList: async () => requestsFixture,
        update: async (id: string, patch: Record<string, unknown>) => {
          updateCalls.push({ id, patch });
          return {} as AccessRule;
        },
        remove: async () => {},
        add: async () => ({}) as AccessRule,
        onChanged: () => () => {},
        onRequestsChanged: () => () => {},
        requestDecide: async (id: string, decision: string) => {
          decideCalls.push({ id, decision });
          // Mirror the server: approve_signed_in creates an allow_signed_in rule
          // from the request's canonical shape (consent_acked_at still null), so
          // approveSignedInWithConsent's follow-up list() can find + stamp it.
          if (decision === 'approve_signed_in') {
            const req = requestsFixture.find((r) => r.id === id);
            if (req) {
              rulesFixture = [
                ...rulesFixture,
                makeRule({
                  id: 'r-created',
                  hostname: req.hostname,
                  scheme: req.scheme,
                  includeSubdomains: req.includeSubdomains,
                  pathPrefix: req.pathPrefix,
                  allowSignedIn: true,
                  consentAckedAt: null,
                }),
              ];
            }
          }
        },
        handoffSignin: async (id: string) => {
          signinCalls.push(id);
          return { tabId: 'x' };
        },
        handoffReady: async () => {},
        tabHandToAgent: async () => {},
        tabReturnToHuman: async (tabId: string) => {
          returnCalls.push(tabId);
        },
        clearSiteSession: async (ruleId: string) => {
          clearCalls.push(ruleId);
        },
        importUserSession: async (ruleId: string) => {
          importCalls.push(ruleId);
          return importResult;
        },
        getSigninHoldTimeoutMs: async () => 300_000,
        isSigninUnattended: async () => false,
        setSigninHoldTimeoutMs: async () => {},
        setSigninUnattended: async () => {},
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

// ── Proactive-signin (2026-06-29) WI-B: per-row "Sign in" action ──────────────
describe('WebsiteAccessSettings — proactive "Sign in" per row (WI-B)', () => {
  it('a "never" origin renders a primary "Sign in" button + neutral status, no Clear', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-never', hostname: 'never.example', state: 'never' })],
    };
    render();
    await settle();

    expect(container.textContent).toContain('never.example');
    expect(container.textContent).toContain('Not signed in');
    expect(buttonByText('Sign in')).not.toBeNull();
    // No stored session yet → nothing to clear, but still revocable.
    expect(buttonByText('Clear site session')).toBeNull();
    expect(buttonByText('Disable signed-in access')).not.toBeNull();
  });

  it('clicking "Sign in" on a never origin calls beginSigninHandoff with the ruleId', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-never', hostname: 'never.example', state: 'never' })],
    };
    render();
    await settle();

    click(buttonByText('Sign in'));
    await settle();
    expect(signinCalls).toEqual(['r-never']);
  });

  it('an expired origin keeps the re-sign-in affordance wired to beginSigninHandoff', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-exp', hostname: 'exp.example', state: 'expired', stale: true })],
    };
    render();
    await settle();

    const reSignIn = buttonByIncludes('Session may have expired');
    expect(reSignIn).not.toBeNull();
    click(reSignIn);
    await settle();
    expect(signinCalls).toEqual(['r-exp']);
  });

  it('a signed_in origin shows no sign-in button (Clear + Disable only)', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-ok', hostname: 'ok.example', state: 'signed_in' })],
    };
    render();
    await settle();

    expect(buttonByText('Sign in')).toBeNull();
    expect(buttonByIncludes('re-sign-in')).toBeNull();
    expect(buttonByText('Clear site session')).not.toBeNull();
    expect(buttonByText('Disable signed-in access')).not.toBeNull();
  });
});

// ── Proactive-signin PHASE 2 WI-E: "Import my session" per row ────────────────
describe('WebsiteAccessSettings — "Import my session" (WI-E)', () => {
  it('a "never" origin renders "Import my session" NEXT TO "Sign in"', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-never', hostname: 'never.example', state: 'never' })],
    };
    render();
    await settle();

    expect(buttonByText('Import my session')).not.toBeNull();
    expect(buttonByText('Sign in')).not.toBeNull();
  });

  it('an "expired" origin renders "Import my session" alongside the re-sign-in affordance', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-exp', hostname: 'exp.example', state: 'expired', stale: true })],
    };
    render();
    await settle();

    expect(buttonByText('Import my session')).not.toBeNull();
    expect(buttonByIncludes('Session may have expired')).not.toBeNull();
  });

  it('a "signed_in" origin shows NO "Import my session" button', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-ok', hostname: 'ok.example', state: 'signed_in' })],
    };
    render();
    await settle();

    expect(buttonByText('Import my session')).toBeNull();
  });

  it('clicking "Import my session" calls importUserSession with the ruleId', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-never', hostname: 'never.example', state: 'never' })],
    };
    render();
    await settle();

    click(buttonByText('Import my session'));
    await settle();
    expect(importCalls).toEqual(['r-never']);
  });

  it('an imported:0 result surfaces the quiet Sign-in fallback notice', async () => {
    importResult = { imported: 0, origin: 'https://never.example' };
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-never', hostname: 'never.example', state: 'never' })],
    };
    render();
    await settle();

    expect(container.textContent).not.toContain('No saved login found');
    click(buttonByText('Import my session'));
    await settle();
    expect(container.textContent).toContain('No saved login found in your browser for this site');
  });

  it('an imported>0 result shows no fallback notice', async () => {
    importResult = { imported: 3, origin: 'https://never.example' };
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-never', hostname: 'never.example', state: 'never' })],
    };
    render();
    await settle();

    click(buttonByText('Import my session'));
    await settle();
    expect(container.textContent).not.toContain('No saved login found');
  });
});

// ── Proactive-signin (2026-06-29) WI-C: allowlist search ──────────────────────
describe('WebsiteAccessSettings — allowlist search (WI-C)', () => {
  function expandAllowlist() {
    click(byTitle('Expand the allowlist'));
  }
  function setInput(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('filters rows to the matching hostname (case-insensitive) and clears back to all', async () => {
    rulesFixture = [
      makeRule({ id: 'r1', hostname: 'mail.example' }),
      makeRule({ id: 'r2', hostname: 'docs.example' }),
    ];
    render();
    await settle();
    expandAllowlist();

    // Both rules visible before filtering.
    expect(container.textContent).toContain('mail.example');
    expect(container.textContent).toContain('docs.example');

    const search = byAriaLabel('Search allowlist') as HTMLInputElement;
    expect(search).not.toBeNull();
    setInput(search, 'DOCS');
    expect(container.textContent).toContain('docs.example');
    expect(container.textContent).not.toContain('mail.example');

    // A non-matching query shows the empty-state, not a row.
    setInput(search, 'zzz-no-match');
    expect(container.textContent).toContain('No rules match');

    // Clearing the query restores every row.
    setInput(search, '');
    expect(container.textContent).toContain('mail.example');
    expect(container.textContent).toContain('docs.example');
  });
});

// ── WI-5: consent gate at every grant path + login-URL pattern validation ─────
describe('WebsiteAccessSettings — signed-in consent gate (WI-5)', () => {
  function expandAllowlist() {
    click(byTitle('Expand the allowlist'));
  }

  it('toggling allow-signed-in ON shows the 4-point consent and only persists + stamps consent_acked_at after acknowledgment', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: false })];
    render();
    await settle();
    expandAllowlist();

    // Flip the per-row "Allow sign-in hand-off" switch ON.
    click(byAriaLabel('Allow sign-in hand-off'));

    // The 4-point consent is shown; NOTHING is persisted yet.
    expect(container.textContent).toContain('shared by every agent in this workspace');
    expect(container.textContent).toContain('not your private');
    expect(updateCalls).toEqual([]);

    // Acknowledge → persists allow_signed_in AND stamps consent_acked_at.
    click(buttonByIncludes('I understand'));
    await settle();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe('r1');
    expect(updateCalls[0].patch.allowSignedIn).toBe(true);
    expect(typeof updateCalls[0].patch.consentAckedAt).toBe('number');
  });

  it('WI-E: the consent copy discloses the cookie copy honestly', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: false })];
    render();
    await settle();
    expandAllowlist();

    click(byAriaLabel('Allow sign-in hand-off'));
    expect(container.textContent).toContain('copy your current login for this site');
    expect(container.textContent).toContain('Google SSO');
  });

  it('WI-E: acknowledging consent on toggle-ON auto-attempts importUserSession (best-effort, after the grant)', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: false })];
    render();
    await settle();
    expandAllowlist();

    click(byAriaLabel('Allow sign-in hand-off'));
    click(buttonByIncludes('I understand'));
    await settle();
    // The grant persisted AND the import auto-fired for the same rule.
    expect(updateCalls[0].patch.allowSignedIn).toBe(true);
    expect(importCalls).toEqual(['r1']);
  });

  it('cancelling the consent leaves the capability OFF (no persist)', async () => {
    rulesFixture = [makeRule({ id: 'r1', allowSignedIn: false })];
    render();
    await settle();
    expandAllowlist();

    click(byAriaLabel('Allow sign-in hand-off'));
    expect(container.textContent).toContain('shared by every agent in this workspace');
    // The dialog's Cancel.
    click(buttonByText('Cancel'));
    expect(updateCalls).toEqual([]);
  });

  it('approve_signed_in routes through the SAME consent and stamps consent_acked_at on the created rule', async () => {
    requestsFixture = [request({ id: 'req1', hostname: 'boards.example', wantSignedIn: true })];
    render();
    await settle();

    // The pending request is surfaced.
    expect(container.textContent).toContain('boards.example');

    // "Approve + allow signed in" shows consent FIRST — no decision dispatched yet.
    click(buttonByText('Approve + allow signed in'));
    expect(decideCalls).toEqual([]);
    expect(container.textContent).toContain('shared by every agent in this workspace');

    // Acknowledge → decide approve_signed_in, then stamp consent on the new rule.
    click(buttonByIncludes('I understand'));
    await settle();
    expect(decideCalls).toEqual([{ id: 'req1', decision: 'approve_signed_in' }]);
    const stamp = updateCalls.find((c) => c.id === 'r-created');
    expect(stamp).toBeTruthy();
    expect(typeof stamp!.patch.consentAckedAt).toBe('number');
  });

  it('rejects a regex-like login-URL pattern and accepts a glob (validation in the UI)', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: true })];
    render();
    await settle();
    expandAllowlist();

    // Open the per-rule patterns editor.
    click(buttonByText('Login-URL patterns'));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta).not.toBeNull();

    // A regex metacharacter is rejected; nothing persisted.
    setTextarea(ta, '(login|sso)');
    click(buttonByText('Save patterns'));
    expect(container.textContent).toContain('looks like a regular expression');
    expect(updateCalls.some((c) => 'loginUrlPatterns' in c.patch)).toBe(false);

    // A valid glob persists as a string array.
    setTextarea(ta, '*/candidate/*\n/sso');
    click(buttonByText('Save patterns'));
    await settle();
    const saved = updateCalls.find((c) => 'loginUrlPatterns' in c.patch);
    expect(saved?.patch.loginUrlPatterns).toEqual(['*/candidate/*', '/sso']);
  });

  it('WI-8: the Agent sign-in section toggles the unattended flag through the store', async () => {
    render();
    await settle();

    expect(container.textContent).toContain('Agent sign-in');
    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    // The unattended checkbox is present (it's the only checkbox in this pane while
    // the allowlist is collapsed) and starts unchecked.
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);
    // A real click flips it on (jsdom toggles + fires change → onChange).
    click(checkbox);
    await settle();
    expect(useBrowserStore.getState().signinUnattended).toBe(true);
  });
});
