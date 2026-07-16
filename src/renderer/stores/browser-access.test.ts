// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useBrowserStore,
  ensureBrowserBridge,
  __resetBrowserBridgeForTests,
  matchesAccessRule,
  agentSignedInRuleForUrl,
  type AccessRequest,
  type AccessRule,
  type AccessSiteStatus,
} from './browser-store';

// Renderer-lane acceptance for the SIMPLIFIED website-access policy
// (plans/website-allowlist-simplification.md §6). ONE agent allowlist + the
// pending-approval inbox — no second list, no per-list mode. Pure rule matching
// + store state/actions against a STUBBED window.api.browser.access — never the
// real (frozen) preload.

function rule(overrides: Partial<AccessRule> & { id: string }): AccessRule {
  return {
    hostname: 'github.com',
    includeSubdomains: true,
    scheme: 'https',
    allowSignedIn: false,
    enabled: true,
    createdAt: 0,
    ...overrides,
  };
}

function makeAccessMock() {
  return {
    list: vi.fn(async () => [] as AccessRule[]),
    add: vi.fn(async (input: any) => rule({ id: 'r-new', ...input })),
    update: vi.fn(async (id: string, patch: any) => rule({ id, ...patch })),
    remove: vi.fn(async (_id: string) => {}),
    onChanged: vi.fn((_cb: () => void) => () => {}),
    requestList: vi.fn(async () => [] as AccessRequest[]),
    requestDecide: vi.fn(async (_id: string, _d: string) => {}),
    onRequestsChanged: vi.fn((_cb: () => void) => () => {}),
    handoffSignin: vi.fn(async (_ruleId: string) => ({ tabId: 'tab-signin' })),
    handoffReady: vi.fn(async (_tabId: string) => {}),
    tabHandToAgent: vi.fn(async (_tabId: string) => {}),
    tabReturnToHuman: vi.fn(async (_tabId: string) => {}),
    clearSiteSession: vi.fn(async (_ruleId: string) => {}),
  };
}

function makeMockApi() {
  return {
    createTab: vi.fn(async () => ({ tabId: 'tab-1' })),
    closeTab: vi.fn(),
    navigate: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    setActiveTab: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    onTabState: vi.fn(() => () => {}),
    onOpenRequest: vi.fn(() => () => {}),
    reorderTab: vi.fn(),
    setTabPinned: vi.fn(),
    reopenClosedTab: vi.fn(async () => null),
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    setZoom: vi.fn(),
    contextMenuRequest: vi.fn(),
    bookmarkList: vi.fn(async () => []),
    bookmarkAdd: vi.fn(),
    bookmarkRemove: vi.fn(),
    bookmarkReorder: vi.fn(),
    historyList: vi.fn(async () => []),
    historyDelete: vi.fn(),
    historyClear: vi.fn(),
    onTabsSnapshot: vi.fn(() => () => {}),
    onShortcutCommand: vi.fn(() => () => {}),
    onFoundInPage: vi.fn(() => () => {}),
    onContextMenuCommand: vi.fn(() => () => {}),
    onBookmarksChanged: vi.fn(() => () => {}),
    setActiveWorkspace: vi.fn(),
    access: makeAccessMock(),
  };
}

type MockApi = ReturnType<typeof makeMockApi>;

function installApi(api: MockApi | null) {
  (window as unknown as { api?: unknown }).api = api ? { browser: api } : {};
}

let api: MockApi;

beforeEach(() => {
  api = makeMockApi();
  installApi(api);
  __resetBrowserBridgeForTests();
  useBrowserStore.setState({
    tabs: [],
    activeTabId: null,
    attentionTabIds: {},
    handedTabIds: {},
    accessViewOpen: false,
    accessRules: [],
    accessRequests: [],
    signinHandoff: null,
    signinHandoffError: null,
  });
});

describe('matchesAccessRule', () => {
  it('matches an exact host but not look-alikes', () => {
    const r = { hostname: 'github.com', includeSubdomains: false, scheme: 'https' as const };
    expect(matchesAccessRule('https://github.com/x', r)).toBe(true);
    expect(matchesAccessRule('https://evilgithub.com/x', r)).toBe(false);
    expect(matchesAccessRule('https://notgithub.com/x', r)).toBe(false);
    // No subdomains → a subdomain does not match.
    expect(matchesAccessRule('https://api.github.com/x', r)).toBe(false);
  });

  it('matches subdomains when includeSubdomains is set', () => {
    const r = { hostname: 'github.com', includeSubdomains: true, scheme: 'https' as const };
    expect(matchesAccessRule('https://github.com/', r)).toBe(true);
    expect(matchesAccessRule('https://api.github.com/', r)).toBe(true);
    expect(matchesAccessRule('https://evilgithub.com/', r)).toBe(false);
  });

  it('honors the scheme (any still requires the http(s) floor)', () => {
    const https = { hostname: 'a.dev', includeSubdomains: false, scheme: 'https' as const };
    expect(matchesAccessRule('http://a.dev/', https)).toBe(false);
    const any = { hostname: 'a.dev', includeSubdomains: false, scheme: 'any' as const };
    expect(matchesAccessRule('http://a.dev/', any)).toBe(true);
    expect(matchesAccessRule('https://a.dev/', any)).toBe(true);
    expect(matchesAccessRule('file:///a.dev', any)).toBe(false);
  });

  it('enforces a path-segment boundary (/app does not match /apple)', () => {
    const r = { hostname: 'a.dev', includeSubdomains: false, scheme: 'https' as const, pathPrefix: '/app' };
    expect(matchesAccessRule('https://a.dev/app', r)).toBe(true);
    expect(matchesAccessRule('https://a.dev/app/x', r)).toBe(true);
    expect(matchesAccessRule('https://a.dev/apple', r)).toBe(false);
  });

  it('strips a trailing dot and rejects unparseable input', () => {
    const r = { hostname: 'a.dev', includeSubdomains: false, scheme: 'https' as const };
    expect(matchesAccessRule('https://a.dev./', r)).toBe(true);
    expect(matchesAccessRule('not a url', r)).toBe(false);
  });
});

describe('agentSignedInRuleForUrl', () => {
  it('only returns enabled, allow-signed-in agent rules', () => {
    const rules = [
      rule({ id: 'a', hostname: 'github.com', allowSignedIn: true, enabled: true }),
      rule({ id: 'b', hostname: 'gitlab.com', allowSignedIn: false, enabled: true }),
      rule({ id: 'c', hostname: 'disabled.com', allowSignedIn: true, enabled: false }),
    ];
    expect(agentSignedInRuleForUrl('https://github.com/x', rules)?.id).toBe('a');
    // allow-signed-in OFF → no match (visit-only rule).
    expect(agentSignedInRuleForUrl('https://gitlab.com/x', rules)).toBeNull();
    // disabled rule → no match.
    expect(agentSignedInRuleForUrl('https://disabled.com/x', rules)).toBeNull();
    expect(agentSignedInRuleForUrl('https://other.com/x', rules)).toBeNull();
  });
});

describe('rule actions', () => {
  it('addAccessRule propagates a server-side rejection (form surfaces it)', async () => {
    api.access.add.mockRejectedValueOnce(new Error('hostname may not contain "*"'));
    await expect(
      useBrowserStore.getState().addAccessRule({
        hostname: '*.evil',
        includeSubdomains: true,
        scheme: 'https',
      }),
    ).rejects.toThrow(/\*/);
  });

  it('loadAccessRules populates the single allowlist', async () => {
    api.access.list.mockResolvedValueOnce([rule({ id: 'a' }), rule({ id: 'b', hostname: 'gitlab.com' })]);
    await useBrowserStore.getState().loadAccessRules();
    const s = useBrowserStore.getState();
    // accessRules is a flat list — no agent/human split.
    expect(Array.isArray(s.accessRules)).toBe(true);
    expect(s.accessRules.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('updateAccessRule forwards the per-row allowSignedIn toggle', async () => {
    await useBrowserStore.getState().updateAccessRule('r-1', { allowSignedIn: true });
    expect(api.access.update).toHaveBeenCalledWith('r-1', { allowSignedIn: true });
  });
});

describe('pending-approval inbox', () => {
  it('loadAccessRequests populates the request list', async () => {
    const pendingRow: AccessRequest = {
      id: 'req-1',
      hostname: 'github.com',
      includeSubdomains: false,
      scheme: 'https',
      wantSignedIn: false,
      requestedBy: 'agent-1',
      status: 'pending',
      createdAt: 0,
    };
    api.access.requestList.mockResolvedValueOnce([pendingRow]);
    await useBrowserStore.getState().loadAccessRequests();
    const s = useBrowserStore.getState();
    expect(s.accessRequests.map((r) => r.id)).toEqual(['req-1']);
    // The address-bar badge / top box derive their count from the pending subset.
    expect(s.accessRequests.filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('decideAccessRequest forwards the decision and refreshes', async () => {
    await useBrowserStore.getState().decideAccessRequest('req-1', 'approve_signed_in');
    expect(api.access.requestDecide).toHaveBeenCalledWith('req-1', 'approve_signed_in');
    // Approve creates a live rule → rules are reloaded for immediacy (single list).
    expect(api.access.list).toHaveBeenCalled();
  });
});

describe('Mechanism-B hand-off badge state', () => {
  it('tabHandToAgent marks the tab handed on success', async () => {
    const ok = await useBrowserStore.getState().tabHandToAgent('tab-7');
    expect(ok).toBe(true);
    expect(useBrowserStore.getState().handedTabIds['tab-7']).toBe(true);
  });

  it('tabHandToAgent leaves the tab unhanded when main refuses', async () => {
    api.access.tabHandToAgent.mockRejectedValueOnce(new Error('not an allow_signed_in origin'));
    const ok = await useBrowserStore.getState().tabHandToAgent('tab-7');
    expect(ok).toBe(false);
    expect(useBrowserStore.getState().handedTabIds['tab-7']).toBeUndefined();
  });

  it('tabReturnToHuman clears the handed flag', async () => {
    useBrowserStore.setState({ handedTabIds: { 'tab-7': true } });
    await useBrowserStore.getState().tabReturnToHuman('tab-7');
    expect(useBrowserStore.getState().handedTabIds['tab-7']).toBeUndefined();
    expect(api.access.tabReturnToHuman).toHaveBeenCalledWith('tab-7');
  });

  it('handleTabState mirrors main authoritative handedToAgent (badge follows main, not a URL heuristic)', () => {
    useBrowserStore.setState({
      accessRules: [rule({ id: 'a', hostname: 'github.com', allowSignedIn: true })],
      handedTabIds: { 'tab-7': true },
      tabs: [
        {
          tabId: 'tab-7',
          url: 'https://github.com/',
          title: '',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          partition: 'user',
        },
      ],
    });
    // Main still reports the tab handed → badge stays. (URL is irrelevant; main
    // is authoritative — even an off-origin URL stays handed while main says so.)
    useBrowserStore.getState().handleTabState({
      tabId: 'tab-7',
      url: 'https://github.com/inbox',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      partition: 'user',
      handedToAgent: true,
    });
    expect(useBrowserStore.getState().handedTabIds['tab-7']).toBe(true);
    // Main auto-revoked (F2/F3) and pushes state WITHOUT handedToAgent → cleared.
    useBrowserStore.getState().handleTabState({
      tabId: 'tab-7',
      url: 'https://example.com/',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      partition: 'user',
    });
    expect(useBrowserStore.getState().handedTabIds['tab-7']).toBeUndefined();
  });

  it('handleTabState marks a tab handed when main first reports handedToAgent', () => {
    useBrowserStore.setState({ handedTabIds: {}, tabs: [] });
    useBrowserStore.getState().handleTabState({
      tabId: 'tab-9',
      url: 'https://github.com/',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      partition: 'user',
      handedToAgent: true,
    });
    expect(useBrowserStore.getState().handedTabIds['tab-9']).toBe(true);
  });

  it('closeTab drops the handed flag', async () => {
    const id = (await useBrowserStore.getState().createTab('user'))!;
    useBrowserStore.setState({ handedTabIds: { [id]: true } });
    useBrowserStore.getState().closeTab(id);
    expect(useBrowserStore.getState().handedTabIds[id]).toBeUndefined();
  });
});

describe('Mechanism-A sign-in hand-off', () => {
  it('beginSigninHandoff opens the quarantined tab, raises the banner, closes the overlay', async () => {
    useBrowserStore.setState({ accessViewOpen: true });
    await useBrowserStore
      .getState()
      .beginSigninHandoff(rule({ id: 'a', hostname: 'github.com', allowSignedIn: true }));
    const s = useBrowserStore.getState();
    expect(api.access.handoffSignin).toHaveBeenCalledWith('a');
    expect(s.signinHandoff).toEqual({ tabId: 'tab-signin', ruleId: 'a', hostname: 'github.com' });
    expect(s.accessViewOpen).toBe(false);
  });

  it('completeSigninHandoff clears state on success', async () => {
    useBrowserStore.setState({ signinHandoff: { tabId: 'tab-signin', ruleId: 'a', hostname: 'github.com' } });
    await useBrowserStore.getState().completeSigninHandoff();
    expect(api.access.handoffReady).toHaveBeenCalledWith('tab-signin');
    expect(useBrowserStore.getState().signinHandoff).toBeNull();
  });

  it('completeSigninHandoff surfaces an error when main refuses (tab wandered off-origin)', async () => {
    api.access.handoffReady.mockRejectedValueOnce(new Error('off origin'));
    useBrowserStore.setState({ signinHandoff: { tabId: 'tab-signin', ruleId: 'a', hostname: 'github.com' } });
    await useBrowserStore.getState().completeSigninHandoff();
    const s = useBrowserStore.getState();
    // Stays in the flow so the human can retry; error is surfaced.
    expect(s.signinHandoff).not.toBeNull();
    expect(s.signinHandoffError).toBeTruthy();
  });

  it('cancelSigninHandoff closes the quarantined tab and clears state', () => {
    useBrowserStore.setState({ signinHandoff: { tabId: 'tab-signin', ruleId: 'a', hostname: 'github.com' } });
    useBrowserStore.getState().cancelSigninHandoff();
    expect(api.closeTab).toHaveBeenCalledWith('tab-signin');
    expect(useBrowserStore.getState().signinHandoff).toBeNull();
  });
});

describe('Slice-4: per-workspace access scoping', () => {
  it('handleWorkspaceChange re-scopes main and reloads the workspace-scoped allowlist + request inbox', async () => {
    // Main filters accessRuleList / accessRequestList by the selected workspace,
    // but a bare workspace switch emits no accessChanged event — so the store
    // must (a) tell main the new workspace and (b) reload both slices itself,
    // else the overlay's list/add/decide would act on the previous workspace.
    api.access.list.mockClear();
    api.access.requestList.mockClear();
    useBrowserStore.getState().handleWorkspaceChange('ws-2');
    expect(useBrowserStore.getState().selectedWorkspaceId).toBe('ws-2');
    expect(api.setActiveWorkspace).toHaveBeenCalledWith('ws-2');
    expect(api.access.list).toHaveBeenCalled();
    expect(api.access.requestList).toHaveBeenCalled();
  });
});

describe('loadSiteStatus (Phase 3 workspace-exact status seam)', () => {
  it('is a safe no-op when the siteStatus channel is absent (guarded prime)', async () => {
    // makeAccessMock has NO siteStatus — the action must guard on
    // api?.access?.siteStatus and leave store.siteStatus untouched (an unguarded
    // call would crash the bridge prime against an older/stubbed preload).
    expect((api.access as Record<string, unknown>).siteStatus).toBeUndefined();
    useBrowserStore.setState({ siteStatus: [] });
    await useBrowserStore.getState().loadSiteStatus();
    expect(useBrowserStore.getState().siteStatus).toEqual([]);
  });

  it('populates store.siteStatus from the channel when the preload exposes it', async () => {
    const rows: AccessSiteStatus[] = [
      { ruleId: 'r1', origin: 'https://github.com', visit: true, login: true, session: 'active' },
    ];
    (api.access as Record<string, unknown>).siteStatus = vi.fn(async () => rows);
    useBrowserStore.setState({ siteStatus: [] });
    await useBrowserStore.getState().loadSiteStatus();
    expect(useBrowserStore.getState().siteStatus).toEqual(rows);
  });
});

describe('ensureBrowserBridge', () => {
  it('subscribes to access change events and primes the slices', () => {
    ensureBrowserBridge();
    expect(api.access.onChanged).toHaveBeenCalled();
    expect(api.access.onRequestsChanged).toHaveBeenCalled();
    expect(api.access.list).toHaveBeenCalled();
    expect(api.access.requestList).toHaveBeenCalled();
    // No modes path remains — getModes was removed from the contract.
    expect((api.access as Record<string, unknown>).getModes).toBeUndefined();
  });
});
