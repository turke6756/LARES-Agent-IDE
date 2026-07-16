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
  type AccessSiteStatus,
  type HandedTabInfo,
  type SharedAgentSessions,
  type SignedInOrigin,
} from '../../stores/browser-store';

// Phase 3 (§D lines 254-266) renderer acceptance for the SIMPLIFIED Website
// access pane. The old three-control layout (hand-off toggle + "Sign in for
// agent" + "Import my session" per row, collapsed-by-default list) collapsed
// into: an EXPANDED-by-default allowlist, one "Agents may use my login" toggle
// plus ONE contextual action (Set up / Re-authenticate / Turn off) derived from
// the workspace-exact status seam, the five-word status vocabulary (Visit
// allowed / Login off / Setup required / Ready / Needs sign-in), immediate setup
// after request approval, and an Advanced & Activity disclosure that hides the
// "Sessions shared with agents" / "Agent sign-in" / idle-discard sections until
// opened. The SessionsSharedSection internals (WI-B/WI-E) are UNCHANGED — they
// just relocated behind the Advanced disclosure, so those tests expand it first.

// ── recorded store→IPC calls (spied via the window.api.browser stub) ──────────
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
const clearCalls: string[] = [];
const returnCalls: string[] = [];
const decideCalls: Array<{ id: string; decision: string }> = [];
const signinCalls: string[] = [];
// WI-E: track "Import my session" calls + drive the copied count the mock returns.
// Phase 2 (§D line 245): the import result reports candidateCookiesCopied (a setup
// first step), NOT an imported=>signed-in count.
const importCalls: string[] = [];
let importResult: { candidateCookiesCopied: number; origin: string } = { candidateCookiesCopied: 1, origin: '' };
let sharedFixture: SharedAgentSessions = { handedTabs: [], signedInOrigins: [] };
let rulesFixture: AccessRule[] = [];
let requestsFixture: AccessRequest[] = [];
// Phase 3: the workspace-exact per-rule status seam the pane reads to label each
// row's login chip + contextual action. Empty by default; a row with no entry
// falls back to session:'none' (→ "Setup required" / "Set up").
let siteStatusFixture: AccessSiteStatus[] = [];

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

function siteStatus(over: Partial<AccessSiteStatus> & { ruleId: string }): AccessSiteStatus {
  return {
    origin: 'https://mail.example',
    visit: true,
    login: true,
    session: 'active',
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

// Flush the on-mount loads (loadAccessRules / loadSiteStatus / loadAccessRequests
// / loadSharedSessions / loadSigninConfig) which resolve via the async api stub.
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

// Phase 3 (§D line 262): the "Sessions shared with agents" / "Agent sign-in" /
// idle-discard sections now live behind the collapsed-by-default Advanced &
// Activity disclosure — expand it before asserting on those sections. Match the
// title via getAttribute (not a CSS attribute selector — jsdom's selector engine
// mishandles the literal "&" in the title string).
function expandAdvanced() {
  const btn = [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('title') === 'Expand Advanced & Activity',
  );
  if (!btn) throw new Error('Advanced & Activity disclosure toggle not found');
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
  importResult = { candidateCookiesCopied: 1, origin: 'https://imported.example' };
  sharedFixture = { handedTabs: [], signedInOrigins: [] };
  rulesFixture = [];
  requestsFixture = [];
  siteStatusFixture = [];
  (window as unknown as { api: unknown }).api = {
    browser: {
      setVisible: () => {},
      getSharedSessions: async () => sharedFixture,
      access: {
        list: async () => rulesFixture,
        // Phase 3: the workspace-exact status seam the pane reads on mount.
        siteStatus: async () => siteStatusFixture,
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
    siteStatus: [],
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

// ── Phase 3 (§D line 258): expanded-by-default list + Advanced disclosure ─────
describe('WebsiteAccessSettings — first-screen layout (Phase 3 §D 258/262)', () => {
  it('shows the allowlist rules WITHOUT expanding (list is open by default)', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example' })];
    render();
    await settle();

    // The row is visible on the first screen — no expander click needed.
    expect(container.textContent).toContain('mail.example');
    // The allowlist toggle already offers to COLLAPSE (i.e. it starts expanded).
    expect(byTitle('Collapse the allowlist')).not.toBeNull();
    expect(byTitle('Expand the allowlist')).toBeNull();
  });

  it('hides the Advanced & Activity sections until the disclosure is expanded', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r1', hostname: 'mail.example' })],
    };
    render();
    await settle();

    // Off the primary at-a-glance surface until expanded.
    expect(container.textContent).not.toContain('Sessions shared with agents');
    expect(container.textContent).not.toContain('Agent sign-in');
    expect(container.textContent).not.toContain('Suspend idle tabs');

    expandAdvanced();
    expect(container.textContent).toContain('Sessions shared with agents');
    expect(container.textContent).toContain('Agent sign-in');
    expect(container.textContent).toContain('Suspend idle tabs');
  });
});

// ── Phase 3 (§D lines 259-260): status vocabulary + one contextual action ─────
describe('WebsiteAccessSettings — row status chips + contextual action (Phase 3 §D 259/260)', () => {
  it('an enabled visit-only rule (login off) shows "Visit allowed" + "Login off" and no login action', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: false, enabled: true })];
    render();
    await settle();

    expect(container.textContent).toContain('Visit allowed');
    expect(container.textContent).toContain('Login off');
    // No contextual login action (Set up / Re-authenticate / Turn off) — login off.
    expect(buttonByText('Set up')).toBeNull();
    expect(buttonByText('Re-authenticate')).toBeNull();
    expect(buttonByText('Turn off')).toBeNull();
  });

  it('a disabled rule drops the "Visit allowed" chip (line-through descriptor carries it)', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: false, enabled: false })];
    render();
    await settle();

    expect(container.textContent).not.toContain('Visit allowed');
    expect(container.textContent).toContain('Login off');
  });

  it('login on + session active → "Ready" chip and a "Turn off" action', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: true })];
    siteStatusFixture = [siteStatus({ ruleId: 'r1', login: true, session: 'active' })];
    render();
    await settle();

    expect(container.textContent).toContain('Ready');
    expect(container.textContent).toContain('Visit allowed');
    expect(buttonByText('Turn off')).not.toBeNull();
    expect(buttonByText('Set up')).toBeNull();
    expect(buttonByText('Re-authenticate')).toBeNull();
  });

  it('"Turn off" opens the confirm-off dialog (no store call), then "keep session" revokes only', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: true })];
    siteStatusFixture = [siteStatus({ ruleId: 'r1', login: true, session: 'active' })];
    render();
    await settle();

    click(buttonByText('Turn off'));
    // The confirm-off prompt is shown; nothing persisted yet.
    expect(updateCalls).toEqual([]);
    expect(clearCalls).toEqual([]);
    expect(container.textContent).toContain('Turning this off revokes');

    click(buttonByText('Turn off, keep session'));
    await settle();
    expect(updateCalls).toEqual([{ id: 'r1', patch: { allowSignedIn: false } }]);
    expect(clearCalls).toEqual([]);
  });

  it('"Turn off & clear session" both revokes and clears the stored session', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: true })];
    siteStatusFixture = [siteStatus({ ruleId: 'r1', login: true, session: 'active' })];
    render();
    await settle();

    click(buttonByText('Turn off'));
    click(buttonByText('Turn off & clear session'));
    await settle();
    expect(updateCalls).toEqual([{ id: 'r1', patch: { allowSignedIn: false } }]);
    expect(clearCalls).toEqual(['r1']);
  });

  it('login on + session expired → "Needs sign-in" chip and a "Re-authenticate" action → beginSigninHandoff', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: true })];
    siteStatusFixture = [siteStatus({ ruleId: 'r1', login: true, session: 'expired' })];
    render();
    await settle();

    expect(container.textContent).toContain('Needs sign-in');
    const reauth = buttonByText('Re-authenticate');
    expect(reauth).not.toBeNull();
    click(reauth);
    await settle();
    expect(signinCalls).toEqual(['r1']);
  });

  it('login on + session setup_required → "Setup required" chip and a "Set up" action → beginSigninHandoff', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: true })];
    siteStatusFixture = [siteStatus({ ruleId: 'r1', login: true, session: 'setup_required' })];
    render();
    await settle();

    expect(container.textContent).toContain('Setup required');
    const setup = buttonByText('Set up');
    expect(setup).not.toBeNull();
    click(setup);
    await settle();
    expect(signinCalls).toEqual(['r1']);
  });

  it('login on but no status row yet (session none) falls back to "Setup required" / "Set up"', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: true })];
    siteStatusFixture = []; // no seam entry → session 'none'
    render();
    await settle();

    expect(container.textContent).toContain('Setup required');
    expect(buttonByText('Set up')).not.toBeNull();
  });
});

// ── Slice 12 (relocated behind Advanced): "Sessions shared with agents" ────────
describe('WebsiteAccessSettings — "Sessions shared with agents" (Slice 12 Half B)', () => {
  it('renders handed tabs + signed-in origin rows from store.sharedSessions', async () => {
    sharedFixture = {
      handedTabs: [handed({ tabId: 't1', title: 'Inbox' })],
      signedInOrigins: [origin({ ruleId: 'r1', hostname: 'mail.example' })],
    };
    render();
    await settle();
    expandAdvanced();

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
    expandAdvanced();

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
    expandAdvanced();

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
    expandAdvanced();

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
    expandAdvanced();

    expect(container.textContent).toContain('Session may have expired');
  });
});

// ── Proactive-signin (2026-06-29) WI-B: per-row "Sign in" action ──────────────
// (SessionsSharedSection internals unchanged; now behind the Advanced disclosure.)
describe('WebsiteAccessSettings — proactive "Sign in" per row (WI-B)', () => {
  it('a "never" origin renders a primary "Sign in" button + neutral status, no Clear', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-never', hostname: 'never.example', state: 'never' })],
    };
    render();
    await settle();
    expandAdvanced();

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
    expandAdvanced();

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
    expandAdvanced();

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
    expandAdvanced();

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
    expandAdvanced();

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
    expandAdvanced();

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
    expandAdvanced();

    expect(buttonByText('Import my session')).toBeNull();
  });

  it('clicking "Import my session" calls importUserSession with the ruleId', async () => {
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-never', hostname: 'never.example', state: 'never' })],
    };
    render();
    await settle();
    expandAdvanced();

    click(buttonByText('Import my session'));
    await settle();
    expect(importCalls).toEqual(['r-never']);
  });

  it('a candidateCookiesCopied:0 result surfaces the quiet Sign-in fallback notice', async () => {
    importResult = { candidateCookiesCopied: 0, origin: 'https://never.example' };
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-never', hostname: 'never.example', state: 'never' })],
    };
    render();
    await settle();
    expandAdvanced();

    expect(container.textContent).not.toContain('No saved login found');
    click(buttonByText('Import my session'));
    await settle();
    expect(container.textContent).toContain('No saved login found in your browser for this site');
  });

  it('a candidateCookiesCopied>0 result shows no fallback notice', async () => {
    importResult = { candidateCookiesCopied: 3, origin: 'https://never.example' };
    sharedFixture = {
      handedTabs: [],
      signedInOrigins: [origin({ ruleId: 'r-never', hostname: 'never.example', state: 'never' })],
    };
    render();
    await settle();
    expandAdvanced();

    click(buttonByText('Import my session'));
    await settle();
    expect(container.textContent).not.toContain('No saved login found');
  });
});

// ── Proactive-signin (2026-06-29) WI-C: allowlist search (list open by default) ─
describe('WebsiteAccessSettings — allowlist search (WI-C)', () => {
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

    // Both rules visible before filtering — no expander click (list open by default).
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
  it('toggling "Agents may use my login" ON shows the 4-point consent and only persists + stamps consent_acked_at after acknowledgment', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: false })];
    render();
    await settle();

    // Flip the per-row "Agents may use my login" switch ON.
    click(byAriaLabel('Agents may use my login'));

    // The 4-point consent is shown; NOTHING is persisted yet. (TRAP-3: the DIALOG
    // still reads "in this workspace" even though the row descriptor names the ws.)
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

  it('names the exact workspace on the consent surface (Phase 3 §D 263)', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: false })];
    render();
    await settle();

    click(byAriaLabel('Agents may use my login'));
    // Default dashboard store (no workspaces / null selection) → "the default workspace".
    expect(container.textContent).toContain('Workspace:');
    expect(container.textContent).toContain('the default workspace');
  });

  it('WI-E: the consent copy discloses the cookie copy honestly', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: false })];
    render();
    await settle();

    click(byAriaLabel('Agents may use my login'));
    expect(container.textContent).toContain('copy your current login for this site');
    expect(container.textContent).toContain('Google SSO');
  });

  it('WI-E: acknowledging consent on toggle-ON auto-attempts importUserSession (best-effort, after the grant)', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: false })];
    render();
    await settle();

    click(byAriaLabel('Agents may use my login'));
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

    click(byAriaLabel('Agents may use my login'));
    expect(container.textContent).toContain('shared by every agent in this workspace');
    // The dialog's Cancel.
    click(buttonByText('Cancel'));
    expect(updateCalls).toEqual([]);
  });

  it('"Allow visit and set up login" routes through the SAME consent, stamps the created rule, AND chains setup', async () => {
    requestsFixture = [request({ id: 'req1', hostname: 'boards.example', wantSignedIn: true })];
    render();
    await settle();

    // The pending request is surfaced (always on top — not behind Advanced).
    expect(container.textContent).toContain('boards.example');

    // The relabeled approve button shows consent FIRST — no decision dispatched yet.
    click(buttonByText('Allow visit and set up login'));
    expect(decideCalls).toEqual([]);
    expect(container.textContent).toContain('shared by every agent in this workspace');

    // Acknowledge → decide approve_signed_in, stamp consent on the new rule, THEN
    // chain beginSigninHandoff on the created rule (Phase 3 §D 261).
    click(buttonByIncludes('I understand'));
    await settle();
    expect(decideCalls).toEqual([{ id: 'req1', decision: 'approve_signed_in' }]);
    const stamp = updateCalls.find((c) => c.id === 'r-created');
    expect(stamp).toBeTruthy();
    expect(typeof stamp!.patch.consentAckedAt).toBe('number');
    // Immediate setup after approval: the created rule id flows into handoffSignin.
    expect(signinCalls).toContain('r-created');
  });

  it('rejects a regex-like login-URL pattern and accepts a glob (validation in the UI)', async () => {
    rulesFixture = [makeRule({ id: 'r1', hostname: 'mail.example', allowSignedIn: true })];
    render();
    await settle();

    // Open the per-rule patterns editor (list is expanded by default).
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

  it('WI-8: the Agent sign-in section (behind Advanced) toggles the unattended flag through the store', async () => {
    render();
    await settle();
    expandAdvanced();

    expect(container.textContent).toContain('Agent sign-in');
    // The expanded AddRuleForm also has an "Include subdomains" checkbox, so target
    // the unattended box specifically via its label text (not a pane-wide query).
    const unattendedLabel = [...container.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('Unattended runs'),
    );
    expect(unattendedLabel).not.toBeUndefined();
    const checkbox = unattendedLabel!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);
    // A real click flips it on (jsdom toggles + fires change → onChange).
    click(checkbox);
    await settle();
    expect(useBrowserStore.getState().signinUnattended).toBe(true);
  });
});
