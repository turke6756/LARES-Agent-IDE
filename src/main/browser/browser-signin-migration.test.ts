// Phase 5 (BrowserSigninSharing plan §E) — MIGRATION + RESTART-PERSISTENCE gate.
//
// GREEN GATE (registered in package.json `test:supervisor`). Phase 5 proves the
// P0-P4 behavior migrates cleanly from a pre-workspace DB image and survives an
// app restart. This file covers plan §E lines 282 (migration) + 283 (restart
// persistence) — the two DB-durability gaps the unit inventory left open:
//
//   • Migration (line 282): a PRE-WORKSPACE image (a legacy allow_signed_in rule
//     with workspace_id = NULL + ACTIVE browser_access_signed_in_origins rows, and
//     NO workspace-exact login grant yet) is migrated by initDatabase()'s upgrade
//     synthesis into an explicit **Setup required** grant under workspace_key
//     'default' — consent PRESERVED, session NOT active, and the credentials NEVER
//     cloned into a named workspace (locked decision Q2). A named caller of such a
//     legacy origin is therefore needs_signin, never ready.
//   • Restart persistence (line 283): grants are SQLite-durable. "Restart" is
//     modeled by re-opening the store over the SAME db image — the FakeBetterSqlite
//     shares one sql.js store keyed by dbPath, so a second initDatabase() gives a
//     fresh db handle over the same "disk". active / expired / setup_required all
//     survive the re-open with the correct session_state; the run-scoped
//     `unavailable` re-arm latch is in-memory only, so a restart correctly clears it
//     (a fresh run re-pends) — never a false durable block.
//
// Q7 GUARD: expiry here is only ever driven by a real signal (expireLoginGrant),
// never by a clock — a restart on its own never writes `expired`.
//
// Harness (FakeBetterSqlite + electron stand-in + makeManager) mirrors
// browser-signin-expiry.test.ts / browser-signin-workspace-exact.test.ts.
//
//   npm run build:main
//   node dist/main/main/browser/browser-signin-migration.test.js
//   (expected: all pass — exit 0; it is a green gate in the supervisor chain.)

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors browser-manager.test) ──────
// The `stores` map keyed by dbPath is the crux of the RESTART model: a second
// `new FakeBetterSqlite(samePath)` (from a second initDatabase()) reuses the SAME
// underlying sql.js database, so committed rows survive the re-open like on-disk.

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
type DbModule = typeof import('../database');
let BM: BMModule;
let store: StoreModule;
let DB: DbModule;

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

// Seed a LEGACY (pre-workspace) active signed-in origin row WITHOUT a login grant
// — the exact shape a pre-Phase-1 install carried: the workspace-agnostic
// browser_access_signed_in_origins row exists, but browser_access_login_grants is
// empty for it. Inserted via raw SQL so the store's dual-write (which WOULD create
// a grant) is bypassed.
function seedLegacySignedInRow(
  ruleId: string,
  origin: string,
  opts: { workspaceId?: string | null; signedInAt?: number; sessionState?: 'active' | 'expired' } = {},
): void {
  DB.getDb()
    .prepare(
      `INSERT INTO browser_access_signed_in_origins
         (rule_id, origin, workspace_id, signed_in_at, last_used_at, verified_at, session_state, expired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      ruleId,
      origin,
      opts.workspaceId ?? null,
      opts.signedInAt ?? 1000,
      opts.signedInAt ?? 1000,
      opts.signedInAt ?? 1000,
      opts.sessionState ?? 'active',
    );
}

/** Read the raw synthesized grant row (consent_state / session_state / signed_in_at)
 *  for the default workspace key — asserts on migration provenance without ever
 *  touching cookie material (there is none in this table by construction). */
function defaultGrantRow(ruleId: string, origin: string): Record<string, unknown> | undefined {
  return DB.getDb()
    .prepare(
      `SELECT consent_state, session_state, created_at
         FROM browser_access_login_grants
        WHERE rule_id = ? AND workspace_key = 'default' AND origin = ?`,
    )
    .get(ruleId, origin) as Record<string, unknown> | undefined;
}

function grantRowCount(ruleId: string, origin: string): number {
  const row = DB.getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM browser_access_login_grants WHERE rule_id = ? AND origin = ?`,
    )
    .get(ruleId, origin) as { n: number };
  return Number(row.n);
}

// ── Migration (§E line 282) — pre-workspace NULL rule + active signed-in row ───

test('migration: a legacy NULL-workspace active signed-in origin is parked as Setup required under the default key (consent preserved, session NOT active)', () => {
  const origin = 'https://migrate-linkedin.com';
  const rule = store.insertRule({
    hostname: 'migrate-linkedin.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  seedLegacySignedInRow(rule.id, origin, { signedInAt: 4242 });
  // Precondition: the pre-workspace image has NO login grant yet.
  assert.equal(grantRowCount(rule.id, origin), 0, 'precondition: no workspace-exact grant exists before migration');

  // The upgrade synthesis lives inside initDatabase(); re-running it over the same
  // db image IS the migration (INSERT OR IGNORE, idempotent).
  DB.initDatabase();

  const row = defaultGrantRow(rule.id, origin);
  assert.ok(row, 'migration synthesized a login grant under the default workspace key');
  assert.equal(row!.session_state, 'setup_required', 'session parked as setup_required — NEVER a live active session');
  assert.equal(row!.consent_state, 'granted', 'durable consent from the legacy allow_signed_in rule is PRESERVED');
  assert.equal(Number(row!.created_at), 4242, 'the legacy signed_in_at is carried onto the grant created_at (COALESCE(s.signed_in_at, 0))');
});

test('migration: NEVER clones credentials — only ONE grant (default key), no named-workspace grant (Q2)', () => {
  const origin = 'https://migrate-noclone.com';
  const rule = store.insertRule({
    hostname: 'migrate-noclone.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  seedLegacySignedInRow(rule.id, origin);
  DB.initDatabase();

  assert.equal(grantRowCount(rule.id, origin), 1, 'exactly one synthesized grant — the default key, never one-per-workspace');
  assert.equal(
    store.getLoginGrantSessionState(rule.id, origin, 'ws-named'),
    undefined,
    'no grant was cloned into a named workspace — the credentials live only in persist:agent:default',
  );
});

test('migration: a named caller of a migrated legacy origin classifies needs_signin, not ready (P1 red-repro stays killed)', () => {
  const origin = 'https://migrate-named.com';
  const rule = store.insertRule({
    hostname: 'migrate-named.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  seedLegacySignedInRow(rule.id, origin);
  DB.initDatabase();

  const { mgr } = makeManager();
  mgr.invalidateAccessCache();
  assert.equal(
    mgr.classifyOriginState('ws-named', origin),
    'needs_signin',
    'a setup_required default grant must NOT read as ready for a named workspace caller',
  );
  // Even the default workspace itself is only Setup required, never ready, from a
  // migration (a setup_required grant is not active).
  assert.equal(
    mgr.classifyOriginState(null, origin),
    'needs_signin',
    'the default workspace is Setup required too — migration never fabricates a live session',
  );
});

test('migration: an EXPIRED legacy signed-in row is NOT resurrected as a grant (guest is never authenticated success)', () => {
  const origin = 'https://migrate-expired.com';
  const rule = store.insertRule({
    hostname: 'migrate-expired.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  seedLegacySignedInRow(rule.id, origin, { sessionState: 'expired' });
  DB.initDatabase();

  assert.equal(grantRowCount(rule.id, origin), 0, 'an already-expired legacy session is not migrated into a grant');
});

test('migration: a legacy row under a NAMED-workspace rule is left out of the NULL-only synthesis (no default grant fabricated)', () => {
  const origin = 'https://migrate-namedrule.com';
  const rule = store.insertRule({
    hostname: 'migrate-namedrule.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: 'ws-owner',
  });
  seedLegacySignedInRow(rule.id, origin, { workspaceId: 'ws-owner' });
  DB.initDatabase();

  // The synthesis targets workspace_id IS NULL only (legacy wildcard rules). A
  // named-workspace rule's session is (re-)established through the normal runtime
  // setup path, never back-filled into the default key.
  assert.equal(grantRowCount(rule.id, origin), 0, 'the NULL-only synthesis does not fabricate a default grant for a named rule');
});

test('migration: re-running the synthesis never downgrades an already-active grant (idempotent INSERT OR IGNORE)', () => {
  const origin = 'https://migrate-idempotent.com';
  const rule = store.insertRule({
    hostname: 'migrate-idempotent.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  seedLegacySignedInRow(rule.id, origin);
  // A real per-workspace setup already landed an ACTIVE default grant.
  store.upsertLoginGrant(rule.id, origin, null, { signedInAt: 5000, verifiedAt: 5000 });
  assert.equal(store.getLoginGrantSessionState(rule.id, origin, null), 'active', 'precondition: default grant active');

  DB.initDatabase();

  assert.equal(
    store.getLoginGrantSessionState(rule.id, origin, null),
    'active',
    'the migration must not overwrite a live grant with setup_required (INSERT OR IGNORE guards it)',
  );
});

// ── Restart persistence (§E line 283) — durable grant survives a store re-open ──

test('restart: an ACTIVE grant survives a store re-open (re-init over the same db image)', () => {
  const origin = 'https://restart-active.com';
  const rule = store.insertRule({
    hostname: 'restart-active.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  assert.equal(store.getLoginGrantSessionState(rule.id, origin, 'ws-A'), 'active', 'precondition: ws-A active');

  DB.initDatabase(); // models an app restart: fresh db handle over the same "disk"

  assert.equal(
    store.getLoginGrantSessionState(rule.id, origin, 'ws-A'),
    'active',
    'the workspace-exact active grant is durable — it survives the restart',
  );
  const { mgr } = makeManager();
  mgr.invalidateAccessCache();
  assert.equal(mgr.classifyOriginState('ws-A', origin), 'ready', 'ws-A reads ready again after restart');
});

test('restart: an EXPIRED grant stays expired after re-open (a restart never silently re-activates)', () => {
  const origin = 'https://restart-expired.com';
  const rule = store.insertRule({
    hostname: 'restart-expired.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  store.expireLoginGrant(rule.id, origin, 'ws-A'); // a REAL signal expired it (Q7: never a clock)
  assert.equal(store.getLoginGrantSessionState(rule.id, origin, 'ws-A'), 'expired', 'precondition: ws-A expired');

  DB.initDatabase();

  assert.equal(
    store.getLoginGrantSessionState(rule.id, origin, 'ws-A'),
    'expired',
    'an expired grant is durable — the restart does not resurrect it as active',
  );
});

test('restart: a migrated setup_required grant is still Setup required after re-open (never promoted by a restart)', () => {
  const origin = 'https://restart-setup.com';
  const rule = store.insertRule({
    hostname: 'restart-setup.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  seedLegacySignedInRow(rule.id, origin);
  DB.initDatabase(); // migration → setup_required
  assert.equal(defaultGrantRow(rule.id, origin)!.session_state, 'setup_required', 'precondition: migrated to setup_required');

  DB.initDatabase(); // a second restart

  assert.equal(
    defaultGrantRow(rule.id, origin)!.session_state,
    'setup_required',
    'a restart never promotes a Setup-required grant to active — human setup is still required',
  );
});

test('restart: two-workspace independence is durable — ws-A active + ws-B expired both survive with no cross-talk', () => {
  const origin = 'https://restart-independent.com';
  const rule = store.insertRule({
    hostname: 'restart-independent.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true, workspaceId: null,
  });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-A', { signedInAt: 1000, verifiedAt: 1000 });
  store.upsertSignedInOrigin(rule.id, origin, 'ws-B', { signedInAt: 1000, verifiedAt: 1000 });
  store.expireLoginGrant(rule.id, origin, 'ws-B');

  DB.initDatabase();

  assert.equal(store.getLoginGrantSessionState(rule.id, origin, 'ws-A'), 'active', 'ws-A active survives the restart');
  assert.equal(store.getLoginGrantSessionState(rule.id, origin, 'ws-B'), 'expired', 'ws-B expired survives the restart — independent per workspace');
});

test('restart: the run-scoped `unavailable` re-arm latch is in-memory only — a fresh manager after restart holds no latch', () => {
  // A fresh BrowserManager models the post-restart process: signinSessions (the
  // run-scoped registry the re-arm latch lives in) starts empty, so a restart
  // naturally clears any `unavailable` block — the next nav re-pends rather than
  // staying falsely blocked. (The DURABLE grant, by contrast, is what persists.)
  const { mgr } = makeManager();
  const sessions = (mgr as unknown as { signinSessions: Map<string, unknown> }).signinSessions;
  assert.equal(sessions.size, 0, 'a post-restart manager carries no run-scoped signin latch');
});

// ── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-signin-migration-'));
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
  DB = require('../database') as DbModule;
  DB.initDatabase();
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
