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
  };
}

const electronMock = {
  app: { getPath: () => os.tmpdir() },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  session: { fromPartition: () => fakeSession() },
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
  setWindowOpenHandler(): void;
  setUserAgent(): void;
  setURL(url: string): void;
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
    setWindowOpenHandler() {},
    setUserAgent() {},
    setURL(next) { currentUrl = next; },
  };
  return wc;
}

interface MgrHarness { mgr: InstanceType<BMModule['BrowserManager']>; sent: Array<{ channel: string; payload: unknown }>; }

function makeManager(): MgrHarness {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const win = {
    webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } },
    contentView: { addChildView() {}, removeChildView() {} },
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
  view: { webContents: FakeWC };
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
    view: { webContents: fakeWC(opts.url, opts.title) },
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
