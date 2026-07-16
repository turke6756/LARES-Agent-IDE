// Phase 4 (BrowserSigninSharing plan §D) — robust expiry & re-auth REGRESSION.
//
// GREEN GATE (registered in package.json `test:supervisor`). Phase 4 hardens
// WHEN a workspace-exact login grant is considered expired (beyond the Phase-2
// URL heuristic) and adds an explicit human re-arm for the run-scoped
// "unavailable stays unavailable" latch:
//
//   • Item 1 — stronger, CONTENT-FREE expiry signals feeding
//     classifyOriginState / expireLoginGrant: a main-frame HTTP 401/403
//     (maybeExpireOnHttpStatus) and a redirect to a configured IdP / login
//     destination (isKnownLoginDestination) atomically expire ONLY the failing
//     (workspace, origin) grant.
//   • Item 2 — the per-board adapter's loginWallHints are folded into the
//     nav-path login-wall probe, so a guest view parked on e.g. Handshake's
//     /access wall is caught on classify too (not only at setup) — a
//     guest-viewable page never stays `ready`.
//   • Item 3 — expiry is atomic and scoped: expiring ws-A never touches ws-B.
//   • Item 4 — accessSigninReArm clears a run-scoped `unavailable` latch for one
//     (workspace, origin) so the next agent nav reopens ONE setup tab; it never
//     disturbs a live `pending`/`ready` session.
//
// Harness (FakeBetterSqlite + electron stand-in + makeManager) mirrors
// browser-signin-workspace-exact.test.ts.
//
//   npm run build:main
//   node dist/main/main/browser/browser-signin-expiry.test.js
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
  (mgr as unknown as { auditWriter: { record(): void } }).auditWriter = { record() {} };
  return { mgr, sent };
}

// Reproduce the module-private registry key (`${workspaceId ?? ''}|${origin}`) so
// tests can inject / read a runtime SigninSession without exporting internals.
function signinKey(workspaceId: string | null, origin: string): string {
  return `${workspaceId ?? ''}|${origin}`;
}

// ── Item 1 — main-frame 401/403 is a content-free expiry signal ───────────────

test('item 1: a main-frame 401 on an allow_signed_in origin expires that grant', () => {
  const { mgr } = makeManager();
  const origin = 'https://expiry-401.com';
  const rule = store.insertRule({
    hostname: 'expiry-401.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  mgr.invalidateAccessCache();
  assert.equal(store.getLoginGrantSessionState(rule.id, origin, 'ws-A'), 'active', 'precondition: ws-A active');

  const tab = { partition: 'agent', workspaceId: 'ws-A' };
  (mgr as unknown as { maybeExpireOnHttpStatus(t: unknown, u: string, s: number): void })
    .maybeExpireOnHttpStatus(tab, `${origin}/dashboard`, 401);

  assert.equal(
    store.getLoginGrantSessionState(rule.id, origin, 'ws-A'),
    'expired',
    'a main-frame 401 must atomically expire the ws-A grant (content-free signal)',
  );
});

test('item 1: a 403 expires; a 200 / 302 does NOT churn the grant', () => {
  const { mgr } = makeManager();
  const origin = 'https://expiry-403.com';
  const rule = store.insertRule({
    hostname: 'expiry-403.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  const call = (status: number) =>
    (mgr as unknown as { maybeExpireOnHttpStatus(t: unknown, u: string, s: number): void })
      .maybeExpireOnHttpStatus({ partition: 'agent', workspaceId: 'ws-A' }, `${origin}/`, status);

  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  mgr.invalidateAccessCache();
  call(200);
  assert.equal(store.getLoginGrantSessionState(rule.id, origin, 'ws-A'), 'active', '200 leaves the grant active');
  call(302);
  assert.equal(store.getLoginGrantSessionState(rule.id, origin, 'ws-A'), 'active', '302 leaves the grant active');
  call(403);
  assert.equal(store.getLoginGrantSessionState(rule.id, origin, 'ws-A'), 'expired', '403 expires the grant');
});

test('item 1: a 401 on a HUMAN (persist:user) tab never expires an agent grant', () => {
  const { mgr } = makeManager();
  const origin = 'https://expiry-human.com';
  const rule = store.insertRule({
    hostname: 'expiry-human.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  mgr.invalidateAccessCache();

  (mgr as unknown as { maybeExpireOnHttpStatus(t: unknown, u: string, s: number): void })
    .maybeExpireOnHttpStatus({ partition: 'user', workspaceId: 'ws-A' }, `${origin}/`, 401);

  assert.equal(
    store.getLoginGrantSessionState(rule.id, origin, 'ws-A'),
    'active',
    'a human tab hitting 401 must NOT expire the agent-partition grant',
  );
});

// ── Item 3 — expiry is atomic and scoped to ONE (workspace, origin) ───────────

test('item 3: a 401 in ws-A expires ONLY ws-A — ws-B stays active (no cross-talk)', () => {
  const { mgr } = makeManager();
  const origin = 'https://expiry-scoped.com';
  const rule = store.insertRule({
    hostname: 'expiry-scoped.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-B', { signedInAt: 1000, verifiedAt: 1000 });
  mgr.invalidateAccessCache();

  (mgr as unknown as { maybeExpireOnHttpStatus(t: unknown, u: string, s: number): void })
    .maybeExpireOnHttpStatus({ partition: 'agent', workspaceId: 'ws-A' }, `${origin}/`, 401);

  assert.equal(store.getLoginGrantSessionState(rule.id, origin, 'ws-A'), 'expired', 'ws-A expired by its 401');
  assert.equal(
    store.getLoginGrantSessionState(rule.id, origin, 'ws-B'),
    'active',
    'expiring ws-A must NOT touch ws-B — atomic per-(workspace,origin) expiry',
  );
});

// ── Item 1/2 — adapter-aware login-wall + IdP-redirect on the classify path ───

test('item 2: an active Handshake grant parked on the /access wall classifies needs_signin (adapter hint)', () => {
  const { mgr } = makeManager();
  const origin = 'https://joinhandshake.com';
  const rule = store.insertRule({
    hostname: 'joinhandshake.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  mgr.invalidateAccessCache();

  // /access is NOT a DEFAULT_LOGIN_PATH — pre-Phase-4 classify missed it and left
  // the guest view `ready`. The Handshake adapter's loginWallHints now catch it.
  const committed = `${origin}/access?access_state_id=abc123`;
  assert.equal(
    mgr.classifyOriginState('ws-A', origin, committed),
    'needs_signin',
    'a guest view on the Handshake /access wall must classify needs_signin (guest != authenticated)',
  );
  assert.equal(
    store.getLoginGrantSessionState(rule.id, origin, 'ws-A'),
    'expired',
    'the adapter-hint login-wall signal atomically expired the grant',
  );
});

test('item 1: a redirect to a configured IdP destination (login.live.com) expires the grant', () => {
  const { mgr } = makeManager();
  const origin = 'https://indeed.com';
  const rule = store.insertRule({
    hostname: 'indeed.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  mgr.invalidateAccessCache();

  // login.live.com is a COMMON_IDP_ORIGIN (in the adapter's loginDestinations) but
  // is NOT caught by looksLikeLoginWall's isAuthHost/path checks — this isolates
  // the new isKnownLoginDestination branch.
  assert.equal(
    mgr.classifyOriginState('ws-A', origin, 'https://login.live.com/'),
    'needs_signin',
    'a redirect to a configured IdP login destination is an expiry signal',
  );
  assert.equal(
    store.getLoginGrantSessionState(rule.id, origin, 'ws-A'),
    'expired',
    'the IdP-redirect signal atomically expired the grant',
  );
});

test('item 2: an active grant on its normal authenticated page stays ready (no false expiry)', () => {
  const { mgr } = makeManager();
  const origin = 'https://joinhandshake.com';
  const rule = store.insertRule({
    hostname: 'joinhandshake.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  mgr.invalidateAccessCache();
  assert.equal(
    mgr.classifyOriginState('ws-A', origin, `${origin}/stu/jobs`),
    'ready',
    'a normal authenticated Handshake page must stay ready — no over-broad expiry',
  );
});

// ── Item 4 — explicit human re-arm of a run-scoped `unavailable` latch ────────

test('item 4: accessSigninReArm clears an unavailable latch and returns true', () => {
  const { mgr } = makeManager();
  const origin = 'https://rearm.com';
  const rule = store.insertRule({
    hostname: 'rearm.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  mgr.invalidateAccessCache();
  const key = signinKey('ws-A', origin);
  const sessions = (mgr as unknown as { signinSessions: Map<string, { state: string; ruleId: string; workspaceId: string | null; origin: string; targetUrl: string; tabId: string; openedAt: number; reason: string; waiters: number }> }).signinSessions;
  sessions.set(key, {
    state: 'unavailable', ruleId: rule.id, workspaceId: 'ws-A', origin, targetUrl: origin,
    tabId: 't1', openedAt: 1000, reason: 'timed out', waiters: 1,
  });

  // With no active grant the latch is what ensureSignedInOrPend returns (no reopen).
  const ensure = mgr.ensureSignedInOrPend as unknown as (
    w: string | null, o: string, r: string, t: string | undefined, u?: string,
  ) => string;
  assert.equal(
    ensure.call(mgr, 'ws-A', origin, rule.id, undefined, origin),
    'unavailable',
    'precondition: the run-scoped unavailable latch blocks reopen',
  );

  assert.equal(mgr.accessSigninReArm('ws-A', origin), true, 're-arm clears an unavailable latch → true');
  assert.equal(sessions.get(key), undefined, 're-arm deletes the unavailable session so the next nav can reopen ONE tab');
});

test('item 4: accessSigninReArm never disturbs a live pending session and returns false', () => {
  const { mgr } = makeManager();
  const origin = 'https://rearm-pending.com';
  const key = signinKey('ws-A', origin);
  const sessions = (mgr as unknown as { signinSessions: Map<string, { state: string }> }).signinSessions;
  sessions.set(key, { state: 'pending' } as never);

  assert.equal(mgr.accessSigninReArm('ws-A', origin), false, 're-arm of a live pending session is a no-op → false');
  assert.equal((sessions.get(key) as { state: string }).state, 'pending', 'the pending session is left intact');
});

test('item 4: accessSigninReArm on an absent session returns false', () => {
  const { mgr } = makeManager();
  assert.equal(
    mgr.accessSigninReArm('ws-A', 'https://never-armed.com'),
    false,
    're-arm with no registry session is a safe no-op → false',
  );
});

// ── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-signin-expiry-'));
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
