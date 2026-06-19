// Slice 15 — per-site zoom + find-in-page upgrades (MAIN-PROCESS side).
//
// Like browser-manager.test.ts / access-policy-store.test.ts, this injects a
// sql.js (wasm SQLite) stand-in for better-sqlite3 AND a minimal `electron`
// stand-in into require.cache BEFORE requiring the modules under test, then
// drives the real BrowserManager against fabricated TabEntry-shaped fakes (no
// live WebContentsView / session). The fake webContents records findInPage /
// stopFindInPage / setZoomFactor calls so the find-state + zoom-persistence
// seams can be asserted directly.
//
// Covers (the Slice-15 required tests):
//   - per-site zoom: a USER tab's origin opens at the persisted zoom; setZoom
//     persists by origin; reset clears the origin row (→100%); AGENT zoom stays
//     per-tab and is NEVER persisted.
//   - find: findNext/findPrev reuse the latest query IMMEDIATELY (no debounce);
//     switching tabs restores each tab's query + count (re-runs the query); a
//     stopFind clears only the active tab's state/highlight.
//
//   npm run build:main
//   node dist/main/main/browser/slice15-zoom-find.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors browser-manager.test) ──────

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
type ZoomModule = typeof import('./zoom-store');
let BM: BMModule;
let zoom: ZoomModule;

// ── fakes for the tab graph ──────────────────────────────────────────────────

interface FindCall { text: string; options?: Record<string, unknown>; }
interface FakeWC {
  getURL(): string; getTitle(): string; isDestroyed(): boolean; isLoading(): boolean;
  getZoomFactor(): number; setZoomFactor(z: number): void;
  navigationHistory: { canGoBack(): boolean; canGoForward(): boolean };
  on(event: string, fn: (...a: unknown[]) => void): FakeWC;
  once(event: string, fn: (...a: unknown[]) => void): FakeWC;
  off(event: string, fn: (...a: unknown[]) => void): FakeWC;
  removeListener(event: string, fn: (...a: unknown[]) => void): FakeWC;
  emit(event: string, ...args: unknown[]): void;
  setWindowOpenHandler(): void;
  setUserAgent(): void;
  setURL(url: string): void;
  setBackgroundThrottling(): void;
  executeJavaScript(): Promise<unknown>;
  downloadURL(): void;
  openDevTools(): void;
  // Slice 15 seams — recorded for assertions.
  findInPage(text: string, options?: Record<string, unknown>): void;
  stopFindInPage(action?: string): void;
  findCalls: FindCall[];
  stopFindCount: number;
  zoomFactor: number;
}

function fakeWC(url: string, title = 'T'): FakeWC {
  let currentUrl = url;
  let zoomFactor = 1;
  const findCalls: FindCall[] = [];
  let stopFindCount = 0;
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const wc: FakeWC = {
    getURL: () => currentUrl,
    getTitle: () => title,
    isDestroyed: () => false,
    isLoading: () => false,
    getZoomFactor: () => zoomFactor,
    setZoomFactor(z) { zoomFactor = z; },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    on(event, fn) { (listeners.get(event) ?? listeners.set(event, []).get(event)!).push(fn); return wc; },
    once(event, fn) { return wc.on(event, fn); },
    off(event, fn) {
      const fns = listeners.get(event);
      if (fns) listeners.set(event, fns.filter((f) => f !== fn));
      return wc;
    },
    removeListener(event, fn) { return wc.off(event, fn); },
    emit(event, ...args) { for (const fn of [...(listeners.get(event) ?? [])]) fn(...args); },
    setWindowOpenHandler() {},
    setUserAgent() {},
    setURL(next) { currentUrl = next; },
    setBackgroundThrottling() {},
    executeJavaScript: async () => 0,
    downloadURL() {},
    openDevTools() {},
    findInPage(text, options) { findCalls.push({ text, options }); },
    stopFindInPage() { stopFindCount++; },
    get findCalls() { return findCalls; },
    get stopFindCount() { return stopFindCount; },
    get zoomFactor() { return zoomFactor; },
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
  (mgr as unknown as { auditWriter: { record(): void } }).auditWriter = { record() {} };
  return { mgr, sent };
}

interface FakeTab {
  id: string; partition: 'agent' | 'user'; partitionFull: string;
  openedByAgent: boolean; workspaceId: string | null;
  view: { webContents: FakeWC; setBounds(): void; setVisible(): void };
}

let tabSeq = 0;
function injectTab(
  mgr: MgrHarness['mgr'],
  opts: { partition: 'agent' | 'user'; url: string; title?: string },
): FakeTab {
  const id = `tab-${++tabSeq}`;
  const wc = fakeWC(opts.url, opts.title);
  const tab: FakeTab = {
    id,
    partition: opts.partition,
    partitionFull: opts.partition === 'agent' ? 'persist:agent' : 'persist:user',
    openedByAgent: false,
    workspaceId: null,
    view: { webContents: wc, setBounds() {}, setVisible() {} },
  };
  const internals = mgr as unknown as { tabs: Map<string, unknown>; tabOrder: string[] };
  internals.tabs.set(id, tab);
  internals.tabOrder.push(id);
  return tab;
}

function priv<T = unknown>(mgr: MgrHarness['mgr'], name: string): (...a: unknown[]) => T {
  const fn = (mgr as unknown as Record<string, unknown>)[name];
  return (fn as (...a: unknown[]) => T).bind(mgr) as (...a: unknown[]) => T;
}

// ── per-site zoom ─────────────────────────────────────────────────────────────

test('zoom-store: set/get/clear/list by origin', () => {
  zoom.clearAllZoom();
  assert.equal(zoom.getZoom('https://a.example'), undefined, 'no row → undefined');
  zoom.setZoom('https://a.example', 1.25, 1000);
  zoom.setZoom('https://b.example', 1.5, 2000);
  assert.equal(zoom.getZoom('https://a.example'), 1.25);
  // upsert keeps a single row per origin
  zoom.setZoom('https://a.example', 1.75, 3000);
  assert.equal(zoom.getZoom('https://a.example'), 1.75);
  const list = zoom.listZoom();
  assert.equal(list.length, 2, 'two distinct origins');
  zoom.clearZoom('https://a.example');
  assert.equal(zoom.getZoom('https://a.example'), undefined, 'cleared → undefined');
  assert.equal(zoom.getZoom('https://b.example'), 1.5, 'other origin untouched');
});

test('USER tab opens at the persisted per-origin zoom (applyPersistedZoom)', () => {
  zoom.clearAllZoom();
  const { mgr } = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://docs.example/start' });
  zoom.setZoom('https://docs.example', 1.5);
  // committed-navigation apply path (USER only).
  priv(mgr, 'applyPersistedZoom')(tab, 'https://docs.example/start');
  assert.equal(tab.view.webContents.zoomFactor, 1.5, 'restored persisted zoom');
});

test('USER tab with no stored origin falls back to 100%', () => {
  zoom.clearAllZoom();
  const { mgr } = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://fresh.example/' });
  tab.view.webContents.setZoomFactor(2); // pretend a stale factor
  priv(mgr, 'applyPersistedZoom')(tab, 'https://fresh.example/');
  assert.equal(tab.view.webContents.zoomFactor, 1, 'fallback to 100%');
});

test('setZoom persists a USER tab by origin; resetZoomForOrigin clears the row (→100%)', () => {
  zoom.clearAllZoom();
  const { mgr } = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://site.example/page' });
  mgr.setZoom(tab.id, 1.25);
  assert.equal(zoom.getZoom('https://site.example'), 1.25, 'setZoom persisted by origin');
  assert.equal(tab.view.webContents.zoomFactor, 1.25);
  mgr.resetZoomForOrigin(tab.id);
  assert.equal(zoom.getZoom('https://site.example'), undefined, 'reset cleared the origin row');
  assert.equal(tab.view.webContents.zoomFactor, 1, 'reset snapped to 100%');
});

test('AGENT zoom stays per-tab — never persisted', () => {
  zoom.clearAllZoom();
  const { mgr } = makeManager();
  const tab = injectTab(mgr, { partition: 'agent', url: 'https://agent.example/x' });
  mgr.setZoom(tab.id, 1.5);
  assert.equal(tab.view.webContents.zoomFactor, 1.5, 'agent tab zoom applied per-tab');
  assert.equal(zoom.getZoom('https://agent.example'), undefined, 'agent zoom NOT persisted');
  assert.equal(zoom.listZoom().length, 0, 'no origin rows written for an agent tab');
});

// ── find-in-page upgrades ─────────────────────────────────────────────────────

test('findNext/findPrev use the LATEST query immediately (no debounce)', () => {
  const { mgr } = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://find.example/' });
  const wc = tab.view.webContents;
  mgr.find(tab.id, 'foo', { matchCase: true });
  // latest query supersedes the prior one — next/prev must use 'foobar'.
  mgr.find(tab.id, 'foobar', { matchCase: true });
  mgr.findNext(tab.id);
  mgr.findPrev(tab.id);
  const calls = wc.findCalls;
  // 0: fresh 'foo', 1: fresh 'foobar', 2: next, 3: prev
  assert.equal(calls[2].text, 'foobar', 'findNext used the latest query');
  assert.equal(calls[2].options?.findNext, true);
  assert.equal(calls[2].options?.forward, true);
  assert.equal(calls[2].options?.matchCase, true, 'case-sensitive carried through');
  assert.equal(calls[3].text, 'foobar', 'findPrev used the latest query');
  assert.equal(calls[3].options?.forward, false, 'prev steps backward');
});

test('switching tabs restores each tab\'s find query + count', () => {
  const { mgr } = makeManager();
  const a = injectTab(mgr, { partition: 'user', url: 'https://a.example/' });
  const b = injectTab(mgr, { partition: 'user', url: 'https://b.example/' });
  // Wire the real found-in-page handler so counts land in each tab's findState.
  priv(mgr, 'wireViewEvents')(a);
  priv(mgr, 'wireViewEvents')(b);

  mgr.find(a.id, 'alpha');
  a.view.webContents.emit('found-in-page', {}, { activeMatchOrdinal: 2, matches: 5, finalUpdate: true });
  mgr.find(b.id, 'beta');
  b.view.webContents.emit('found-in-page', {}, { activeMatchOrdinal: 1, matches: 3, finalUpdate: true });

  const findStateOf = (id: string) =>
    (mgr as unknown as { tabs: Map<string, { findState?: { query: string; total: number } }> }).tabs.get(id)!.findState!;
  assert.equal(findStateOf(a.id).total, 5, 'tab A count recorded');
  assert.equal(findStateOf(b.id).total, 3, 'tab B count recorded');

  const aCallsBefore = a.view.webContents.findCalls.length;
  // Switch to A: restoreFind re-runs A's stored query; counts stay per-tab.
  mgr.setActiveTab(a.id);
  const aCalls = a.view.webContents.findCalls;
  assert.equal(aCalls.length, aCallsBefore + 1, 'restore re-ran A\'s query');
  assert.equal(aCalls[aCalls.length - 1].text, 'alpha', 'restored A\'s query verbatim');
  assert.equal(findStateOf(a.id).total, 5, 'A count preserved across switch');
  assert.equal(findStateOf(b.id).total, 3, 'B count preserved across switch');
});

test('stopFind clears only the active tab\'s state + native highlight', () => {
  const { mgr } = makeManager();
  const a = injectTab(mgr, { partition: 'user', url: 'https://a.example/' });
  const b = injectTab(mgr, { partition: 'user', url: 'https://b.example/' });
  mgr.find(a.id, 'alpha');
  mgr.find(b.id, 'beta');
  const tabs = (mgr as unknown as { tabs: Map<string, { findState?: unknown }> }).tabs;
  mgr.stopFind(a.id);
  assert.equal(tabs.get(a.id)!.findState, undefined, 'A find state cleared');
  assert.equal(a.view.webContents.stopFindCount, 1, 'A native highlight cleared');
  assert.ok(tabs.get(b.id)!.findState, 'B find state untouched');
  assert.equal(b.view.webContents.stopFindCount, 0, 'B highlight not touched');
});

test('empty find() clears the tab\'s state + highlight', () => {
  const { mgr } = makeManager();
  const tab = injectTab(mgr, { partition: 'user', url: 'https://x.example/' });
  mgr.find(tab.id, 'q');
  mgr.find(tab.id, '');
  const tabs = (mgr as unknown as { tabs: Map<string, { findState?: unknown }> }).tabs;
  assert.equal(tabs.get(tab.id)!.findState, undefined, 'empty query cleared state');
  assert.equal(tab.view.webContents.stopFindCount, 1, 'empty query stopped find');
});

// ── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'slice15-zoom-find-'));
  process.env.APPDATA = tmpAppData;
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
  zoom = require('./zoom-store') as ZoomModule;

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
