// Phase 1 (BrowserSigninSharing plan §D) — workspace-exact login-grant REGRESSION.
//
// GREEN GATE (registered in package.json `test:supervisor`). This file holds the
// now-fixed assertions for the workspace-exact login-grant behavior Phase 1
// delivers:
//
//   • (a) Partition-mismatch classify (MOVED here from browser-signin-repro.test,
//     where it was the red reproduction). A legacy allow_signed_in rule with
//     workspace_id = NULL governs every workspace, but its imported cookies live
//     only in persist:agent:default. A named-workspace caller must therefore get
//     'needs_signin', NOT 'ready'. Phase 1 makes classifyOriginState read the
//     WORKSPACE-EXACT grant (browser_access_login_grants keyed by the caller's
//     workspace), so this now passes.
//
//   • 2-workspace independence (acceptance): ONE legacy NULL-workspace wildcard
//     rule carries INDEPENDENT login sessions per workspace. A grant in ws-A is
//     'ready' for ws-A and invisible ('needs_signin') to ws-B; establishing ws-B
//     independently makes both ready; expiring ws-A only leaves ws-B ready — no
//     cross-talk in either direction.
//
// The anonymous-cookie-import reproduction (b) stays in browser-signin-repro.test
// (still RED, out of the chain) — that defect is Phase 2's, not Phase 1's.
//
// Harness (FakeBetterSqlite + electron stand-in + makeManager) mirrors
// browser-manager.test.ts / browser-signin-repro.test.ts.
//
//   npm run build:main
//   node dist/main/main/browser/browser-signin-workspace-exact.test.js
//   (expected: all pass — exit 0; it is a green gate in the supervisor chain.)

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
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; } finally { stmt.free(); }
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
      try { const r = fn(...args); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    };
  }
}

// ── minimal `electron` stand-in (mirrors browser-manager.test) ────────────────

function fakeSession(): unknown {
  return {
    setUserAgent() {},
    on() {},
    webRequest: { onBeforeRequest() {} },
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    setDevicePermissionHandler() {},
    cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
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

// ── modules under test (loaded after the cache injections) ────────────────────

type BMModule = typeof import('./browser-manager');
type StoreModule = typeof import('./access-policy-store');
let BM: BMModule;
let store: StoreModule;

interface MgrHarness { mgr: InstanceType<BMModule['BrowserManager']>; sent: Array<{ channel: string; payload: unknown }>; }

function makeManager(): MgrHarness {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const win = {
    webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } },
    contentView: { addChildView() {}, removeChildView() {} },
    getBackgroundColor: () => '#1e1e1e',
  };
  const mgr = new BM.BrowserManager(() => win as never, 0);
  // Stub the audit writer so no path touches the filesystem.
  (mgr as unknown as { auditWriter: { record(): void } }).auditWriter = { record() {} };
  return { mgr, sent };
}

// ── (a) Partition-mismatch classify — FIXED IN PHASE 1 (moved from repro) ──────
// A legacy allow_signed_in rule with workspace_id = NULL governs every workspace
// (rowAppliesToWorkspace). Its dual-written grant lands under workspace_key
// 'default' (persist:agent:default), where the cookies really live. A named
// caller reads the grant for its OWN workspace, finds none, and must get
// 'needs_signin'. Pre-Phase-1 this said 'ready' (the reproduction).

test('(a) partition-mismatch classify: NULL-workspace grant is NOT ready for a named caller', () => {
  const { mgr } = makeManager();
  const rule = store.insertRule({
    hostname: 'linkedin.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  // Grant established with workspace null → dual-written under key 'default'.
  store.upsertSignedInOrigin(rule.id, 'https://linkedin.com', null, { signedInAt: 1000, verifiedAt: 1000 });
  mgr.invalidateAccessCache();

  assert.equal(
    mgr.classifyOriginState('ws-named', 'https://linkedin.com'),
    'needs_signin',
    "a 'default'-workspace grant's cookies live in persist:agent:default, not the caller's persist:agent:ws-named — a named caller must NOT be treated as ready",
  );
});

// ── 2-workspace independence — the acceptance gate ────────────────────────────
// ONE legacy NULL-workspace wildcard rule carries INDEPENDENT per-workspace login
// sessions. Establishing / expiring a grant in one workspace never leaks into the
// other in either direction.

test('2-workspace independence: one NULL-workspace wildcard rule holds independent per-workspace grants', () => {
  const { mgr } = makeManager();
  const origin = 'https://linkedin.com';
  const rule = store.insertRule({
    hostname: 'linkedin.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  mgr.invalidateAccessCache();

  // Establish ws-A only. ws-A ready; ws-B must stay independent (needs_signin).
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  assert.equal(mgr.classifyOriginState('ws-A', origin), 'ready', 'ws-A established a grant → ready');
  assert.equal(
    mgr.classifyOriginState('ws-B', origin),
    'needs_signin',
    'ws-A grant must be INVISIBLE to ws-B — independent per-workspace status is the gate',
  );

  // Establish ws-B independently → both ready, no cross-talk.
  store.upsertSignedInOrigin(rule.id, origin, 'ws-B', { signedInAt: 2000, verifiedAt: 2000 });
  assert.equal(mgr.classifyOriginState('ws-A', origin), 'ready', 'ws-A stays ready after ws-B established');
  assert.equal(mgr.classifyOriginState('ws-B', origin), 'ready', 'ws-B now has its own grant → ready');

  // Expire ws-A ONLY → ws-A degrades, ws-B untouched.
  store.expireLoginGrant(rule.id, origin, 'ws-A');
  assert.equal(
    mgr.classifyOriginState('ws-A', origin),
    'needs_signin',
    'ws-A grant expired → needs_signin',
  );
  assert.equal(
    mgr.classifyOriginState('ws-B', origin),
    'ready',
    'expiring ws-A must NOT touch ws-B — ws-B stays ready (no cross-talk)',
  );
});

// ── Revocation breadth — clear/remove span every workspace holding a grant ────
// The exact defect class Phase 1 kills: a legacy null-workspace wildcard rule
// holds independent grants across workspaces; clearing/deleting must NOT leave a
// named workspace's grant ACTIVE (a revoked-but-still-ready guest).

test('accessClearSiteSession expires grants in EVERY workspace of a wildcard rule (keeps the rule)', async () => {
  const { mgr } = makeManager();
  const origin = 'https://example-clear.com';
  const rule = store.insertRule({
    hostname: 'example-clear.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-B', { signedInAt: 1000, verifiedAt: 1000 });
  mgr.invalidateAccessCache();
  assert.equal(mgr.classifyOriginState('ws-A', origin), 'ready', 'precondition: ws-A ready');
  assert.equal(mgr.classifyOriginState('ws-B', origin), 'ready', 'precondition: ws-B ready');

  await mgr.accessClearSiteSession(rule.id);

  assert.equal(
    mgr.classifyOriginState('ws-A', origin),
    'needs_signin',
    'clear-session must expire ws-A grant immediately (not only persist:agent:default)',
  );
  assert.equal(
    mgr.classifyOriginState('ws-B', origin),
    'needs_signin',
    'clear-session must expire ws-B grant immediately — full workspace breadth',
  );
});

test('accessRuleRemove deletes login grants across all workspaces (no orphans)', () => {
  const { mgr } = makeManager();
  const origin = 'https://example-remove.com';
  const rule = store.insertRule({
    hostname: 'example-remove.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-B', { signedInAt: 1000, verifiedAt: 1000 });
  assert.equal(store.getLoginGrantSessionState(rule.id, origin, 'ws-A'), 'active', 'precondition: ws-A grant active');
  assert.equal(store.getLoginGrantSessionState(rule.id, origin, 'ws-B'), 'active', 'precondition: ws-B grant active');

  mgr.accessRuleRemove(rule.id);

  assert.equal(
    store.getLoginGrantSessionState(rule.id, origin, 'ws-A'),
    undefined,
    'deleting the rule must delete its ws-A login grant (no orphan)',
  );
  assert.equal(
    store.getLoginGrantSessionState(rule.id, origin, 'ws-B'),
    undefined,
    'deleting the rule must delete its ws-B login grant (no orphan)',
  );
});

// ── Phase 3 (§D line 264): read-only per-rule status seam ─────────────────────
// accessSiteStatus surfaces visit + login + WORKSPACE-EXACT grant session for the
// renderer, sourced from getLoginGrantSessionState (NEVER a bare legacy row), so
// "Ready" can never be shown for a workspace that does not actually hold a grant.

test('accessSiteStatus: workspace-exact — active in ws-A, none in ws-B for one wildcard rule', () => {
  const { mgr } = makeManager();
  const origin = 'https://status-exact.com';
  const rule = store.insertRule({
    hostname: 'status-exact.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  mgr.invalidateAccessCache();

  const rowA = mgr.accessSiteStatus('ws-A').find((r) => r.ruleId === rule.id);
  assert.ok(rowA, 'rule appears in the ws-A status list');
  assert.equal(rowA!.origin, origin, 'origin is scheme://hostname');
  assert.equal(rowA!.visit, true, 'an enabled rule → visit allowed');
  assert.equal(rowA!.login, true, 'allow_signed_in → login on');
  assert.equal(rowA!.session, 'active', 'ws-A holds the active grant → active');

  const rowB = mgr.accessSiteStatus('ws-B').find((r) => r.ruleId === rule.id);
  assert.ok(rowB, 'the wildcard rule also applies to ws-B');
  assert.equal(
    rowB!.session,
    'none',
    "ws-B holds no grant → 'none' (never surface Ready from another workspace's row)",
  );
});

test('accessSiteStatus: expiring the ws-A grant flips its session to expired', () => {
  const { mgr } = makeManager();
  const origin = 'https://status-expire.com';
  const rule = store.insertRule({
    hostname: 'status-expire.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  mgr.invalidateAccessCache();
  assert.equal(
    mgr.accessSiteStatus('ws-A').find((r) => r.ruleId === rule.id)?.session,
    'active',
    'precondition: ws-A grant active',
  );

  store.expireLoginGrant(rule.id, origin, 'ws-A');
  assert.equal(
    mgr.accessSiteStatus('ws-A').find((r) => r.ruleId === rule.id)?.session,
    'expired',
    'an expired workspace grant surfaces as expired (→ "Needs sign-in")',
  );
});

test('accessSiteStatus: a visit-only rule reports login:false, session:none', () => {
  const { mgr } = makeManager();
  const rule = store.insertRule({
    hostname: 'status-visit-only.com', scheme: 'https', includeSubdomains: true, allowSignedIn: false, workspaceId: null,
  });
  mgr.invalidateAccessCache();
  const row = mgr.accessSiteStatus('ws-A').find((r) => r.ruleId === rule.id);
  assert.ok(row, 'the visit-only rule appears in status');
  assert.equal(row!.login, false, 'no allow_signed_in → login off');
  assert.equal(row!.session, 'none', 'login off → session none (no grant lookup at all)');
  assert.equal(row!.visit, true, 'enabled → visit allowed');
});

test('accessSiteStatus: a disabled rule reports visit:false', () => {
  const { mgr } = makeManager();
  const rule = store.insertRule({
    hostname: 'status-disabled.com', scheme: 'https', includeSubdomains: true, allowSignedIn: false, workspaceId: null,
  });
  store.updateRule(rule.id, { enabled: false });
  mgr.invalidateAccessCache();
  const row = mgr.accessSiteStatus('ws-A').find((r) => r.ruleId === rule.id);
  assert.ok(row, 'a disabled rule still appears in status');
  assert.equal(
    row!.visit,
    false,
    'a disabled visit rule → visit:false (the renderer shows the line-through descriptor)',
  );
});

// ── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-signin-wsx-'));
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
