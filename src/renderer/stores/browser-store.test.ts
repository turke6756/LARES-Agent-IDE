// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useBrowserStore,
  normalizeAddressInput,
  ensureBrowserBridge,
  __resetBrowserBridgeForTests,
  type BrowserApi,
  type BrowserTabState,
} from './browser-store';
import { useDashboardStore } from './dashboard-store';

// WP1-B acceptance: store logic (tab lifecycle, attention, precedence hooks)
// against a STUBBED window.api.browser — never the real preload (WP1-A).

function makeMockApi() {
  let nextId = 1;
  return {
    createTab: vi.fn(async ({ partition: _p, url: _u }: { partition: string; url?: string }) => ({
      tabId: `tab-${nextId++}`,
    })),
    closeTab: vi.fn(),
    navigate: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    setActiveTab: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    onTabState: vi.fn((_cb: (s: BrowserTabState) => void) => () => {}),
    onOpenRequest: vi.fn((_cb: (r: unknown) => void) => () => {}),

    // ── Overhaul (WP3/4/5/7) additive plumbing — keep the mock in lockstep
    //    with the BrowserApi shape ensureBrowserBridge subscribes to. ──
    reorderTab: vi.fn(),
    setTabPinned: vi.fn(),
    reopenClosedTab: vi.fn(async () => null),
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    setZoom: vi.fn(),
    contextMenuRequest: vi.fn(),
    bookmarkList: vi.fn(async () => []),
    bookmarkAdd: vi.fn(async ({ title, url }: { title: string; url: string }) => ({
      id: 'bm-1',
      title,
      url,
      createdAt: 0,
      sortOrder: 0,
    })),
    bookmarkRemove: vi.fn(),
    bookmarkReorder: vi.fn(),
    historyList: vi.fn(async () => []),
    historyDelete: vi.fn(),
    historyClear: vi.fn(),
    onTabsSnapshot: vi.fn((_cb: (e: unknown) => void) => () => {}),
    onShortcutCommand: vi.fn((_cb: (s: unknown, c: unknown) => void) => () => {}),
    onFoundInPage: vi.fn((_cb: (r: unknown) => void) => () => {}),
    onContextMenuCommand: vi.fn((_cb: (a: unknown, p: unknown) => void) => () => {}),
    onBookmarksChanged: vi.fn((_cb: (b: unknown) => void) => () => {}),
  };
}

type MockApi = ReturnType<typeof makeMockApi>;

function installApi(api: MockApi | null) {
  (window as unknown as { api?: unknown }).api = api ? { browser: api } : {};
}

function tabState(overrides: Partial<BrowserTabState> & { tabId: string }): BrowserTabState {
  return {
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    partition: 'user',
    ...overrides,
  };
}

let api: MockApi;

beforeEach(() => {
  api = makeMockApi();
  installApi(api);
  __resetBrowserBridgeForTests();
  useBrowserStore.setState({
    tabs: [],
    activeTabId: null,
    selectedWorkspaceId: null,
    attentionTabIds: {},
    paneAttention: false,
    pendingOpenUrl: null,
  });
  useDashboardStore.setState({
    browserOpen: false,
    fileViewerOpen: false,
    openTabs: [],
    activeTabId: null,
    workspaces: [],
    selectedWorkspaceId: null,
  });
});

describe('normalizeAddressInput', () => {
  it('prepends https:// to bare hosts', () => {
    expect(normalizeAddressInput('example.com')).toBe('https://example.com');
    expect(normalizeAddressInput('  example.com/path?q=1  ')).toBe('https://example.com/path?q=1');
  });

  it('leaves explicit schemes untouched (main-process M6 gates enforce policy)', () => {
    expect(normalizeAddressInput('https://a.dev/x')).toBe('https://a.dev/x');
    expect(normalizeAddressInput('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeAddressInput('file:///etc/passwd')).toBe('file:///etc/passwd');
  });

  it('handles protocol-relative and empty input', () => {
    expect(normalizeAddressInput('//cdn.example.com/x')).toBe('https://cdn.example.com/x');
    expect(normalizeAddressInput('   ')).toBeNull();
    expect(normalizeAddressInput('')).toBeNull();
  });
});

describe('tab lifecycle', () => {
  it('createTab defaults to the user partition, adds and activates the tab', async () => {
    const id = await useBrowserStore.getState().createTab();
    expect(id).toBe('tab-1');
    expect(api.createTab).toHaveBeenCalledWith({ partition: 'user', url: undefined, workspaceId: null });
    const s = useBrowserStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe('tab-1');
  });

  it('createTab returns null and stays consistent when the API is absent', async () => {
    installApi(null);
    const id = await useBrowserStore.getState().createTab();
    expect(id).toBeNull();
    expect(useBrowserStore.getState().tabs).toHaveLength(0);
  });

  it('closeTab of a non-active tab keeps the active tab', async () => {
    const store = useBrowserStore.getState();
    const a = (await store.createTab())!;
    const b = (await store.createTab())!;
    const c = (await store.createTab())!;
    useBrowserStore.getState().selectTab(c);
    useBrowserStore.getState().closeTab(b);
    expect(api.closeTab).toHaveBeenCalledWith(b);
    const s = useBrowserStore.getState();
    expect(s.tabs.map((t) => t.tabId)).toEqual([a, c]);
    expect(s.activeTabId).toBe(c);
  });

  it('closeTab of the active tab activates the right neighbor, then left at the end', async () => {
    const store = useBrowserStore.getState();
    const a = (await store.createTab())!;
    const b = (await store.createTab())!;
    const c = (await store.createTab())!;
    useBrowserStore.getState().selectTab(b);
    useBrowserStore.getState().closeTab(b);
    expect(useBrowserStore.getState().activeTabId).toBe(c);
    useBrowserStore.getState().closeTab(c);
    expect(useBrowserStore.getState().activeTabId).toBe(a);
    useBrowserStore.getState().closeTab(a);
    expect(useBrowserStore.getState().activeTabId).toBeNull();
    expect(useBrowserStore.getState().tabs).toHaveLength(0);
  });

  it('navigate normalizes the address and marks the tab loading', async () => {
    const a = (await useBrowserStore.getState().createTab())!;
    useBrowserStore.getState().navigate(a, 'example.com');
    expect(api.navigate).toHaveBeenCalledWith(a, 'https://example.com');
    const tab = useBrowserStore.getState().tabs[0];
    expect(tab.url).toBe('https://example.com');
    expect(tab.loading).toBe(true);
  });

  it('handleTabState updates nav state for a known tab', async () => {
    const a = (await useBrowserStore.getState().createTab())!;
    useBrowserStore.getState().handleTabState(
      tabState({ tabId: a, url: 'https://x.dev/', title: 'X', canGoBack: true, loading: false }),
    );
    const tab = useBrowserStore.getState().tabs[0];
    expect(tab.title).toBe('X');
    expect(tab.canGoBack).toBe(true);
    expect(useBrowserStore.getState().attentionTabIds[a]).toBeUndefined();
  });
});

describe('Slice-1: secureState + lastError snapshot mapping', () => {
  it('maps secureState and lastError onto the tab shape', async () => {
    const a = (await useBrowserStore.getState().createTab())!;
    useBrowserStore.getState().handleTabState(
      tabState({
        tabId: a,
        secureState: 'insecure',
        lastError: { code: '-105', description: 'ERR_NAME_NOT_RESOLVED', url: 'http://x.dev/' },
      }),
    );
    const tab = useBrowserStore.getState().tabs[0];
    expect(tab.secureState).toBe('insecure');
    expect(tab.lastError).toEqual({ code: '-105', description: 'ERR_NAME_NOT_RESOLVED', url: 'http://x.dev/' });
    // The error payload carries ONLY shell strings — never page content.
    expect(Object.keys(tab.lastError!).sort()).toEqual(['code', 'description', 'url']);
  });

  it('a subsequent state with lastError: null clears a prior error (reload/select path)', async () => {
    const a = (await useBrowserStore.getState().createTab())!;
    useBrowserStore.getState().handleTabState(
      tabState({ tabId: a, lastError: { code: 'crashed', description: 'gone', url: 'https://x.dev/' } }),
    );
    expect(useBrowserStore.getState().tabs[0].lastError).not.toBeNull();
    // Main always re-sends lastError (null when clear) so the merge clears it.
    useBrowserStore.getState().handleTabState(
      tabState({ tabId: a, secureState: 'secure', lastError: null }),
    );
    const tab = useBrowserStore.getState().tabs[0];
    expect(tab.lastError).toBeNull();
    expect(tab.secureState).toBe('secure');
  });
});

describe('agent-attention flash (plan §4 UX)', () => {
  it('an unknown agent-partition tab raises attention and pulses the entry button WITHOUT auto-opening the pane', () => {
    useBrowserStore.getState().handleTabState(tabState({ tabId: 'agent-1', partition: 'agent' }));
    const s = useBrowserStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.attentionTabIds['agent-1']).toBe(true);
    expect(s.activeTabId).toBe('agent-1');
    // Agent activity must never yank the user to the browser — pulse only.
    expect(s.paneAttention).toBe(true);
    expect(useDashboardStore.getState().browserOpen).toBe(false);
  });

  it('while the file viewer holds the center, it still pulses the entry button without opening (file viewer untouched)', () => {
    useDashboardStore.setState({ fileViewerOpen: true });
    useBrowserStore.getState().handleTabState(tabState({ tabId: 'agent-1', partition: 'agent' }));
    expect(useDashboardStore.getState().browserOpen).toBe(false);
    expect(useDashboardStore.getState().fileViewerOpen).toBe(true);
    expect(useBrowserStore.getState().paneAttention).toBe(true);
  });

  it('the Phase-2 openedByAgent flag turning on raises attention for a known tab', async () => {
    const a = (await useBrowserStore.getState().createTab())!;
    useBrowserStore.getState().handleTabState(tabState({ tabId: a, openedByAgent: true }));
    expect(useBrowserStore.getState().attentionTabIds[a]).toBe(true);
  });

  it('selecting the tab clears its attention pulse', () => {
    useBrowserStore.getState().handleTabState(tabState({ tabId: 'agent-1', partition: 'agent' }));
    useBrowserStore.getState().selectTab('agent-1');
    expect(useBrowserStore.getState().attentionTabIds['agent-1']).toBeUndefined();
  });

  it('a locally-created user tab never raises attention', async () => {
    const a = (await useBrowserStore.getState().createTab('user'))!;
    useBrowserStore.getState().handleTabState(tabState({ tabId: a }));
    expect(useBrowserStore.getState().attentionTabIds[a]).toBeUndefined();
    expect(useBrowserStore.getState().paneAttention).toBe(false);
  });
});

describe('Slice-2: authoritative agent identity + attention model', () => {
  // A realistic main payload for an agent-opened tab: agent identity stamped by
  // the trusted API layer + the authoritative attention flag with a stamp.
  const agentTab = (id: string, over: Partial<BrowserTabState> = {}): BrowserTabState =>
    tabState({
      tabId: id,
      partition: 'agent',
      openedByAgent: true,
      openedByAgentId: 'agent-7',
      openedByAgentTitle: 'Research bot',
      needsHumanAttention: true,
      lastAttentionAt: 1000,
      ...over,
    });

  it('(a) an agent-opened tab carries the opening agent id + title', () => {
    useBrowserStore.getState().handleTabState(agentTab('t1'));
    const tab = useBrowserStore.getState().tabs.find((t) => t.tabId === 't1');
    expect(tab?.openedByAgentId).toBe('agent-7');
    expect(tab?.openedByAgentTitle).toBe('Research bot');
  });

  it('(b) selecting an attention tab clears attention for THAT tab only', () => {
    useBrowserStore.getState().handleTabState(agentTab('t1', { lastAttentionAt: 1000 }));
    useBrowserStore.getState().handleTabState(agentTab('t2', { lastAttentionAt: 2000 }));
    expect(useBrowserStore.getState().attentionTabIds['t1']).toBe(true);
    expect(useBrowserStore.getState().attentionTabIds['t2']).toBe(true);

    useBrowserStore.getState().selectTab('t1');

    const s = useBrowserStore.getState();
    expect(s.attentionTabIds['t1']).toBeUndefined();
    expect(s.attentionTabIds['t2']).toBe(true); // the other tab keeps its flash
  });

  it('(c) cross-workspace attention pulses the pane entry WITHOUT activating a hidden tab', () => {
    // Human is viewing ws-A with the pane closed; an agent raises a tab in ws-B.
    useBrowserStore.setState({ selectedWorkspaceId: 'ws-A', activeTabId: null });
    useDashboardStore.setState({ browserOpen: false });

    useBrowserStore.getState().handleTabState(agentTab('t-bg', { workspaceId: 'ws-B' }));

    const s = useBrowserStore.getState();
    expect(s.attentionTabIds['t-bg']).toBe(true);
    expect(s.paneAttention).toBe(true);
    // The hidden cross-workspace tab must NOT become active (would blank the pane).
    expect(s.activeTabId).toBeNull();
  });

  it('a steady-state push (same lastAttentionAt) after select does not re-flash — main sets attention once', () => {
    useBrowserStore.getState().handleTabState(agentTab('t1', { lastAttentionAt: 1000 }));
    useBrowserStore.getState().selectTab('t1');
    expect(useBrowserStore.getState().attentionTabIds['t1']).toBeUndefined();

    // A later tab-state push (title/loading change) carries the SAME stamp →
    // the renderer must not re-raise attention on the now-seen tab.
    useBrowserStore
      .getState()
      .handleTabState(agentTab('t1', { lastAttentionAt: 1000, title: 'New title' }));
    expect(useBrowserStore.getState().attentionTabIds['t1']).toBeUndefined();
  });
});

describe('denied window.open requests', () => {
  it('accepts both the object and bare-string payload forms', () => {
    useBrowserStore.getState().handleOpenRequest({ url: 'https://a.dev/' });
    expect(useBrowserStore.getState().pendingOpenUrl).toBe('https://a.dev/');
    useBrowserStore.getState().handleOpenRequest('https://b.dev/');
    expect(useBrowserStore.getState().pendingOpenUrl).toBe('https://b.dev/');
  });

  it('acceptOpenRequest opens the URL in a new user-partition tab', async () => {
    useBrowserStore.getState().handleOpenRequest({ url: 'https://a.dev/' });
    await useBrowserStore.getState().acceptOpenRequest();
    expect(api.createTab).toHaveBeenCalledWith({ partition: 'user', url: 'https://a.dev/', workspaceId: null });
    expect(useBrowserStore.getState().pendingOpenUrl).toBeNull();
  });

  it('dismissOpenRequest clears without opening', () => {
    useBrowserStore.getState().handleOpenRequest({ url: 'https://a.dev/' });
    useBrowserStore.getState().dismissOpenRequest();
    expect(useBrowserStore.getState().pendingOpenUrl).toBeNull();
    expect(api.createTab).not.toHaveBeenCalled();
  });
});

describe('event bridge', () => {
  it('subscribes once, reports false while the API is absent, and routes events to the store', () => {
    installApi(null);
    expect(ensureBrowserBridge()).toBe(false);

    installApi(api);
    expect(ensureBrowserBridge()).toBe(true);
    expect(ensureBrowserBridge()).toBe(true);
    expect(api.onTabState).toHaveBeenCalledTimes(1);
    expect(api.onOpenRequest).toHaveBeenCalledTimes(1);

    const tabCb = api.onTabState.mock.calls[0][0] as (s: BrowserTabState) => void;
    tabCb(tabState({ tabId: 'from-main' }));
    expect(useBrowserStore.getState().tabs.map((t) => t.tabId)).toContain('from-main');
  });
});

describe('BrowserApi facade calls', () => {
  it('goBack/goForward/reload/stop forward to the API', async () => {
    const a = (await useBrowserStore.getState().createTab())!;
    const s = useBrowserStore.getState();
    s.goBack(a);
    s.goForward(a);
    s.reload(a);
    s.stop(a);
    expect(api.goBack).toHaveBeenCalledWith(a);
    expect(api.goForward).toHaveBeenCalledWith(a);
    expect(api.reload).toHaveBeenCalledWith(a);
    expect(api.stop).toHaveBeenCalledWith(a);
  });
});

// Keep the mirrored contract honest: this type-level assertion fails to
// compile if the mock drifts from the BrowserApi shape the components use.
const _contractCheck: BrowserApi = makeMockApi() as unknown as BrowserApi;
void _contractCheck;
