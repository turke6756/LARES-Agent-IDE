// BrowserManager website-allowlist tests (plans/website-allowlist-design.md
// §9e + §12 + §17 + §18). The manager is Electron-coupled, so — like
// access-policy-store.test.ts — this injects a sql.js (wasm SQLite) stand-in
// for better-sqlite3 AND a minimal `electron` stand-in into require.cache
// BEFORE requiring ../browser/browser-manager. No real WebContentsView /
// session is ever constructed: tabs are fabricated as TabEntry-shaped fakes and
// injected into the private `tabs` map, so we exercise the policy seams
// (`gate`, `isAgentDrivable`, `toolListTabs`, the access-cache invalidation)
// without a live Chromium.
//
// Covers:
//   - §12-A sign-in QUARANTINE: a signinPending tab is absent from toolListTabs,
//     every tool verb is denied 'signin-pending', and only the trusted
//     (non-tool) closeTab can remove it.
//   - §12-B / §17 isAgentDrivable: agent tab drivable; a handed user tab on an
//     allow_signed_in origin drivable; a handed tab that wandered off-origin is
//     auto-revoked (driver detached + flag cleared); an un-handed user tab is
//     never drivable and never enumerable.
//   - §5 existing-tab List-A gate: a stranded agent tab on a now-disallowed
//     origin denies read/act with 'agent-allowlist-denied' while
//     closeTab/goBack/goForward (and about:blank) still work.
//   - §18 request-and-approve: a pending request grants ZERO access until a human
//     approve creates the rule; approve → allow_signed_in 0, approve_signed_in →
//     1, deny → no rule; accessModesSet / a decision invalidate the cache and
//     emit accessChanged.
//
//   npm run build:main
//   node dist/main/main/browser/browser-manager.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompiledRule } from './browser-policy';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors access-policy-store.test) ──

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};

let sqlJsCtor: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }
  pragma(_s: string): unknown { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          return stmt.step() ? stmt.getAsObject() : undefined;
        } finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }
}

// ── minimal `electron` stand-in ──────────────────────────────────────────────
// browser-manager.ts is the only runtime electron importer in the graph
// (everything else type-only). It needs: session.fromPartition(...).harden*,
// app.getPath, Menu (referenced lazily), WebContentsView (never constructed —
// tabs are injected). The session methods are the ones hardenSession() calls.

function fakeSession(): unknown {
  return {
    setUserAgent() {},
    on() {},
    webRequest: { onBeforeRequest() {} },
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    setDevicePermissionHandler() {},
    cookies: { get: async () => [], remove: async () => {} },
    clearStorageData: async () => {},
    // Slice 13: confirmDownload / retryDownload re-initiate via the session.
    downloadURL() {},
  };
}

const electronMock = {
  app: { getPath: () => os.tmpdir() },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  session: { fromPartition: (_partition?: string) => fakeSession() },
  WebContentsView: class {},
};

// ── modules under test (loaded after the cache injections) ───────────────────

type BMModule = typeof import('./browser-manager');
type StoreModule = typeof import('./access-policy-store');
type PolicyModule = typeof import('./browser-policy');
type SharedModule = typeof import('../../shared/browser');
let BM: BMModule;
let store: StoreModule;
let policy: PolicyModule;
let CH: SharedModule['BROWSER_CHANNELS'];

// ── fakes for the tab graph ──────────────────────────────────────────────────

interface FakeDebugger { isAttached(): boolean; attach(): void; detach(): void; detachedCount: number; }
interface FakeWC {
  getURL(): string; getTitle(): string; isDestroyed(): boolean;
  isLoading(): boolean; getZoomFactor(): number;
  // Slice 15 seams: per-site zoom apply (did-navigate) + find-in-page state.
  setZoomFactor(z: number): void;
  findInPage(text: string, options?: Record<string, unknown>): void;
  stopFindInPage(action?: string): void;
  navigationHistory: { canGoBack(): boolean; canGoForward(): boolean };
  debugger: FakeDebugger;
  close(): void;
  // Minimal EventEmitter + no-op surface so wireViewEvents() can be exercised
  // against a fake tab (event-driven nav tests, F2). Only the seams the wired
  // handlers actually touch are implemented; the rest are inert.
  on(event: string, fn: (...a: unknown[]) => void): FakeWC;
  once(event: string, fn: (...a: unknown[]) => void): FakeWC;
  removeListener(event: string, fn: (...a: unknown[]) => void): FakeWC;
  emit(event: string, ...args: unknown[]): void;
  setWindowOpenHandler(fn: (details: { url: string }) => unknown): void;
  /** Last handler registered via setWindowOpenHandler — lets popup-policy tests
   *  invoke it directly and assert the allow/deny decision. */
  windowOpenHandler?: (details: { url: string }) => unknown;
  setUserAgent(): void;
  setURL(url: string): void;
  // Slice-11 sweep seams (idle/cap discard): throttle hidden views + read scroll.
  setBackgroundThrottling(throttle: boolean): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

function fakeWC(url: string, title = 'T'): FakeWC {
  let attached = false;
  let detachedCount = 0;
  let currentUrl = url;
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const dbg: FakeDebugger = {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { attached = false; detachedCount++; },
    get detachedCount() { return detachedCount; },
  };
  const wc: FakeWC = {
    getURL: () => currentUrl,
    getTitle: () => title,
    isDestroyed: () => false,
    isLoading: () => false,
    getZoomFactor: () => 1,
    // Slice 15 seams — inert here (no per-site zoom / find assertions in this
    // suite; the applyPersistedZoom did-navigate path just needs them callable).
    setZoomFactor() {},
    findInPage() {},
    stopFindInPage() {},
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    debugger: dbg,
    close() {},
    on(event, fn) { (listeners.get(event) ?? listeners.set(event, []).get(event)!).push(fn); return wc; },
    once(event, fn) { return wc.on(event, fn); },
    removeListener(event, fn) {
      const fns = listeners.get(event);
      if (fns) listeners.set(event, fns.filter((f) => f !== fn));
      return wc;
    },
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args); },
    setWindowOpenHandler(fn) { wc.windowOpenHandler = fn; },
    setUserAgent() {},
    setURL(next) { currentUrl = next; },
    setBackgroundThrottling() {},
    executeJavaScript: async () => 0,
  };
  return wc;
}

interface MgrHarness { mgr: InstanceType<BMModule['BrowserManager']>; sent: Array<{ channel: string; payload: unknown }>; }

function makeManager(): MgrHarness {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const win = {
    webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } },
    contentView: { addChildView() {}, removeChildView() {} },
    getBackgroundColor: () => '#1e1e1e',
  };
  const mgr = new BM.BrowserManager(() => win as never, 0);
  // Stub the audit writer so a denial path never touches the filesystem.
  (mgr as unknown as { auditWriter: { record(): void } }).auditWriter = { record() {} };
  return { mgr, sent };
}

interface FakeTab {
  id: string; partition: 'agent' | 'user'; partitionFull: string;
  openedByAgent: boolean; signinPending?: boolean; handedToAgent?: boolean;
  // Slice-4: the workspace a fabricated tab belongs to. Undefined → the null /
  // legacy-default workspace (what setCache's default key targets), so existing
  // workspace-agnostic tests keep working unchanged.
  workspaceId?: string | null;
  view: { webContents: FakeWC; setBounds?(): void; setVisible?(): void };
}

let tabSeq = 0;
function injectTab(
  mgr: MgrHarness['mgr'],
  opts: { partition: 'agent' | 'user'; url: string; title?: string; signinPending?: boolean; handedToAgent?: boolean; workspaceId?: string | null },
): FakeTab {
  const id = `tab-${++tabSeq}`;
  const tab: FakeTab = {
    id,
    partition: opts.partition,
    partitionFull: opts.partition === 'agent' ? 'persist:agent' : 'persist:user',
    openedByAgent: false,
    signinPending: opts.signinPending,
    handedToAgent: opts.handedToAgent,
    workspaceId: opts.workspaceId,
    // setBounds/setVisible are inert seams: setActiveTab + applyVisibility call
    // them when a close re-selects a replacement view (close-active repaint path).
    view: { webContents: fakeWC(opts.url, opts.title), setBounds() {}, setVisible() {} },
  };
  const internals = mgr as unknown as { tabs: Map<string, unknown>; tabOrder: string[] };
  internals.tabs.set(id, tab);
  internals.tabOrder.push(id);
  return tab;
}

/** Slice-4 access-cache Map key for a workspace — MUST mirror getAccessCache's
 *  keying (null/undefined → the NULL_WS_CACHE_KEY sentinel 'null-ws', a real id
 *  → `ws:${id}`). Kept in sync by hand because the constant is module-private. */
function wsCacheKey(workspaceId?: string | null): string {
  return workspaceId == null ? 'null-ws' : `ws:${workspaceId}`;
}

/** Seed the manager's synchronously-readable per-workspace access cache directly
 *  (no DB) for a given workspace. Single agent allowlist — enforcement is keyed
 *  to the Agent Actions toggle (set via policy.setRuntimeActionsEnabled in the
 *  tests), not a mode dimension. Defaults to the null/legacy-default workspace,
 *  which is what injectTab's fabricated tabs (no workspaceId) resolve to. */
function setCache(mgr: MgrHarness['mgr'], agentRules: unknown[], workspaceId?: string | null): void {
  const map = (mgr as unknown as { accessCache: Map<string, unknown> }).accessCache;
  map.set(wsCacheKey(workspaceId), { agentRules });
}

/** Reach a private method for direct unit exercise. */
function priv<T = unknown>(mgr: MgrHarness['mgr'], name: string): (...a: unknown[]) => T {
  const fn = (mgr as unknown as Record<string, unknown>)[name];
  return (fn as (...a: unknown[]) => T).bind(mgr) as (...a: unknown[]) => T;
}

function compiled(over: { hostname: string; includeSubdomains?: boolean; scheme?: 'https' | 'http' | 'any'; pathPrefix?: string; allowSignedIn?: boolean }) {
  return { includeSubdomains: false, scheme: 'https' as const, ...over };
}

function expectPolicyDeny(fn: () => void, code: string): void {
  try {
    fn();
    assert.fail(`expected PolicyError(${code}) but nothing threw`);
  } catch (err) {
    assert.equal((err as { name?: string }).name, 'PolicyError', `expected PolicyError, got ${String(err)}`);
    assert.equal((err as { code?: string }).code, code);
  }
}

// ── §12-A sign-in QUARANTINE ─────────────────────────────────────────────────

test('signinPending tab is ABSENT from toolListTabs (§12-A / §17 — quarantine omits it)', () => {
  const { mgr } = makeManager();
  setCache(mgr, []);
  injectTab(mgr, { partition: 'agent', url: 'https://normal.example/', title: 'open' });
  injectTab(mgr, { partition: 'agent', url: 'https://accounts.google.com/signin', title: 'signing in', signinPending: true });
  const listed = mgr.tools.listTabs();
  assert.equal(listed.length, 1, 'only the non-quarantined agent tab is enumerable');
  assert.equal(listed[0].url, 'https://normal.example/');
});

test('every tool verb against a signinPending tab is denied with code signin-pending', () => {
  const { mgr } = makeManager();
  setCache(mgr, []);
  policy.setRuntimeActionsEnabled(true); // so act verbs reach (and are stopped before) checkAction
  const tab = injectTab(mgr, { partition: 'agent', url: 'https://accounts.google.com/signin', signinPending: true });
  const gate = priv<void>(mgr, 'gate');
  for (const verb of ['readPage', 'getPageText', 'click', 'type', 'closeTab', 'goBack']) {
    expectPolicyDeny(() => gate(verb, tab.partitionFull, tab.view.webContents.getURL(), {}, tab), 'signin-pending');
  }
  policy.__resetRuntimeActionsEnabledForTests();
});

test('only the trusted (non-tool) closeTab removes a quarantined tab', () => {
  const { mgr } = makeManager();
  setCache(mgr, []);
  const tab = injectTab(mgr, { partition: 'agent', url: 'https://accounts.google.com/signin', signinPending: true });
  const internals = mgr as unknown as { tabs: Map<string, unknown> };
  assert.ok(internals.tabs.has(tab.id));
  mgr.closeTab(tab.id); // trusted-chrome manager method, NOT gate-routed
  assert.equal(internals.tabs.has(tab.id), false, 'trusted closeTab removed the quarantined tab');
});

// ── §12-B / §17 isAgentDrivable ──────────────────────────────────────────────

test('isAgentDrivable: an ordinary persist:agent tab is drivable', () => {
  const { mgr } = makeManager();
  setCache(mgr, []);
  const tab = injectTab(mgr, { partition: 'agent', url: 'https://anything.example/' });
  assert.equal(priv<boolean>(mgr, 'isAgentDrivable')(tab), true);
});

test('isAgentDrivable: a handed persist:user tab on an allow_signed_in origin is drivable', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'mail.example', includeSubdomains: true, allowSignedIn: true })]);
  const tab = injectTab(mgr, { partition: 'user', url: 'https://mail.example/inbox', handedToAgent: true });
  assert.equal(priv<boolean>(mgr, 'isAgentDrivable')(tab), true);
});

test('isAgentDrivable: a handed user tab whose origin is NOT allow_signed_in is not drivable', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'mail.example', allowSignedIn: false })]);
  const tab = injectTab(mgr, { partition: 'user', url: 'https://mail.example/inbox', handedToAgent: true });
  assert.equal(priv<boolean>(mgr, 'isAgentDrivable')(tab), false);
});

test('toolListTabs INCLUDES a handed allow_signed_in user tab (§17 predicate widen)', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'mail.example', includeSubdomains: true, allowSignedIn: true })]);
  injectTab(mgr, { partition: 'agent', url: 'https://agent.example/' });
  const handed = injectTab(mgr, { partition: 'user', url: 'https://mail.example/inbox', handedToAgent: true });
  const listed = mgr.tools.listTabs();
  assert.ok(listed.some((t) => t.tabId === handed.id), 'a handed tab is enumerable to the agent');
  assert.equal(listed.length, 2);
});

test('isAgentDrivable: an un-handed persist:user tab is never drivable nor enumerable', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'mail.example', includeSubdomains: true, allowSignedIn: true })]);
  const tab = injectTab(mgr, { partition: 'user', url: 'https://mail.example/inbox', handedToAgent: false });
  assert.equal(priv<boolean>(mgr, 'isAgentDrivable')(tab), false, 'no hand-off → never drivable');
  assert.equal(mgr.tools.listTabs().some((t) => t.tabId === tab.id), false, 'user tabs are never enumerable');
});

test('handed tab after an off-origin nav is AUTO-REVOKED (driver detached + handedToAgent cleared)', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'mail.example', includeSubdomains: true, allowSignedIn: true })]);
  const tab = injectTab(mgr, { partition: 'user', url: 'https://mail.example/inbox', handedToAgent: true });
  // Attach a live driver + debugger, as if the agent had been driving it.
  const drivers = (mgr as unknown as { drivers: Map<string, unknown> }).drivers;
  drivers.set(tab.id, { dummy: true });
  tab.view.webContents.debugger.attach();
  assert.equal(priv<boolean>(mgr, 'isAgentDrivable')(tab), true, 'drivable while on-origin');

  priv<void>(mgr, 'autoRevokeIfOffOrigin')(tab, 'https://evil.example/landing');

  assert.equal(tab.handedToAgent, false, 'handedToAgent cleared on off-origin nav');
  assert.equal(drivers.has(tab.id), false, 'CDP driver dropped');
  assert.equal(tab.view.webContents.debugger.isAttached(), false, 'debugger detached');
  assert.equal(tab.view.webContents.debugger.detachedCount, 1);
  assert.equal(priv<boolean>(mgr, 'isAgentDrivable')(tab), false, 'no longer drivable after revoke');
});

// ── F1: enumeration follows isAgentDrivable (no raw-flag bypass) ─────────────

test('F1: a handed user tab whose committed origin is OFF its allow_signed_in rule is OMITTED from toolListTabs', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'mail.example', includeSubdomains: true, allowSignedIn: true })]);
  injectTab(mgr, { partition: 'agent', url: 'https://agent.example/' });
  // Handed, but the live committed URL has wandered off the allow_signed_in
  // origin — the stale handedToAgent flag must NOT keep it enumerable.
  const handed = injectTab(mgr, { partition: 'user', url: 'https://chase.com/account', handedToAgent: true });
  const listed = mgr.tools.listTabs();
  assert.equal(listed.some((t) => t.tabId === handed.id), false, 'off-origin handed tab is hidden');
  assert.equal(listed.length, 1, 'only the ordinary agent tab remains enumerable');
});

// ── F2: event-driven off-origin auto-revoke (wireViewEvents handlers) ────────

/** Attach a live driver + debugger to a handed tab and wire its real nav
 *  handlers, mirroring a tab the agent had been driving. */
function wireDrivenHandedTab(mgr: MgrHarness['mgr'], url: string): FakeTab {
  const tab = injectTab(mgr, { partition: 'user', url, handedToAgent: true });
  (mgr as unknown as { drivers: Map<string, unknown> }).drivers.set(tab.id, { dummy: true });
  tab.view.webContents.debugger.attach();
  priv<void>(mgr, 'wireViewEvents')(tab);
  return tab;
}

test('F2: emitting did-navigate off-origin clears handedToAgent and detaches the driver', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'mail.example', includeSubdomains: true, allowSignedIn: true })]);
  const tab = wireDrivenHandedTab(mgr, 'https://mail.example/inbox');
  const drivers = (mgr as unknown as { drivers: Map<string, unknown> }).drivers;
  assert.equal(priv<boolean>(mgr, 'isAgentDrivable')(tab), true, 'drivable on-origin');

  tab.view.webContents.setURL('https://evil.example/landing');
  tab.view.webContents.emit('did-navigate', {}, 'https://evil.example/landing');

  assert.equal(tab.handedToAgent, false, 'handedToAgent cleared on committed off-origin nav');
  assert.equal(drivers.has(tab.id), false, 'CDP driver dropped');
  assert.equal(tab.view.webContents.debugger.isAttached(), false, 'debugger detached');
});

test('F2: emitting will-navigate off-origin (allowed scheme) clears handedToAgent and detaches the driver', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'mail.example', includeSubdomains: true, allowSignedIn: true })]);
  const tab = wireDrivenHandedTab(mgr, 'https://mail.example/inbox');
  const drivers = (mgr as unknown as { drivers: Map<string, unknown> }).drivers;

  tab.view.webContents.emit('will-navigate', { preventDefault() {} }, 'https://other.example/page');

  assert.equal(tab.handedToAgent, false, 'handedToAgent cleared on allowed off-origin will-navigate');
  assert.equal(drivers.has(tab.id), false, 'CDP driver dropped');
  assert.equal(tab.view.webContents.debugger.isAttached(), false, 'debugger detached');
});

test('F2: an ON-origin nav does NOT revoke a handed tab', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'mail.example', includeSubdomains: true, allowSignedIn: true })]);
  const tab = wireDrivenHandedTab(mgr, 'https://mail.example/inbox');
  const drivers = (mgr as unknown as { drivers: Map<string, unknown> }).drivers;

  tab.view.webContents.setURL('https://mail.example/sent');
  tab.view.webContents.emit('did-navigate', {}, 'https://mail.example/sent');

  assert.equal(tab.handedToAgent, true, 'still handed on-origin');
  assert.equal(drivers.has(tab.id), true, 'driver retained on-origin');
});

// ── F3: rule mutations detach + clear handed tabs that lose drivability ───────

test('F3: accessRuleUpdate clearing allowSignedIn detaches + clears a handed tab', () => {
  const { mgr } = makeManager();
  const rule = mgr.accessRuleAdd({
    hostname: 'mail.example', includeSubdomains: true, scheme: 'https', allowSignedIn: true,
  });
  const tab = wireDrivenHandedTab(mgr, 'https://mail.example/inbox');
  const drivers = (mgr as unknown as { drivers: Map<string, unknown> }).drivers;
  assert.equal(priv<boolean>(mgr, 'isAgentDrivable')(tab), true, 'drivable while rule allow_signed_in');

  mgr.accessRuleUpdate(rule.id, { allowSignedIn: false });

  assert.equal(tab.handedToAgent, false, 'handed flag cleared after allowSignedIn toggled off');
  assert.equal(drivers.has(tab.id), false, 'driver detached');
  assert.equal(tab.view.webContents.debugger.isAttached(), false, 'debugger detached');
});

test('F3: accessRuleRemove detaches + clears a handed tab', () => {
  const { mgr } = makeManager();
  const rule = mgr.accessRuleAdd({
    hostname: 'mail2.example', includeSubdomains: true, scheme: 'https', allowSignedIn: true,
  });
  const tab = wireDrivenHandedTab(mgr, 'https://mail2.example/inbox');
  const drivers = (mgr as unknown as { drivers: Map<string, unknown> }).drivers;
  assert.equal(priv<boolean>(mgr, 'isAgentDrivable')(tab), true, 'drivable before rule removal');

  mgr.accessRuleRemove(rule.id);

  assert.equal(tab.handedToAgent, false, 'handed flag cleared after rule removed');
  assert.equal(drivers.has(tab.id), false, 'driver detached');
});

// ── F4: sendTabState surfaces the authoritative handed/quarantine flags ───────

test('F4: sendTabState payload includes handedToAgent when set', () => {
  const { mgr, sent } = makeManager();
  setCache(mgr, [compiled({ hostname: 'mail.example', includeSubdomains: true, allowSignedIn: true })]);
  const tab = injectTab(mgr, { partition: 'user', url: 'https://mail.example/inbox', handedToAgent: true });
  sent.length = 0;
  priv<void>(mgr, 'sendTabState')(tab);
  const msg = sent.find((s) => s.channel === CH.tabState);
  assert.ok(msg, 'a tabState message was sent');
  const payload = msg!.payload as { handedToAgent?: boolean; signinPending?: boolean };
  assert.equal(payload.handedToAgent, true, 'handedToAgent surfaced to the renderer');
  assert.equal(payload.signinPending, undefined, 'signinPending absent (additive idiom)');
});

test('F4: sendTabState payload includes signinPending when set; omits both when unset', () => {
  const { mgr, sent } = makeManager();
  setCache(mgr, []);
  const quarantined = injectTab(mgr, { partition: 'agent', url: 'https://accounts.google.com/signin', signinPending: true });
  const ordinary = injectTab(mgr, { partition: 'agent', url: 'https://agent.example/' });

  sent.length = 0;
  priv<void>(mgr, 'sendTabState')(quarantined);
  const q = sent.find((s) => s.channel === CH.tabState)!.payload as { signinPending?: boolean; handedToAgent?: boolean };
  assert.equal(q.signinPending, true, 'signinPending surfaced');
  assert.equal(q.handedToAgent, undefined, 'handedToAgent absent for a non-handed tab');

  sent.length = 0;
  priv<void>(mgr, 'sendTabState')(ordinary);
  const o = sent.find((s) => s.channel === CH.tabState)!.payload as { signinPending?: boolean; handedToAgent?: boolean };
  assert.equal(o.signinPending, undefined, 'no signinPending on an ordinary tab');
  assert.equal(o.handedToAgent, undefined, 'no handedToAgent on an ordinary tab');
});

// ── §5 existing-tab allowlist gate (enforcement keyed to Agent Actions) ──────

test('existing-tab gate: a stranded agent tab on a disallowed origin denies read/act, allows escape verbs', () => {
  const { mgr } = makeManager();
  // Agent Actions ON + no matching rule → the committed origin is disallowed.
  setCache(mgr, []);
  policy.setRuntimeActionsEnabled(true);
  const tab = injectTab(mgr, { partition: 'agent', url: 'https://disallowed.example/page' });
  const gate = priv<void>(mgr, 'gate');
  const url = tab.view.webContents.getURL();

  // Read + act verbs are denied against the stranded origin.
  for (const verb of ['readPage', 'getPageText', 'click']) {
    expectPolicyDeny(() => gate(verb, tab.partitionFull, url, {}, tab), 'agent-allowlist-denied');
  }
  // Escape / cleanup verbs always succeed so the agent can recover.
  for (const verb of ['closeTab', 'goBack', 'goForward']) {
    assert.doesNotThrow(() => gate(verb, tab.partitionFull, url, {}, tab), `${verb} must remain available`);
  }
  policy.__resetRuntimeActionsEnabledForTests();
});

test('existing-tab gate: enforcement is keyed to Agent Actions — OFF leaves reads ungated', () => {
  const { mgr } = makeManager();
  setCache(mgr, []); // empty allowlist
  policy.setRuntimeActionsEnabled(false); // Agent Actions OFF
  const tab = injectTab(mgr, { partition: 'agent', url: 'https://disallowed.example/page' });
  const gate = priv<void>(mgr, 'gate');
  // With actions OFF, the allowlist is not enforced on reads against an open tab.
  assert.doesNotThrow(() => gate('readPage', tab.partitionFull, tab.view.webContents.getURL(), {}, tab));
  policy.__resetRuntimeActionsEnabledForTests();
});

test('existing-tab gate: an about:blank / brand-new agent tab is exempt (Actions ON)', () => {
  const { mgr } = makeManager();
  setCache(mgr, []);
  policy.setRuntimeActionsEnabled(true);
  const tab = injectTab(mgr, { partition: 'agent', url: 'about:blank' });
  const gate = priv<void>(mgr, 'gate');
  assert.doesNotThrow(() => gate('readPage', tab.partitionFull, 'about:blank', {}, tab));
  policy.__resetRuntimeActionsEnabledForTests();
});

test('existing-tab gate: a matching allowlist rule lets read through (Actions ON)', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'allowed.example', includeSubdomains: true })]);
  policy.setRuntimeActionsEnabled(true);
  const tab = injectTab(mgr, { partition: 'agent', url: 'https://allowed.example/page' });
  const gate = priv<void>(mgr, 'gate');
  assert.doesNotThrow(() => gate('readPage', tab.partitionFull, tab.view.webContents.getURL(), {}, tab));
  policy.__resetRuntimeActionsEnabledForTests();
});

// ── §18 request-and-approve + cache invalidation (DB-backed) ─────────────────

test('accessRuleAdd invalidates the cache (next read sees the new rule) and emits accessChanged', () => {
  const { mgr, sent } = makeManager();
  const agentCtx = priv<{ rules: CompiledRule[] }>(mgr, 'agentCtx');
  mgr.invalidateAccessCache();
  const host = 'cache-invalidate.example';
  assert.equal(agentCtx().rules.some((r) => r.hostname === host), false, 'rule absent at baseline');

  sent.length = 0;
  const rule = mgr.accessRuleAdd({ hostname: host, includeSubdomains: true, scheme: 'https', allowSignedIn: false });
  assert.equal(agentCtx().rules.some((r) => r.hostname === host), true, 'cache invalidated → next read observes the new rule');
  assert.ok(sent.some((s) => s.channel === CH.accessChanged), 'accessChanged emitted');
  mgr.accessRuleRemove(rule.id); // restore for other tests
  mgr.invalidateAccessCache();
});

test('a pending request grants ZERO access until a human approve creates the rule', () => {
  const { mgr, sent } = makeManager();
  mgr.invalidateAccessCache();
  const checkAgentVisit = policy.checkAgentVisit;
  const agentCtx = priv<{ rules: CompiledRule[] }>(mgr, 'agentCtx');
  const host = 'request-grant.example';
  const target = `https://${host}/docs`;

  // The agent files a request — inert.
  const { status } = mgr.tools.requestSiteAccess({ hostname: host, reason: 'need the docs', requestedBy: 'agent-req' });
  assert.equal(status, 'pending');
  assert.equal(checkAgentVisit(target, agentCtx()).allow, false, 'pending request does NOT grant access');

  // A human approves → a real rule is created, cache invalidated, access live.
  const pending = store.listRequests().find((r) => r.hostname === host && r.status === 'pending');
  assert.ok(pending, 'the pending request exists');
  sent.length = 0;
  mgr.accessRequestDecide(pending!.id, 'approve');
  assert.equal(checkAgentVisit(target, agentCtx()).allow, true, 'the approved rule makes the visit succeed');
  assert.ok(sent.some((s) => s.channel === CH.accessChanged), 'accessChanged emitted on decision');
  assert.ok(sent.some((s) => s.channel === CH.accessRequestsChanged), 'accessRequestsChanged emitted');

  const created = mgr.accessRuleList().find((r) => r.hostname === host);
  assert.ok(created);
  assert.equal(created!.allowSignedIn, false, 'a plain approve never grants signed-in');
  mgr.invalidateAccessCache();
});

test('approve_signed_in creates an allow_signed_in rule; deny creates no rule', () => {
  const { mgr } = makeManager();
  // approve_signed_in
  mgr.tools.requestSiteAccess({ hostname: 'authdrive-mgr.example', reason: 'mail', requestedBy: 'agent-sd', wantSignedIn: true });
  const sdReq = store.listRequests().find((r) => r.hostname === 'authdrive-mgr.example' && r.status === 'pending')!;
  mgr.accessRequestDecide(sdReq.id, 'approve_signed_in');
  const sdRule = mgr.accessRuleList().find((r) => r.hostname === 'authdrive-mgr.example')!;
  assert.equal(sdRule.allowSignedIn, true, 'approve_signed_in → allow_signed_in 1');

  // deny
  mgr.tools.requestSiteAccess({ hostname: 'deny-mgr.example', reason: 'no', requestedBy: 'agent-dn' });
  const dnReq = store.listRequests().find((r) => r.hostname === 'deny-mgr.example' && r.status === 'pending')!;
  const before = mgr.accessRuleList().length;
  mgr.accessRequestDecide(dnReq.id, 'deny');
  assert.equal(mgr.accessRuleList().length, before, 'deny creates no rule');
});

// ── Slice-4: workspace-scoped agent partitions & access state ────────────────
// The trust claim is that an agent's signed-in sessions and access rules are
// STRICTLY per-workspace: signed-in/handed-off in workspace A is NOT usable by
// agents in B (DECIDED 2026-06-17, Edward). The three required proofs:
//   (a) the agent SESSION partition (the cookie/storage isolation boundary) is
//       per-workspace, so A's cookies live in a different Electron session than
//       B's and are invisible across the boundary;
//   (b) a rule approved in A does NOT authorize B's agent (deny-by-default);
//   (c) legacy NULL-workspace rows still apply as the back-compat default.

test('Slice-4(a): the agent SESSION partition is per-workspace — A and B never share one (cookie/storage isolation boundary)', () => {
  const a = BM.agentPartitionForWorkspace('ws-A-uuid');
  const b = BM.agentPartitionForWorkspace('ws-B-uuid');
  // Distinct workspaces → distinct Electron session partitions. Because cookies /
  // localStorage / signed-in sessions live on the session named by this string,
  // A's signed-in cookies are physically unreachable from a B tab and vice-versa.
  assert.notEqual(a, b, 'distinct workspaces resolve to distinct agent session partitions');
  assert.match(a, /^persist:agent:/);
  assert.match(b, /^persist:agent:/);
  // An agent partition never collides with the human's shared partition.
  assert.notEqual(a, 'persist:user');
  assert.notEqual(b, 'persist:user');
  // null / undefined / '' → the legacy-default agent partition (back-compat),
  // still distinct from any real (uuid) workspace partition.
  assert.equal(BM.agentPartitionForWorkspace(null), 'persist:agent:default');
  assert.equal(BM.agentPartitionForWorkspace(undefined), 'persist:agent:default');
  assert.equal(BM.agentPartitionForWorkspace(''), 'persist:agent:default');
  assert.notEqual(a, BM.agentPartitionForWorkspace(null), 'a real workspace never shares the null-default partition');
});

test('Slice-4(b): a rule approved in workspace A does NOT authorize an agent in workspace B', () => {
  const { mgr } = makeManager();
  const checkAgentVisit = policy.checkAgentVisit;
  const agentCtx = priv<{ rules: CompiledRule[] }>(mgr, 'agentCtx');
  const host = 'scoped-approve.example';
  const target = `https://${host}/`;
  const A = 'wsb-A-uuid';
  const B = 'wsb-B-uuid';

  // An agent in workspace A files a request — the workspace is resolved trust-side
  // by the API layer (passed here directly, never from the agent's tool args).
  mgr.tools.requestSiteAccess({ hostname: host, reason: 'docs', requestedBy: 'agent-A', workspaceId: A });
  const req = store.listRequests().find((r) => r.hostname === host && r.status === 'pending');
  assert.ok(req, 'the pending request exists');
  assert.equal(req!.workspaceId, A, "the request carries the requesting agent's workspace");

  // A human approves → the created rule INHERITS workspace A.
  mgr.accessRequestDecide(req!.id, 'approve');
  mgr.invalidateAccessCache();
  const rule = store.listRules().find((r) => r.hostname === host);
  assert.ok(rule, 'the approval created a rule');
  assert.equal(rule!.workspaceId, A, 'the approved rule is scoped to the requesting workspace');

  // So A's agent is authorized, but B's agent is denied-by-default.
  assert.equal(checkAgentVisit(target, agentCtx(A)).allow, true, 'workspace A is authorized by its own rule');
  assert.equal(checkAgentVisit(target, agentCtx(B)).allow, false, "workspace B is NOT authorized by A's rule");
  mgr.invalidateAccessCache();
});

test('Slice-4(c): a legacy NULL-workspace rule applies as the default — authorizes every workspace', () => {
  const { mgr } = makeManager();
  const checkAgentVisit = policy.checkAgentVisit;
  const agentCtx = priv<{ rules: CompiledRule[] }>(mgr, 'agentCtx');
  const host = 'legacy-null.example';
  const target = `https://${host}/`;

  // A rule with an explicit null workspace — exactly what a pre-Slice-4 row
  // deserializes to (workspace_id IS NULL). It must keep working unchanged.
  store.insertRule({ hostname: host, scheme: 'https', includeSubdomains: true, allowSignedIn: false, workspaceId: null });
  mgr.invalidateAccessCache();

  // It authorizes agents in ANY workspace (the back-compat default) and the
  // null/default workspace itself.
  assert.equal(checkAgentVisit(target, agentCtx('any-workspace-uuid')).allow, true, 'null-workspace rule applies to an arbitrary workspace');
  assert.equal(checkAgentVisit(target, agentCtx(null)).allow, true, 'and to the null/default workspace');
  mgr.invalidateAccessCache();
});

test('Slice-4: accessRuleList scopes to the selected workspace (own rules + legacy null defaults, never another workspace)', () => {
  const { mgr } = makeManager();
  store.insertRule({ hostname: 'only-a.example', scheme: 'https', includeSubdomains: false, allowSignedIn: false, workspaceId: 'wsd-A' });
  store.insertRule({ hostname: 'only-b.example', scheme: 'https', includeSubdomains: false, allowSignedIn: false, workspaceId: 'wsd-B' });
  store.insertRule({ hostname: 'legacy-default.example', scheme: 'https', includeSubdomains: false, allowSignedIn: false, workspaceId: null });

  mgr.setActiveWorkspace('wsd-A');
  const inA = mgr.accessRuleList().map((r) => r.hostname);
  assert.ok(inA.includes('only-a.example'), 'A sees its own rule');
  assert.ok(inA.includes('legacy-default.example'), 'A sees the legacy null-workspace default');
  assert.ok(!inA.includes('only-b.example'), "A does NOT see workspace B's rule");

  mgr.setActiveWorkspace('wsd-B');
  const inB = mgr.accessRuleList().map((r) => r.hostname);
  assert.ok(inB.includes('only-b.example'), 'B sees its own rule');
  assert.ok(inB.includes('legacy-default.example'), 'B sees the legacy null-workspace default');
  assert.ok(!inB.includes('only-a.example'), "B does NOT see workspace A's rule");
  mgr.setActiveWorkspace(null);
});

// ── Slice 12 (Required-#4): clear-site-session is workspace-scoped ────────────
// Clearing a site session must wipe ONLY the rule's own workspace-scoped agent
// session partition (persist:agent:<workspaceId>) — another workspace's agent
// partition is never touched (mirrors the Slice-4 partition-isolation claim,
// applied to the destructive clear path).

test('Required-#4: accessClearSiteSession clears ONLY the rule\'s workspace agent partition (other workspaces untouched)', async () => {
  // Track per-partition fake sessions so we can observe WHICH partition's storage
  // is cleared. fromPartition is otherwise non-memoizing (a fresh fake per call),
  // so we install a memoizing tracker for the duration of this test and restore
  // it afterward.
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const cleared = new Map<string, unknown[]>();
  const orig = electronMock.session.fromPartition;
  electronMock.session.fromPartition = (partition = '') => {
    let s = sessions.get(partition);
    if (!s) {
      const calls: unknown[] = [];
      const base = fakeSession() as Record<string, unknown>;
      base.clearStorageData = async (opts: unknown) => {
        calls.push(opts);
      };
      s = base;
      sessions.set(partition, s);
      cleared.set(partition, calls);
    }
    return s;
  };

  try {
    const { mgr } = makeManager();
    const A = 'ws4-A-uuid';
    const B = 'ws4-B-uuid';
    const host = 'mail.req4.example';
    // A rule scoped to workspace A — its origins (https://mail.req4.example) live
    // in A's agent session partition.
    const rule = store.insertRule({
      hostname: host, scheme: 'https', includeSubdomains: false, allowSignedIn: true, workspaceId: A,
    });
    mgr.invalidateAccessCache();

    await mgr.accessClearSiteSession(rule.id);

    const aPartition = BM.agentPartitionForWorkspace(A);
    const bPartition = BM.agentPartitionForWorkspace(B);

    // A's agent partition was cleared, scoped to the rule's origin.
    const aCalls = cleared.get(aPartition) ?? [];
    assert.ok(aCalls.length >= 1, "the rule's own workspace agent partition was cleared");
    assert.ok(
      aCalls.some((c) => (c as { origin?: string }).origin === `https://${host}`),
      'the clear targeted the origin governed by the rule',
    );

    // Workspace B's agent partition is never fetched, let alone cleared.
    assert.equal(cleared.has(bPartition), false, "another workspace's agent partition is untouched");
    assert.notEqual(aPartition, bPartition, 'A and B resolve to distinct agent partitions');

    // The human partition is never a clear target either.
    assert.equal((cleared.get('persist:user') ?? []).length, 0, 'the shared human partition is untouched');

    mgr.invalidateAccessCache();
  } finally {
    electronMock.session.fromPartition = orig;
  }
});

// ── Slice-1: connection security + trusted error state ───────────────────────

/** Wire a fresh tab's real view events so we can emit did-fail-load /
 *  did-navigate / did-start-loading against it and observe lastError. */
function wireTab(mgr: MgrHarness['mgr'], url: string): FakeTab {
  const tab = injectTab(mgr, { partition: 'user', url });
  priv<void>(mgr, 'wireViewEvents')(tab);
  return tab;
}

function errOf(tab: FakeTab): { code: string; description: string; url: string } | null | undefined {
  return (tab as unknown as { lastError?: { code: string; description: string; url: string } | null }).lastError;
}

// ── Popup policy: USER tabs allow real OAuth popups; AGENT tabs stay gated ────

test('USER-tab window.open() popup is ALLOWED (OAuth opener channel preserved)', () => {
  const { mgr, sent } = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://app.example/' });
  priv<void>(mgr, 'wireViewEvents')(tab);
  const handler = tab.view.webContents.windowOpenHandler!;
  assert.ok(handler, 'setWindowOpenHandler registered');
  const res = handler({ url: 'https://accounts.google.com/o/oauth2/auth' }) as { action: string };
  assert.equal(res.action, 'allow', 'human-driven popup opens natively so window.opener survives');
  assert.equal(
    sent.filter((s) => s.channel === CH.openRequest).length, 0,
    'no "page tried to open a new window" confirmation surfaced for an allowed user popup',
  );
});

test('about:blank popup from a USER tab is allowed (open-then-navigate OAuth flows)', () => {
  const { mgr } = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://app.example/' });
  priv<void>(mgr, 'wireViewEvents')(tab);
  const res = tab.view.webContents.windowOpenHandler!({ url: 'about:blank' }) as { action: string };
  assert.equal(res.action, 'allow');
});

test('AGENT-tab popups stay DENIED and surface an open-request (no unattended OS window)', () => {
  const { mgr, sent } = makeManager();
  const tab = injectTab(mgr, { partition: 'agent', url: 'https://app.example/' });
  priv<void>(mgr, 'wireViewEvents')(tab);
  sent.length = 0;
  const res = tab.view.webContents.windowOpenHandler!({ url: 'https://accounts.google.com/' }) as { action: string };
  assert.equal(res.action, 'deny', 'automation never spawns a native popup');
  const req = sent.find((s) => s.channel === CH.openRequest);
  assert.ok(req, 'denied agent popup is surfaced to the renderer for open-as-tab');
  assert.equal((req!.payload as { url: string }).url, 'https://accounts.google.com/');
});

test('non-http(s) popup scheme from a USER tab is denied (only OAuth-shaped schemes auto-open)', () => {
  const { mgr } = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://app.example/' });
  priv<void>(mgr, 'wireViewEvents')(tab);
  const res = tab.view.webContents.windowOpenHandler!({ url: 'mailto:foo@example.com' }) as { action: string };
  assert.equal(res.action, 'deny');
});

test('secureStateForUrl reflects the scheme (https → secure, http → insecure, else internal)', () => {
  assert.equal(BM.secureStateForUrl('https://example.com/'), 'secure');
  assert.equal(BM.secureStateForUrl('http://example.com/'), 'insecure');
  assert.equal(BM.secureStateForUrl('about:blank'), 'internal');
  assert.equal(BM.secureStateForUrl(''), 'internal');
  assert.equal(BM.secureStateForUrl(undefined), 'internal');
  assert.equal(BM.secureStateForUrl('not a url'), 'internal');
});

test('did-fail-load sets lastError with ONLY code/description/url (no page content) and pushes', () => {
  const { mgr, sent } = makeManager();
  const tab = wireTab(mgr, 'https://broken.example/');
  sent.length = 0;
  tab.view.webContents.emit(
    'did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://broken.example/', true,
  );
  const err = errOf(tab);
  assert.ok(err, 'lastError set');
  assert.deepEqual(Object.keys(err!).sort(), ['code', 'description', 'url'], 'no fields beyond code/description/url');
  assert.equal(err!.code, '-105');
  assert.equal(err!.description, 'ERR_NAME_NOT_RESOLVED', 'description is the Electron error string, never page content');
  assert.equal(err!.url, 'https://broken.example/');
  const msg = sent.find((s) => s.channel === CH.tabState);
  assert.ok(msg, 'tabState pushed on failure');
  const payload = msg!.payload as { lastError?: { code: string } | null };
  assert.equal(payload.lastError?.code, '-105', 'failure surfaced to the renderer');
});

test('did-fail-load IGNORES errorCode -3 (ABORTED) and subframe failures', () => {
  const { mgr } = makeManager();
  const tab = wireTab(mgr, 'https://ok.example/');
  tab.view.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://ok.example/', true);
  assert.equal(errOf(tab) ?? null, null, 'ABORTED is not a real failure');
  tab.view.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://sub.example/x', false);
  assert.equal(errOf(tab) ?? null, null, 'subframe failure does not blank the tab');
});

test('render-process-gone sets a crash lastError (description = reason, no page content)', () => {
  const { mgr } = makeManager();
  const tab = wireTab(mgr, 'https://crash.example/');
  tab.view.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  const err = errOf(tab);
  assert.ok(err);
  assert.equal(err!.code, 'crashed');
  assert.equal(err!.description, 'crashed');
});

test('did-start-loading and a successful did-navigate CLEAR lastError', () => {
  const { mgr } = makeManager();
  const tab = wireTab(mgr, 'https://recover.example/');
  tab.view.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://recover.example/', true);
  assert.ok(errOf(tab), 'error set first');
  tab.view.webContents.emit('did-start-loading');
  assert.equal(errOf(tab) ?? null, null, 'load start clears the error (Retry path)');

  // And a committed navigation also clears it.
  tab.view.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://recover.example/', true);
  assert.ok(errOf(tab), 'error set again');
  tab.view.webContents.setURL('https://recover.example/page');
  tab.view.webContents.emit('did-navigate', {}, 'https://recover.example/page');
  assert.equal(errOf(tab) ?? null, null, 'successful navigation clears the error');
});

test('sendTabState always carries secureState (from the live URL) and lastError (null when clear)', () => {
  const { mgr, sent } = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://secure.example/' });
  sent.length = 0;
  priv<void>(mgr, 'sendTabState')(tab);
  const clean = sent.find((s) => s.channel === CH.tabState)!.payload as {
    secureState?: string; lastError?: unknown;
  };
  assert.equal(clean.secureState, 'secure', 'https → secure');
  assert.equal(clean.lastError, null, 'lastError null (not absent) so the renderer merge clears it');

  // An http tab reads as insecure.
  tab.view.webContents.setURL('http://plain.example/');
  sent.length = 0;
  priv<void>(mgr, 'sendTabState')(tab);
  const insecure = sent.find((s) => s.channel === CH.tabState)!.payload as { secureState?: string };
  assert.equal(insecure.secureState, 'insecure', 'http → insecure');
});

// ── Slice-7: bookmarks as a real manager (USER-PARTITION ONLY) ───────────────
// The two trust/behaviour proofs the plan requires: an agent-partition URL is
// never bookmarkable (cross-cutting rule #1, enforced in main even on a direct
// IPC call), and an in-place title edit preserves the row's id + sort order.

test('Slice-7: bookmarking a URL open ONLY in an agent tab is REJECTED in main', () => {
  const { mgr } = makeManager();
  const url = 'https://agent-only.slice7.example/secret';
  // The URL is live in an agent-partition tab and NO user tab. Even a direct
  // IPC call (compromised renderer) must not persist an agent-partition URL.
  injectTab(mgr, { partition: 'agent', url });
  assert.throws(
    () => mgr.bookmarkAdd({ title: 'nope', url }),
    /agent-partition URLs are never bookmarkable/,
    'agent-partition URL is refused in main',
  );
  assert.equal(
    mgr.bookmarkList().some((b) => b.url === url),
    false,
    'nothing was persisted for the agent URL',
  );
});

test('Slice-7: editing a bookmark title preserves its id and sort order', () => {
  const { mgr } = makeManager();
  // No tab carries these URLs, so bookmarkAdd persists them (no favicon) with
  // ascending sort_order in creation order.
  const first = mgr.bookmarkAdd({ title: 'First', url: 'https://first.slice7.example/' });
  const second = mgr.bookmarkAdd({ title: 'Second', url: 'https://second.slice7.example/' });

  const edited = mgr.bookmarkUpdate(first.id, { title: 'First (renamed)' });

  assert.equal(edited.id, first.id, 'id preserved across the edit');
  assert.equal(edited.sortOrder, first.sortOrder, 'sort order preserved across the edit');
  assert.equal(edited.title, 'First (renamed)', 'title updated');
  assert.equal(edited.url, first.url, 'url is never touched by a title edit');

  // The persisted ordering is unchanged: first still precedes second.
  const list = mgr.bookmarkList();
  const ids = list.map((b) => b.id);
  assert.ok(ids.indexOf(first.id) < ids.indexOf(second.id), 'first still sorts before second');
  const persisted = list.find((b) => b.id === first.id);
  assert.ok(persisted, 'the edited bookmark is still present');
  assert.equal(persisted!.title, 'First (renamed)', 'the rename persisted');
  assert.equal(persisted!.sortOrder, first.sortOrder, 'persisted sort order unchanged');
});

// ── Slice-8: history M9 persistence boundary ──────────────────────────────────

test('Slice-8: agent-partition navigations are NEVER recorded in history (M9)', () => {
  const { mgr } = makeManager();
  // Wire the real nav handlers on a user tab and an agent tab, then drive each
  // to an otherwise-allowable https URL. Only the USER visit may reach history —
  // the agent URL must never be persisted (cross-cutting rule #1).
  const userTab = injectTab(mgr, { partition: 'user', url: 'https://slice8-user.example/page', title: 'User Page' });
  priv<void>(mgr, 'wireViewEvents')(userTab);
  const agentTab = injectTab(mgr, { partition: 'agent', url: 'https://slice8-agent.example/secret', title: 'Agent Secret' });
  priv<void>(mgr, 'wireViewEvents')(agentTab);

  userTab.view.webContents.emit('did-navigate', {}, 'https://slice8-user.example/page');
  agentTab.view.webContents.emit('did-navigate', {}, 'https://slice8-agent.example/secret');

  const urls = mgr.historyList().map((e) => e.url);
  assert.ok(urls.includes('https://slice8-user.example/page'), 'user-partition visit recorded');
  assert.ok(!urls.some((u) => u.includes('slice8-agent.example')), 'agent-partition visit must never appear');
});

// ── Slice 10/11: frozen/discarded tab model + session restore ────────────────
// Trust/behaviour proofs the plan requires (main side):
//   - discardTab keeps a frozen snapshot in place and EXEMPTS the active tab,
//     pinned tabs, and agent / signin / handed tabs;
//   - the `destroyed` handler skips order/active teardown for a deliberate discard;
//   - the idle sweep discards an idle USER tab (and spares a recently-active one);
//   - restoreSession rebuilds USER tabs LAZILY (frozen, no live view) and is
//     idempotent (the latch returns [] on a second pull);
//   - persistSession never writes agent / signin / handed tabs (cross-cutting #1);
//   - a USER close lands on the PERSISTENT reopen stack and reopenClosedTab pops it.

type SessionStoreModule = typeof import('./session-store');
function sessionStore(): SessionStoreModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./session-store') as SessionStoreModule;
}

interface BMInternals {
  tabs: Map<string, unknown>;
  frozenTabs: Map<string, { id: string; origin: string; pinned: boolean }>;
  tabOrder: string[];
  pinnedTabs: Set<string>;
  lastActiveAt: Map<string, number>;
  discardingTabs: Set<string>;
  activeTabId: string | null;
}
function internals(mgr: MgrHarness['mgr']): BMInternals {
  return mgr as unknown as BMInternals;
}

test('Slice-11: discardTab keeps a frozen snapshot in place (tab leaves tabs, stays in order) and pushes discarded state', () => {
  const { mgr, sent } = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://discard.example/page', title: 'Page' });
  priv<void>(mgr, 'wireViewEvents')(tab);
  const ix = internals(mgr);
  sent.length = 0;

  mgr.discardTab(tab.id);

  assert.equal(ix.tabs.has(tab.id), false, 'live view removed from tabs');
  assert.ok(ix.frozenTabs.has(tab.id), 'a frozen snapshot replaced it');
  assert.equal(ix.frozenTabs.get(tab.id)!.origin, 'discarded', 'origin marks the memory sweep');
  assert.ok(ix.tabOrder.includes(tab.id), 'id stays in tabOrder (renders inline)');
  const msg = sent.find((s) => s.channel === CH.tabState);
  const payload = msg!.payload as { frozen?: boolean; discarded?: boolean };
  assert.equal(payload.frozen, true, 'renderer told the tab is frozen');
  assert.equal(payload.discarded, true, 'and that it was memory-discarded');

  // The destroyed handler must NOT forget a deliberately-discarded tab's order.
  tab.view.webContents.emit('destroyed');
  assert.ok(ix.tabOrder.includes(tab.id), 'destroyed handler skipped forgetTabOrder for a discard');
  assert.ok(ix.frozenTabs.has(tab.id), 'frozen snapshot survived the destroyed event');
  assert.equal(ix.discardingTabs.has(tab.id), false, 'discard latch cleared');
});

test('Slice-11: discardTab guards the active tab and refuses agent / signin / handed tabs', () => {
  const { mgr } = makeManager();
  const ix = internals(mgr);

  // Active tab — never discarded (discardTab's hard guard).
  const active = injectTab(mgr, { partition: 'user', url: 'https://active.example/', workspaceId: null });
  ix.activeTabId = active.id;
  mgr.discardTab(active.id);
  assert.ok(ix.tabs.has(active.id), 'the active tab is never discarded');
  ix.activeTabId = null;

  // Agent / signin / handed tabs — never frozen (cross-cutting rule #1).
  const agent = injectTab(mgr, { partition: 'agent', url: 'https://agent.example/', workspaceId: null });
  const signin = injectTab(mgr, { partition: 'user', url: 'https://signin.example/', signinPending: true, workspaceId: null });
  const handed = injectTab(mgr, { partition: 'user', url: 'https://handed.example/', handedToAgent: true, workspaceId: null });
  for (const t of [agent, signin, handed]) {
    mgr.discardTab(t.id);
    assert.ok(ix.tabs.has(t.id), `${t.id} is exempt from discard`);
    assert.equal(ix.frozenTabs.has(t.id), false, `${t.id} was never frozen`);
  }
});

test('Slice-11: the sweep EXEMPTS pinned / agent / signin / handed tabs even when idle', async () => {
  const { mgr } = makeManager();
  const ix = internals(mgr);
  const old = Date.now() - 60 * 60_000; // an hour idle — well past the threshold
  const pinned = injectTab(mgr, { partition: 'user', url: 'https://pinned.example/', workspaceId: null });
  ix.pinnedTabs.add(pinned.id);
  const agent = injectTab(mgr, { partition: 'agent', url: 'https://agent2.example/', workspaceId: null });
  const signin = injectTab(mgr, { partition: 'user', url: 'https://signin2.example/', signinPending: true, workspaceId: null });
  const handed = injectTab(mgr, { partition: 'user', url: 'https://handed2.example/', handedToAgent: true, workspaceId: null });
  for (const t of [pinned, agent, signin, handed]) {
    priv<void>(mgr, 'wireViewEvents')(t);
    ix.lastActiveAt.set(t.id, old);
  }

  await priv<Promise<void>>(mgr, 'runDiscardSweep')();

  for (const t of [pinned, agent, signin, handed]) {
    assert.ok(ix.tabs.has(t.id), `${t.id} survives the idle sweep`);
    assert.equal(ix.frozenTabs.has(t.id), false, `${t.id} was never frozen`);
  }
});

test('Slice-11: the idle sweep discards an idle USER tab and spares a recently-active one', async () => {
  const { mgr } = makeManager();
  const ix = internals(mgr);
  const idle = injectTab(mgr, { partition: 'user', url: 'https://idle.example/' });
  const fresh = injectTab(mgr, { partition: 'user', url: 'https://fresh.example/' });
  priv<void>(mgr, 'wireViewEvents')(idle);
  priv<void>(mgr, 'wireViewEvents')(fresh);
  const now = Date.now();
  ix.lastActiveAt.set(idle.id, now - 31 * 60_000); // past the 30-min default
  ix.lastActiveAt.set(fresh.id, now); // just used

  await priv<Promise<void>>(mgr, 'runDiscardSweep')();

  assert.ok(ix.frozenTabs.has(idle.id), 'the idle tab was discarded');
  assert.equal(ix.tabs.has(idle.id), false, 'its live view is gone');
  assert.ok(ix.tabs.has(fresh.id), 'the recently-active tab is spared');
  assert.equal(ix.frozenTabs.has(fresh.id), false, 'and was not frozen');
});

test('Slice-11: setDiscardThreshold(null) = Never disables idle discard (cap still applies)', async () => {
  const { mgr } = makeManager();
  const ix = internals(mgr);
  mgr.setDiscardThreshold(null);
  const tab = injectTab(mgr, { partition: 'user', url: 'https://never.example/' });
  priv<void>(mgr, 'wireViewEvents')(tab);
  ix.lastActiveAt.set(tab.id, Date.now() - 5 * 60 * 60_000); // 5h idle

  await priv<Promise<void>>(mgr, 'runDiscardSweep')();

  assert.ok(ix.tabs.has(tab.id), 'Never threshold means no idle discard');
  assert.equal(ix.frozenTabs.has(tab.id), false, 'tab stayed live');
  mgr.setDiscardThreshold(30 * 60_000); // restore the default for later tests
});

test('Slice-10: restoreSession rebuilds USER tabs LAZILY (frozen, no live view) and is idempotent', () => {
  const { mgr } = makeManager();
  const ss = sessionStore();
  ss.clearSession();
  ss.replaceSession([
    { tabId: 'r1', workspaceId: null, url: 'https://r1.example/', title: 'R1', pinned: false, sortOrder: 0, groupId: null, active: false },
    { tabId: 'r2', workspaceId: null, url: 'https://r2.example/', title: 'R2', pinned: true, sortOrder: 1, groupId: null, active: false, scrollY: 240 },
  ]);
  const ix = internals(mgr);

  const states = mgr.restoreSession();

  assert.equal(states.length, 2, 'both persisted tabs were restored');
  assert.ok(states.every((s) => s.frozen === true), 'restored tabs are frozen');
  assert.equal(ix.frozenTabs.size, 2, 'frozen snapshots created');
  assert.equal(ix.tabs.size, 0, 'NO live WebContentsView yet (lazy)');
  assert.ok(ix.tabOrder.includes('r1') && ix.tabOrder.includes('r2'), 'ids joined the order');
  assert.ok(ix.pinnedTabs.has('r2'), 'a pinned row restored pinned');

  assert.deepEqual(mgr.restoreSession(), [], 'idempotent — a second pull restores nothing');
  ss.clearSession();
});

test('Slice-10: persistSession writes USER tabs only — agent / signin / handed never reach SQLite', () => {
  const { mgr } = makeManager();
  const ss = sessionStore();
  ss.clearSession();
  const user = injectTab(mgr, { partition: 'user', url: 'https://persist-user.example/', title: 'U', workspaceId: null });
  priv<void>(mgr, 'wireViewEvents')(user);
  injectTab(mgr, { partition: 'agent', url: 'https://persist-agent.example/secret', workspaceId: null });
  injectTab(mgr, { partition: 'user', url: 'https://persist-signin.example/', signinPending: true, workspaceId: null });
  injectTab(mgr, { partition: 'user', url: 'https://persist-handed.example/', handedToAgent: true, workspaceId: null });

  priv<void>(mgr, 'persistSession')();

  const urls = ss.loadSession().map((r) => r.url);
  assert.deepEqual(urls, ['https://persist-user.example/'], 'only the plain user tab persisted');
  assert.ok(!urls.some((u) => u.includes('agent') || u.includes('signin') || u.includes('handed')),
    'agent / signin / handed URLs never reach disk');
  ss.clearSession();
});

test('Slice-10: a USER close lands on the PERSISTENT reopen stack and reopenClosedTab pops it (survives restart)', () => {
  const { mgr } = makeManager();
  const ss = sessionStore();
  ss.clearSession();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://reopen.example/page', title: 'Reopen', workspaceId: null });
  priv<void>(mgr, 'wireViewEvents')(tab);

  mgr.closeTab(tab.id);
  assert.notEqual(ss.peekNewestClosedAt(null), null, 'the user close persisted to the SQLite reopen stack');

  // Reopen consults the persistent stack. Stub createTab so no real view is built.
  const calls: Array<{ partition: string; url: string }> = [];
  (mgr as unknown as { createTab(opts: { partition: string; url: string }): { tabId: string } }).createTab = (opts) => {
    calls.push(opts);
    return { tabId: 'reopened' };
  };

  const result = mgr.reopenClosedTab();

  assert.deepEqual(result, { tabId: 'reopened' }, 'reopenClosedTab returned the new tab id');
  assert.equal(calls.length, 1, 'createTab was invoked once from the persistent stack');
  assert.equal(calls[0].partition, 'user', 'reopened as a user tab');
  assert.equal(calls[0].url, 'https://reopen.example/page', 'with the persisted URL');
  assert.equal(ss.peekNewestClosedAt(null), null, 'popClosedTab emptied the stack');
  ss.clearSession();
});

// ── Close-active repaint: closing the ACTIVE tab must re-select a replacement ──
// (or clear the pane) so the destroyed WebContentsView's last frame never lingers
// as a "dead tab". Also guards the in-mem agent LIFO reopen push + tab removal.

interface ClosedStackEntry { url: string; partition: 'agent' | 'user'; title: string; }
function agentReopenStack(mgr: MgrHarness['mgr']): ClosedStackEntry[] {
  return (mgr as unknown as { closedTabStack: ClosedStackEntry[] }).closedTabStack;
}

test('closing the ACTIVE agent tab re-selects the right neighbour, removes the tab, and pushes the in-mem LIFO reopen entry', () => {
  const { mgr } = makeManager();
  const ix = internals(mgr);
  const a = injectTab(mgr, { partition: 'agent', url: 'https://a.example/', title: 'A', workspaceId: null });
  const b = injectTab(mgr, { partition: 'agent', url: 'https://b.example/', title: 'B', workspaceId: null });
  const c = injectTab(mgr, { partition: 'agent', url: 'https://c.example/', title: 'C', workspaceId: null });
  ix.activeTabId = b.id; // the middle tab is active

  mgr.closeTab(b.id);

  // Tab + order teardown.
  assert.equal(ix.tabs.has(b.id), false, 'closed tab removed from the live tab map');
  assert.equal(ix.tabOrder.includes(b.id), false, 'closed tab removed from the order');
  assert.equal(ix.frozenTabs.has(b.id), false, 'a real close never leaves a frozen snapshot');
  // Active re-selection: the right neighbour (c) shifts into the freed slot.
  assert.equal(ix.activeTabId, c.id, 'active re-selected the right neighbour — pane repaints, no dead tab');
  // Agent close → in-mem LIFO reopen stack (partition preserved, never disk).
  const stack = agentReopenStack(mgr);
  assert.equal(stack.length, 1, 'one in-mem reopen entry pushed');
  assert.equal(stack[stack.length - 1].url, 'https://b.example/', 'with the closed agent URL');
  assert.equal(stack[stack.length - 1].partition, 'agent', 'partition preserved so it reopens as agent');
  // Sibling tabs untouched.
  assert.ok(ix.tabs.has(a.id) && ix.tabs.has(c.id), 'sibling tabs survive the close');
});

test('closing the ACTIVE rightmost tab falls back to the left neighbour; closing the last tab clears the pane', () => {
  const { mgr } = makeManager();
  const ix = internals(mgr);
  const a = injectTab(mgr, { partition: 'agent', url: 'https://a.example/', title: 'A', workspaceId: null });
  const b = injectTab(mgr, { partition: 'agent', url: 'https://b.example/', title: 'B', workspaceId: null });
  ix.activeTabId = b.id; // rightmost is active

  mgr.closeTab(b.id);
  assert.equal(ix.activeTabId, a.id, 'rightmost close falls back to the left neighbour');

  mgr.closeTab(a.id);
  assert.equal(ix.activeTabId, null, 'closing the last tab clears the active id (pane cleared)');
  assert.equal(ix.tabs.size, 0, 'no live tabs remain');
});

test('closing a NON-active tab leaves the active id untouched', () => {
  const { mgr } = makeManager();
  const ix = internals(mgr);
  const a = injectTab(mgr, { partition: 'agent', url: 'https://a.example/', title: 'A', workspaceId: null });
  const b = injectTab(mgr, { partition: 'agent', url: 'https://b.example/', title: 'B', workspaceId: null });
  ix.activeTabId = a.id; // active is NOT the tab being closed

  mgr.closeTab(b.id);
  assert.equal(ix.activeTabId, a.id, 'active id unchanged when a background tab is closed');
  assert.equal(ix.tabs.has(b.id), false, 'the background tab is still removed');
});

// ── Slice 13: user-only downloads — decision gate + will-download handler ─────
// Exercises the security-critical seam: the agent allowlist gate (allow/deny +
// NO record on deny), the M12 sensitive-origin denial even for an allowlisted
// origin, and the user confirm flow (prompt → confirm → one-shot allow). The
// pure filename/path chokepoint is covered separately in downloads.test.ts.

interface FakeDownloadItem {
  getURL(): string; getFilename(): string;
  getTotalBytes(): number; getReceivedBytes(): number;
  setSavePath(p: string): void; readonly savePath: string | null;
  cancel(): void; readonly cancelled: boolean;
  on(ev: string, fn: (...a: unknown[]) => void): void;
  once(ev: string, fn: (...a: unknown[]) => void): void;
}
function fakeDownloadItem(url: string, filename: string): FakeDownloadItem {
  let savePath: string | null = null;
  let cancelled = false;
  return {
    getURL: () => url,
    getFilename: () => filename,
    getTotalBytes: () => 1234,
    getReceivedBytes: () => 0,
    setSavePath(p) { savePath = p; },
    get savePath() { return savePath; },
    cancel() { cancelled = true; },
    get cancelled() { return cancelled; },
    on() {},
    once() {},
  };
}
interface CapturedAudit { partition: string; url: string; verb: string; outcome: string; }
/** Swap the stub audit writer for a capturing one; returns the records array. */
function captureAudit(mgr: MgrHarness['mgr']): CapturedAudit[] {
  const records: CapturedAudit[] = [];
  (mgr as unknown as { auditWriter: { record(e: CapturedAudit): void } }).auditWriter = {
    record: (e) => records.push(e),
  };
  return records;
}
const fakeDlEvent = (): { preventDefault(): void; prevented: boolean } => {
  let prevented = false;
  return { preventDefault() { prevented = true; }, get prevented() { return prevented; } };
};

test('Slice-13 gate: agent download from an ALLOWLISTED origin → allow', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'files.example', includeSubdomains: true })]);
  const d = priv<{ action: string; code?: string }>(mgr, 'decideDownload')('agent', 'https://files.example/a.zip', null);
  assert.equal(d.action, 'allow');
});

test('Slice-13 gate: agent download from a NON-allowlisted origin → deny (agent-allowlist-denied)', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'files.example', includeSubdomains: true })]);
  const d = priv<{ action: string; code?: string }>(mgr, 'decideDownload')('agent', 'https://evil.example/x.zip', null);
  assert.equal(d.action, 'deny');
  assert.equal(d.code, 'agent-allowlist-denied');
});

test('Slice-13 gate: M12 — agent download from a SENSITIVE origin denied even if allowlisted', () => {
  const { mgr } = makeManager();
  setCache(mgr, [compiled({ hostname: 'accounts.google.com', includeSubdomains: true })]);
  const d = priv<{ action: string; code?: string }>(mgr, 'decideDownload')('agent', 'https://accounts.google.com/export', null);
  assert.equal(d.action, 'deny');
  assert.equal(d.code, 'sensitive-origin-denied');
});

test('Slice-13 gate: a USER download is never auto-allowed → confirm', () => {
  const { mgr } = makeManager();
  setCache(mgr, []);
  const d = priv<{ action: string }>(mgr, 'decideDownload')('user', 'https://anything.example/a.pdf', null);
  assert.equal(d.action, 'confirm');
});

test('Slice-13: an allowlisted agent download is confined, recorded, audited, emits downloadStarted', () => {
  const { mgr, sent } = makeManager();
  const records = captureAudit(mgr);
  setCache(mgr, [compiled({ hostname: 'files.example', includeSubdomains: true })]);
  const tab = injectTab(mgr, { partition: 'agent', url: 'https://files.example/', workspaceId: null });
  const item = fakeDownloadItem('https://files.example/report.zip', 'report.zip');
  const event = fakeDlEvent();
  priv<void>(mgr, 'handleWillDownload')(event, item, tab.view.webContents);

  assert.equal(event.prevented, false, 'an allowed download is NOT prevented');
  assert.ok(item.savePath && item.savePath.endsWith('report.zip'), 'save path set inside the app dir');
  assert.equal(sent.filter((s) => s.channel === CH.downloadStarted).length, 1, 'downloadStarted emitted once');
  assert.ok(records.some((r) => r.outcome === 'ok:download'), 'the accept is audited');
  assert.ok(mgr.listDownloads().some((r) => r.url === 'https://files.example/report.zip'), 'a db record was inserted');
});

test('Slice-13: a denied agent download is prevented + audited and creates NO db record', () => {
  const { mgr, sent } = makeManager();
  const records = captureAudit(mgr);
  setCache(mgr, [compiled({ hostname: 'files.example', includeSubdomains: true })]);
  const tab = injectTab(mgr, { partition: 'agent', url: 'https://files.example/', workspaceId: null });
  const item = fakeDownloadItem('https://evil.example/malware.exe', 'malware.exe');
  const event = fakeDlEvent();
  priv<void>(mgr, 'handleWillDownload')(event, item, tab.view.webContents);

  assert.equal(event.prevented, true, 'the denied download is prevented');
  assert.equal(item.savePath, null, 'no save path on deny');
  assert.equal(sent.filter((s) => s.channel === CH.downloadStarted).length, 0, 'no downloadStarted on deny');
  assert.ok(records.some((r) => r.outcome === 'denied:agent-allowlist-denied'), 'the deny is audited');
  assert.ok(!mgr.listDownloads().some((r) => r.url.includes('evil.example')), 'NO db record on deny');
});

test('Slice-13: a USER download is prevented + prompts (normalized filename) and writes nothing pre-confirm', () => {
  const { mgr, sent } = makeManager();
  captureAudit(mgr);
  setCache(mgr, []);
  const tab = injectTab(mgr, { partition: 'user', url: 'https://site.example/', workspaceId: null });
  // A traversal-y suggested name must be normalized in the prompt the human sees.
  const item = fakeDownloadItem('https://site.example/get?f=1', '../../etc/passwd');
  const event = fakeDlEvent();
  priv<void>(mgr, 'handleWillDownload')(event, item, tab.view.webContents);

  assert.equal(event.prevented, true, 'the user download is cancelled pending confirmation');
  assert.equal(item.savePath, null, 'nothing written before confirm');
  const prompts = sent.filter((s) => s.channel === CH.downloadPrompt);
  assert.equal(prompts.length, 1, 'exactly one downloadPrompt');
  const prompt = prompts[0].payload as { id: string; filename: string; url: string };
  assert.equal(prompt.filename, 'passwd', 'the prompt filename is normalized (no traversal)');
  assert.ok(prompt.id, 'the prompt carries a confirm token');
  assert.equal(sent.filter((s) => s.channel === CH.downloadStarted).length, 0, 'no write surfaced as started');
});

test('Slice-13: confirmDownload re-initiates and the one-shot approval allows the re-fired download', () => {
  const { mgr, sent } = makeManager();
  captureAudit(mgr);
  setCache(mgr, []);
  const tab = injectTab(mgr, { partition: 'user', url: 'https://docs.example/', workspaceId: null });
  const item = fakeDownloadItem('https://docs.example/file.pdf', 'file.pdf');
  priv<void>(mgr, 'handleWillDownload')(fakeDlEvent(), item, tab.view.webContents);
  const prompt = sent.find((s) => s.channel === CH.downloadPrompt)?.payload as { id: string };
  assert.ok(prompt?.id, 'a confirm token was issued');

  mgr.confirmDownload(prompt.id);
  const approved = (mgr as unknown as { approvedDownloadUrls: Map<string, unknown> }).approvedDownloadUrls;
  assert.ok(approved.has('https://docs.example/file.pdf'), 'the url is approved for the re-fired download');

  // The re-fired will-download (no owning tab — fired by session.downloadURL) is
  // allowed through purely on the one-shot approval.
  const item2 = fakeDownloadItem('https://docs.example/file.pdf', 'file.pdf');
  const event2 = fakeDlEvent();
  priv<void>(mgr, 'handleWillDownload')(event2, item2, undefined);

  assert.equal(event2.prevented, false, 'the approved re-download is NOT prevented');
  assert.ok(item2.savePath && item2.savePath.endsWith('file.pdf'), 'the confirmed file is written');
  assert.equal(approved.has('https://docs.example/file.pdf'), false, 'the approval is one-shot (consumed)');
  assert.equal(sent.filter((s) => s.channel === CH.downloadStarted).length, 1, 'downloadStarted only after confirm');
});

test('Slice-13: a download from an UNKNOWN source (no owning tab) is denied with no record', () => {
  const { mgr, sent } = makeManager();
  const records = captureAudit(mgr);
  setCache(mgr, []);
  const item = fakeDownloadItem('https://orphan.example/x.bin', 'x.bin');
  const event = fakeDlEvent();
  priv<void>(mgr, 'handleWillDownload')(event, item, undefined);

  assert.equal(event.prevented, true, 'an orphan download is prevented');
  assert.ok(records.some((r) => r.outcome === 'denied:unknown-source'), 'audited as unknown-source');
  assert.ok(!mgr.listDownloads().some((r) => r.url.includes('orphan.example')), 'no record for an orphan download');
});

// ── Signed-in tabs WI-2(c): looksLikeLoginWall (pure heuristic) ──────────────

test('WI-2(c) looksLikeLoginWall: same-origin login PATHS match; ordinary pages do not', () => {
  const rule = { hostname: 'site.example' };
  for (const p of ['/login', '/signin', '/sign-in', '/sso', '/auth', '/oauth', '/sso/start', '/auth/callback']) {
    assert.equal(BM.looksLikeLoginWall(`https://site.example${p}`, rule), true, `${p} is a login wall`);
  }
  for (const p of ['/feed', '/authors/jane', '/loginhelp', '/search?q=login', '/']) {
    assert.equal(BM.looksLikeLoginWall(`https://site.example${p}`, rule), false, `${p} is NOT a login wall (no false positive)`);
  }
});

test('WI-2(c) looksLikeLoginWall: a CROSS-ORIGIN redirect to a known auth host matches', () => {
  const rule = { hostname: 'site.example' };
  assert.equal(BM.looksLikeLoginWall('https://accounts.google.com/o/oauth2/v2/auth', rule), true);
  assert.equal(BM.looksLikeLoginWall('https://login.microsoftonline.com/common/oauth2', rule), true);
  assert.equal(BM.looksLikeLoginWall('https://corp.okta.com/app/x', rule), true);
  assert.equal(BM.looksLikeLoginWall('https://idp.example.org/saml', rule), true);
  // A normal cross-origin page (not an auth host) is NOT a wall.
  assert.equal(BM.looksLikeLoginWall('https://cdn.othersite.com/asset.js', rule), false);
});

test('WI-2(c) looksLikeLoginWall: per-rule login_url_patterns (glob + substring) extend the defaults', () => {
  const rule = { hostname: 'board.example', loginUrlPatterns: ['*/candidate/*', 'auth-gate'] };
  assert.equal(BM.looksLikeLoginWall('https://board.example/candidate/portal', rule), true, 'glob honored');
  assert.equal(BM.looksLikeLoginWall('https://board.example/x/auth-gate', rule), true, 'substring honored');
  assert.equal(BM.looksLikeLoginWall('https://board.example/jobs/123', rule), false, 'a normal page still passes');
  // Non-http(s) is never a wall.
  assert.equal(BM.looksLikeLoginWall('about:blank', rule), false);
  assert.equal(BM.looksLikeLoginWall('not a url', rule), false);
});

// ── Signed-in tabs WI-2(b): classifyOriginState transitions (DB-backed) ──────

test('WI-2(b) classifyOriginState: a non-credentialed origin is always ready (unchanged path)', () => {
  const { mgr } = makeManager();
  mgr.invalidateAccessCache();
  // No allow_signed_in rule → not our concern; the ordinary allow/deny path owns it.
  assert.equal(mgr.classifyOriginState(null, 'https://uncredentialed.example/page'), 'ready');
});

test('WI-2(b) classifyOriginState: allow_signed_in origin with NO session row → needs_signin', () => {
  const { mgr } = makeManager();
  store.insertRule({ hostname: 'cls-norow.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null });
  mgr.invalidateAccessCache();
  assert.equal(mgr.classifyOriginState(null, 'https://cls-norow.example/feed'), 'needs_signin', 'cold path: first-ever nav pends');
});

test('WI-2(b) classifyOriginState: active session on a normal page → ready', () => {
  const { mgr } = makeManager();
  const rule = store.insertRule({ hostname: 'cls-active.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null });
  mgr.invalidateAccessCache();
  store.upsertSignedInOrigin(rule.id, 'https://cls-active.example', null, { signedInAt: Date.now(), verifiedAt: Date.now() });
  assert.equal(mgr.classifyOriginState(null, 'https://cls-active.example/feed'), 'ready', 'a live session drives normally');
});

test('WI-2(b) classifyOriginState: active session that COMMITS to a same-origin login wall → flips expired → needs_signin', () => {
  const { mgr } = makeManager();
  const rule = store.insertRule({ hostname: 'cls-expire.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null });
  mgr.invalidateAccessCache();
  const origin = 'https://cls-expire.example';
  store.upsertSignedInOrigin(rule.id, origin, null, { signedInAt: Date.now(), verifiedAt: Date.now() });
  assert.equal(store.getSignedInOriginState(rule.id, origin), 'active', 'starts active');
  // committedUrl looks like a login wall → expiry detected.
  assert.equal(mgr.classifyOriginState(null, origin, 'https://cls-expire.example/login'), 'needs_signin');
  assert.equal(store.getSignedInOriginState(rule.id, origin), 'expired', 'the row was flipped expired (durable consent preserved)');
  // A subsequent classify (no committed url) still pends — the row is expired.
  assert.equal(mgr.classifyOriginState(null, origin), 'needs_signin', 'expired row re-enters the sign-in flow');
});

test('WI-2(b) classifyOriginState: active session whose nav redirects CROSS-ORIGIN to an auth host → expired (the bug-fix case)', () => {
  const { mgr } = makeManager();
  const rule = store.insertRule({ hostname: 'cls-xorigin.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null });
  mgr.invalidateAccessCache();
  const origin = 'https://cls-xorigin.example';
  store.upsertSignedInOrigin(rule.id, origin, null, { signedInAt: Date.now(), verifiedAt: Date.now() });
  // The committed URL is a DIFFERENT origin (accounts.google.com) — the rule must
  // still be resolved from the credentialed origin so the expiry is detected.
  assert.equal(mgr.classifyOriginState(null, origin, 'https://accounts.google.com/o/oauth2/v2/auth'), 'needs_signin');
  assert.equal(store.getSignedInOriginState(rule.id, origin), 'expired', 'cross-origin auth-host redirect detected as expiry');
});

// ── Proactive-signin (2026-06-29): getSharedSessions is allowlist-driven ──────
// Every enabled allow_signed_in rule appears with a state (signed_in / expired /
// never), not only origins that already have a session row. The shared sql.js DB
// persists across tests, so each assertion FILTERS by its own rule id rather than
// assuming a row count.

test('getSharedSessions: an enabled allow_signed_in rule with NO session row appears as state "never"', () => {
  const { mgr } = makeManager();
  const rule = store.insertRule({ hostname: 'never.proactive.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null });
  mgr.invalidateAccessCache();
  const entry = mgr.getSharedSessions().signedInOrigins.find((o) => o.ruleId === rule.id);
  assert.ok(entry, 'the allowlisted-but-never-signed-in rule is surfaced');
  assert.equal(entry!.state, 'never');
  assert.equal(entry!.hostname, 'never.proactive.example', 'carries hostname for the handoff flow');
  assert.equal(entry!.signedInAt ?? null, null, 'no sign-in age for a never entry');
});

test('getSharedSessions: an active session row appears as state "signed_in"', () => {
  const { mgr } = makeManager();
  const rule = store.insertRule({ hostname: 'active.proactive.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null });
  mgr.invalidateAccessCache();
  store.upsertSignedInOrigin(rule.id, 'https://active.proactive.example', null, { signedInAt: Date.now(), verifiedAt: Date.now() });
  const entry = mgr.getSharedSessions().signedInOrigins.find((o) => o.ruleId === rule.id);
  assert.ok(entry, 'the signed-in origin is surfaced');
  assert.equal(entry!.state, 'signed_in');
  // No synthetic "never" duplicate for a rule that already has a row.
  assert.equal(
    mgr.getSharedSessions().signedInOrigins.filter((o) => o.ruleId === rule.id).length,
    1,
    'exactly one entry — the row, not a never duplicate',
  );
});

test('getSharedSessions: an expired session row appears as state "expired"', () => {
  const { mgr } = makeManager();
  const rule = store.insertRule({ hostname: 'expired.proactive.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null });
  mgr.invalidateAccessCache();
  const origin = 'https://expired.proactive.example';
  store.upsertSignedInOrigin(rule.id, origin, null, { signedInAt: Date.now(), verifiedAt: Date.now() });
  store.expireSignedInOrigin(rule.id, origin, Date.now());
  const entry = mgr.getSharedSessions().signedInOrigins.find((o) => o.ruleId === rule.id);
  assert.ok(entry, 'the expired origin is surfaced');
  assert.equal(entry!.state, 'expired');
});

test('getSharedSessions: a rule WITHOUT allow_signed_in never appears; handedTabs are untouched', () => {
  const { mgr } = makeManager();
  const plain = store.insertRule({ hostname: 'plainvisit.proactive.example', scheme: 'https', includeSubdomains: true, allowSignedIn: false, workspaceId: null });
  mgr.invalidateAccessCache();
  const snap = mgr.getSharedSessions();
  assert.equal(snap.signedInOrigins.some((o) => o.ruleId === plain.id), false, 'a visit-only rule is not a shared session');
  assert.deepEqual(snap.handedTabs, [], 'no handed tabs were fabricated');
});

// ── WI-E (Import my session): copy persist:user cookies → agent partition ─────
// importUserSessionForRule unions the origin + domain cookie queries, de-dups by
// (name, domain, path), replays each into the rule's WORKSPACE agent partition,
// and upserts the origin row only when at least one cookie copied. The pure
// cookie→set mapping helper is unit-tested separately (no live session needed).

test('WI-E importUserSessionForRule: unions + de-dups persist:user cookies, copies into the workspace agent partition, upserts on imported>0', async () => {
  // Both the url-scoped and domain-scoped queries return the SAME two cookies, so
  // the (name,domain,path) de-dup must collapse 4 raw hits → 2 unique copies.
  const userCookies = [
    { name: 'sid', value: 'abc', domain: 'imp.example', path: '/', secure: true, httpOnly: true, hostOnly: true, session: false, expirationDate: 9999999999, sameSite: 'no_restriction' },
    { name: 'pref', value: 'x', domain: '.imp.example', path: '/', secure: true, httpOnly: false, hostOnly: false, session: true, sameSite: 'lax' },
  ];
  const setInto = new Map<string, unknown[]>();
  const orig = electronMock.session.fromPartition;
  electronMock.session.fromPartition = (partition = '') => {
    const base = fakeSession() as Record<string, unknown>;
    if (partition === 'persist:user') {
      base.cookies = { get: async () => userCookies.slice(), set: async () => {} };
    } else {
      const calls = setInto.get(partition) ?? [];
      setInto.set(partition, calls);
      base.cookies = { get: async () => [], set: async (d: unknown) => { calls.push(d); } };
    }
    return base;
  };
  try {
    const { mgr, sent } = makeManager();
    const rule = store.insertRule({ hostname: 'imp.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: 'ws-imp' });
    mgr.invalidateAccessCache();
    const before = sent.length;
    const result = await mgr.importUserSessionForRule(rule.id);

    assert.equal(result.imported, 2, '4 raw hits de-duped to 2 unique cookies');
    assert.equal(result.origin, 'https://imp.example');
    const agentPartition = BM.agentPartitionForWorkspace('ws-imp');
    assert.equal((setInto.get(agentPartition) ?? []).length, 2, 'both cookies replayed into the RULE workspace agent partition');
    assert.equal(setInto.has('persist:user'), false, 'never writes back into the human partition');
    assert.equal(store.getSignedInOriginState(rule.id, 'https://imp.example'), 'active', 'origin row upserted active on imported>0');
    assert.ok(sent.slice(before).some((m) => m.channel === CH.accessChanged), 'accessChanged emitted so the session center refreshes');
  } finally {
    electronMock.session.fromPartition = orig;
  }
});

test('WI-E importUserSessionForRule: no saved login → imported 0, NO upsert, NO accessChanged (degrades to Sign-in fallback)', async () => {
  const orig = electronMock.session.fromPartition;
  electronMock.session.fromPartition = (_partition = '') => {
    const base = fakeSession() as Record<string, unknown>;
    base.cookies = { get: async () => [], set: async () => {} };
    return base;
  };
  try {
    const { mgr, sent } = makeManager();
    const rule = store.insertRule({ hostname: 'noimp.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null });
    mgr.invalidateAccessCache();
    const before = sent.length;
    const result = await mgr.importUserSessionForRule(rule.id);
    assert.equal(result.imported, 0);
    assert.equal(store.getSignedInOriginState(rule.id, 'https://noimp.example'), undefined, 'no row upserted when nothing copied');
    assert.equal(sent.slice(before).some((m) => m.channel === CH.accessChanged), false, 'no accessChanged when imported===0');
  } finally {
    electronMock.session.fromPartition = orig;
  }
});

test('WI-E importUserSessionForRule: refuses a rule that is not allow_signed_in (mirrors accessHandoffSignin)', async () => {
  const { mgr } = makeManager();
  const rule = store.insertRule({ hostname: 'visitonly.imp.example', scheme: 'https', includeSubdomains: true, allowSignedIn: false, workspaceId: null });
  mgr.invalidateAccessCache();
  await assert.rejects(() => mgr.importUserSessionForRule(rule.id), /not allow_signed_in/);
  await assert.rejects(() => mgr.importUserSessionForRule('no-such-rule'), /unknown rule/);
});

test('WI-E cookieToSetDetails: host-only vs leading-dot domain url + domain + expiry reconstruction', () => {
  // Host-only secure cookie → https url on the bare host, NO domain field, expiry kept.
  const hostOnly = BM.cookieToSetDetails(
    { name: 'sid', value: 'a', domain: 'h.example', path: '/app', secure: true, httpOnly: true, hostOnly: true, session: false, expirationDate: 123, sameSite: 'no_restriction' } as never,
    'h.example',
  );
  assert.equal(hostOnly.url, 'https://h.example/app');
  assert.equal(hostOnly.domain, undefined, 'host-only cookie carries no domain (else Electron promotes it to a domain cookie)');
  assert.equal(hostOnly.expirationDate, 123);

  // Leading-dot domain cookie, insecure + session → http url on the apex host,
  // keeps its dotted domain, no expirationDate.
  const domainCookie = BM.cookieToSetDetails(
    { name: 'pref', value: 'b', domain: '.h.example', path: '/', secure: false, httpOnly: false, hostOnly: false, session: true, sameSite: 'lax' } as never,
    'h.example',
  );
  assert.equal(domainCookie.url, 'http://h.example/', 'insecure cookie → http url');
  assert.equal(domainCookie.domain, '.h.example', 'domain cookie keeps its leading-dot domain');
  assert.equal(domainCookie.expirationDate, undefined, 'session cookie carries no expirationDate');
});

// ── Signed-in tabs WI-2(d): SigninSession concurrency de-dup ──────────────────

/** signinKey(workspaceId, origin) — mirrors the module-private key builder so a
 *  test can read the registry entry directly. */
function sessKey(workspaceId: string | null, origin: string): string {
  return `${workspaceId ?? ''}|${origin}`;
}

test('WI-2(d) ensureSignedInOrPend: 4 concurrent navs to one origin open EXACTLY ONE sign-in tab; the others join as pending', () => {
  const { mgr, sent } = makeManager();
  const rule = store.insertRule({ hostname: 'dedup.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null });
  mgr.invalidateAccessCache();
  // Stub the JIT tab opener (a real one would construct a live WebContentsView):
  // fabricate a quarantined agent tab and count the opens.
  let opens = 0;
  (mgr as unknown as Record<string, unknown>).openSigninHandoffTab = (
    _rule: unknown, _ws: unknown, target: string | undefined,
  ): string => {
    opens += 1;
    const t = injectTab(mgr, { partition: 'agent', url: target ?? 'https://dedup.example/', signinPending: true });
    return t.id;
  };

  const origin = 'https://dedup.example';
  const target = 'https://dedup.example/feed';
  const outcomes = Array.from({ length: 4 }, () =>
    mgr.ensureSignedInOrPend(null, origin, rule.id, undefined, target),
  );

  assert.equal(opens, 1, 'exactly ONE sign-in tab opened across 4 concurrent navs');
  assert.deepEqual(outcomes, ['pending', 'pending', 'pending', 'pending'], 'every caller is told to wait');
  const session = (mgr as unknown as { signinSessions: Map<string, { waiters: number; state: string }> })
    .signinSessions.get(sessKey(null, origin));
  assert.ok(session, 'one registry session exists for the (workspace, origin)');
  assert.equal(session!.state, 'pending');
  assert.equal(session!.waiters, 4, 'all four navs joined the single session (de-dup telemetry)');
  assert.equal(
    sent.filter((s) => s.channel === CH.signinPendingOpened).length, 1,
    'browser:signin-pending-opened fired exactly once',
  );
});

test('WI-2(d) ensureSignedInOrPend: a ready session short-circuits to ready (no tab)', () => {
  const { mgr } = makeManager();
  const rule = store.insertRule({ hostname: 'dedup-ready.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null });
  mgr.invalidateAccessCache();
  const origin = 'https://dedup-ready.example';
  // An already-active session → classifyOriginState returns ready before any tab.
  store.upsertSignedInOrigin(rule.id, origin, null, { signedInAt: Date.now(), verifiedAt: Date.now() });
  let opens = 0;
  (mgr as unknown as Record<string, unknown>).openSigninHandoffTab = (): string => { opens += 1; return 'x'; };
  assert.equal(mgr.ensureSignedInOrPend(null, origin, rule.id, undefined, `${origin}/feed`), 'ready');
  assert.equal(opens, 0, 'no sign-in tab opened for a live session');
});

// ── Signed-in tabs WI-8: unattended short-circuit + hold-timeout config ───────

test('WI-8 ensureSignedInOrPend: an unattended workspace degrades to unavailable WITHOUT opening a tab', () => {
  const { mgr, sent } = makeManager();
  const rule = store.insertRule({ hostname: 'unattended.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: 'ws-night' });
  mgr.invalidateAccessCache();
  const origin = 'https://unattended.example';
  let opens = 0;
  (mgr as unknown as Record<string, unknown>).openSigninHandoffTab = (): string => { opens += 1; return 'x'; };

  // Default (attended) would pend + open a tab; flag the workspace unattended.
  mgr.setSigninUnattended('ws-night', true);
  assert.equal(mgr.isSigninUnattended('ws-night'), true);
  assert.equal(
    mgr.ensureSignedInOrPend('ws-night', origin, rule.id, undefined, `${origin}/feed`),
    'unavailable',
    'an overnight/unattended run degrades immediately instead of hanging on a human',
  );
  assert.equal(opens, 0, 'no quarantined sign-in tab opened for an unattended workspace');
  assert.equal(
    sent.filter((s) => s.channel === CH.signinPendingOpened).length, 0,
    'no signin-pending-opened event fired for the unattended degrade',
  );

  // Clearing the flag restores the attended (pending + tab) behavior.
  mgr.setSigninUnattended('ws-night', false);
  assert.equal(mgr.isSigninUnattended('ws-night'), false);
  assert.equal(mgr.ensureSignedInOrPend('ws-night', origin, rule.id, undefined, `${origin}/feed`), 'pending');
  assert.equal(opens, 1, 'with the flag cleared, a sign-in tab is opened again');
});

test('WI-8 signinHoldTimeoutMs: configurable with a sane floor (rejects 0/negative)', () => {
  const { mgr } = makeManager();
  assert.equal(mgr.getSigninHoldTimeoutMs(), 300_000, 'defaults to 5 min');
  mgr.setSigninHoldTimeoutMs(60_000);
  assert.equal(mgr.getSigninHoldTimeoutMs(), 60_000);
  mgr.setSigninHoldTimeoutMs(0);
  assert.equal(mgr.getSigninHoldTimeoutMs(), 60_000, 'a 0 is rejected (no busy-degrade)');
  mgr.setSigninHoldTimeoutMs(-5);
  assert.equal(mgr.getSigninHoldTimeoutMs(), 60_000, 'a negative is rejected');
});

test('WI-4 listSigninPending: maps registry states to wire vocabulary, workspace-scoped', () => {
  const { mgr } = makeManager();
  const sessions = (mgr as unknown as { signinSessions: Map<string, unknown> }).signinSessions;
  const mk = (workspaceId: string | null, origin: string, state: string) => ({
    ruleId: 'r', workspaceId, origin, targetUrl: origin, tabId: 't',
    state, openedAt: 1000, reason: '', waiters: 1,
  });
  sessions.set(sessKey('ws-a', 'https://p.example'), mk('ws-a', 'https://p.example', 'pending'));
  sessions.set(sessKey('ws-a', 'https://r.example'), mk('ws-a', 'https://r.example', 'ready'));
  sessions.set(sessKey('ws-a', 'https://u.example'), mk('ws-a', 'https://u.example', 'unavailable'));
  sessions.set(sessKey('ws-b', 'https://other.example'), mk('ws-b', 'https://other.example', 'pending'));

  const out = mgr.listSigninPending('ws-a');
  assert.equal(out.length, 3, 'only ws-a sessions, not ws-b');
  const byOrigin = Object.fromEntries(out.map((e) => [e.origin, e]));
  assert.equal(byOrigin['https://p.example'].state, 'pending_signin');
  assert.equal(byOrigin['https://r.example'].state, 'ready');
  assert.equal(byOrigin['https://u.example'].state, 'signin_unavailable');
  assert.equal(byOrigin['https://p.example'].request_id, 'ws-a|https://p.example');
  assert.equal(byOrigin['https://p.example'].since, 1000);
});

// ── Signed-in tabs WI-3: completion upserts an ACTIVE session + resolves ──────

test('WI-3 accessHandoffReady: completion upserts the origin ACTIVE, clears quarantine, resolves the session ready', () => {
  const { mgr, sent } = makeManager();
  const rule = store.insertRule({ hostname: 'complete.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null });
  mgr.invalidateAccessCache();
  const origin = 'https://complete.example';
  assert.equal(store.getSignedInOriginState(rule.id, origin), undefined, 'no session before completion');

  // A quarantined sign-in tab committed on the allow_signed_in origin, plus a
  // pending registry session pointing at it (as ensureSignedInOrPend would leave it).
  const tab = injectTab(mgr, { partition: 'agent', url: `${origin}/dashboard`, signinPending: true });
  (tab as unknown as { signinRuleId?: string }).signinRuleId = rule.id;
  const key = sessKey(null, origin);
  (mgr as unknown as { signinSessions: Map<string, unknown> }).signinSessions.set(key, {
    ruleId: rule.id, workspaceId: null, origin, targetUrl: `${origin}/dashboard`,
    tabId: tab.id, state: 'pending', openedAt: 0, reason: '', waiters: 2,
  });

  sent.length = 0;
  mgr.accessHandoffReady(tab.id);

  assert.equal(store.getSignedInOriginState(rule.id, origin), 'active', 'the session is upserted active on completion');
  assert.equal(tab.signinPending, false, 'quarantine cleared (the tab becomes agent-visible/drivable)');
  const session = (mgr as unknown as { signinSessions: Map<string, { state: string }> }).signinSessions.get(key);
  assert.equal(session!.state, 'ready', 'the registry session flips ready so pollers proceed');
  const resolved = sent.find((s) => s.channel === CH.signinResolved);
  assert.ok(resolved, 'browser:signin-resolved emitted');
  assert.equal((resolved!.payload as { state: string }).state, 'ready');
});

test('WI-3 accessSigninPendingCancel: closes the quarantined tab + resolves unavailable, but PRESERVES durable consent', () => {
  const { mgr, sent } = makeManager();
  const rule = store.insertRule({
    hostname: 'cancel.example', scheme: 'https', includeSubdomains: true, allowSignedIn: true,
    workspaceId: null, consentAckedAt: 999,
  });
  mgr.invalidateAccessCache();
  const origin = 'https://cancel.example';
  const tab = injectTab(mgr, { partition: 'agent', url: `${origin}/login`, signinPending: true });
  const key = sessKey(null, origin);
  (mgr as unknown as { signinSessions: Map<string, unknown> }).signinSessions.set(key, {
    ruleId: rule.id, workspaceId: null, origin, targetUrl: `${origin}/feed`,
    tabId: tab.id, state: 'pending', openedAt: 0, reason: '', waiters: 1,
  });
  const internals = mgr as unknown as { tabs: Map<string, unknown> };

  sent.length = 0;
  mgr.accessSigninPendingCancel(tab.id);

  assert.equal(internals.tabs.has(tab.id), false, 'the quarantined sign-in tab is closed');
  const session = (mgr as unknown as { signinSessions: Map<string, { state: string }> }).signinSessions.get(key);
  assert.equal(session!.state, 'unavailable', 'the session degrades to unavailable');
  const resolved = sent.find((s) => s.channel === CH.signinResolved);
  assert.equal((resolved!.payload as { state: string }).state, 'signin_unavailable', 'banner clears via resolved(unavailable)');
  // Durable consent is NOT cleared — the origin can re-trigger a later sign-in.
  assert.equal(store.getRule(rule.id)?.consentAckedAt, 999, 'consent_acked_at is preserved across cancel');
});

// ── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-manager-'));
  process.env.APPDATA = tmpAppData;
  // hardenSession() builds a Chrome UA from process.versions.chrome, which is
  // undefined under plain node — provide a value so construction succeeds.
  if (!process.versions.chrome) {
    Object.defineProperty(process.versions, 'chrome', { value: '120.0.0.0', configurable: true });
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const sqliteResolved = require.resolve('better-sqlite3');
  require.cache[sqliteResolved] = {
    id: sqliteResolved, filename: sqliteResolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  const electronResolved = require.resolve('electron');
  require.cache[electronResolved] = {
    id: electronResolved, filename: electronResolved, loaded: true, exports: electronMock,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dbm = require('../database') as { initDatabase(): void };
  dbm.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  BM = require('./browser-manager') as BMModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  store = require('./access-policy-store') as StoreModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  policy = require('./browser-policy') as PolicyModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  CH = (require('../../shared/browser') as SharedModule).BROWSER_CHANNELS;

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
