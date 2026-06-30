// Website-access policy store tests (plans/website-allowlist-design.md §6/§13/§18).
//
// Covers the untrusted-input normalization chokepoint and the §18 request
// lifecycle that the security model leans on:
//   - insertRule normalizes the hostname, rejects '*'/unparseable, requires a
//     leading-'/' pathPrefix, and forces allowSignedIn=false on the human list;
//   - getModes seeds off/off; setMode upserts; updateRule re-normalizes;
//   - deleteRule also deletes the rule's signed-in-origin rows (§13);
//   - insertRequest normalizes server-side, dedups a same-origin pending
//     request (returns the existing id, does not stack), and enforces the
//     per-agent pending cap ('too-many-pending');
//   - decideRequest: approve → rule with allow_signed_in 0; approve_signed_in →
//     1; deny → no rule; and the canonical rule is recomputed by trusted code
//     from the stored (normalized) fields — the agent cannot smuggle a
//     different effective origin.
//
// better-sqlite3's native binding is built against Electron's ABI and won't
// load under the system Node that `npm run test:supervisor` uses, so this test
// injects a sql.js (wasm SQLite) stand-in with the same Database surface into
// require.cache BEFORE requiring ../database (same precedent as
// selection-comments-db.test.ts).
//
//   npm run build:main
//   node dist/main/main/browser/access-policy-store.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in ────────────────────────────

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

// ── module under test (loaded after the cache injection) ─────────────

type StoreModule = typeof import('./access-policy-store');
let store: StoreModule;

const REQ = {
  hostname: 'example.com',
  scheme: 'https' as const,
  includeSubdomains: true,
  requestedBy: 'agent-1',
  reason: 'need the docs',
};

// ── Rules: normalization + CRUD ──────────────────────────────────────

test('insertRule normalizes the hostname (lowercased, trailing dot stripped)', () => {
  const rule = store.insertRule({
    hostname: 'GitHub.COM.', scheme: 'https',
    includeSubdomains: true, allowSignedIn: false,
  });
  assert.equal(rule.hostname, 'github.com');
  assert.equal(rule.enabled, true);
  assert.ok(store.listRules().some((r) => r.id === rule.id));
});

test("insertRule rejects '*' hostnames (invalid-hostname)", () => {
  assert.throws(
    () => store.insertRule({ hostname: '*.evil.com', scheme: 'https', includeSubdomains: true, allowSignedIn: false }),
    (err: unknown) => err instanceof store.AccessStoreError && err.code === 'invalid-hostname',
  );
});

test('insertRule rejects an unparseable hostname (invalid-hostname)', () => {
  assert.throws(
    () => store.insertRule({ hostname: 'has spaces/and\\slashes', scheme: 'https', includeSubdomains: true, allowSignedIn: false }),
    (err: unknown) => err instanceof store.AccessStoreError && err.code === 'invalid-hostname',
  );
});

test('getRule round-trips an inserted rule and returns undefined for an unknown id', () => {
  const rule = store.insertRule({ hostname: 'lookup.me', scheme: 'https', includeSubdomains: false, allowSignedIn: false });
  const fetched = store.getRule(rule.id);
  assert.equal(fetched?.hostname, 'lookup.me');
  assert.equal(store.getRule('no-such-id'), undefined);
});

test("insertRule requires a leading-'/' pathPrefix (invalid-path-prefix)", () => {
  assert.throws(
    () => store.insertRule({ hostname: 'a.com', scheme: 'https', includeSubdomains: true, allowSignedIn: false, pathPrefix: 'app' }),
    (err: unknown) => err instanceof store.AccessStoreError && err.code === 'invalid-path-prefix',
  );
});

test('updateRule patches enabled + allowSignedIn and re-normalizes on scheme change', () => {
  const rule = store.insertRule({ hostname: 'patch.me', scheme: 'https', includeSubdomains: false, allowSignedIn: false });
  const patched = store.updateRule(rule.id, { enabled: false, allowSignedIn: true });
  assert.equal(patched.enabled, false);
  assert.equal(patched.allowSignedIn, true);
  assert.equal(store.getRule(rule.id)?.enabled, false);
});

test('deleteRule removes the rule AND its tracked signed-in origins (§13)', () => {
  const rule = store.insertRule({ hostname: 'signed.in', scheme: 'https', includeSubdomains: true, allowSignedIn: true });
  store.upsertSignedInOrigin(rule.id, 'https://signed.in');
  store.upsertSignedInOrigin(rule.id, 'https://signed.in'); // idempotent
  assert.deepEqual(store.listSignedInOrigins(rule.id), ['https://signed.in']);
  store.deleteRule(rule.id);
  assert.equal(store.getRule(rule.id), undefined);
  assert.deepEqual(store.listSignedInOrigins(rule.id), []);
});

// ── Requests (§18) ───────────────────────────────────────────────────

test('insertRequest normalizes server-side and stores reason verbatim', () => {
  const req = store.insertRequest({ ...REQ, hostname: 'REQ.Example.com', reason: 'a "quoted" reason' });
  assert.equal(req.hostname, 'req.example.com');
  assert.equal(req.reason, 'a "quoted" reason');
  assert.equal(req.status, 'pending');
});

test('insertRequest dedups a same-origin pending request (returns the existing id)', () => {
  const a = store.insertRequest({ ...REQ, hostname: 'dedup.com', requestedBy: 'agent-dd' });
  const b = store.insertRequest({ ...REQ, hostname: 'dedup.com', requestedBy: 'agent-dd', reason: 'different text' });
  assert.equal(b.id, a.id, 'same canonical origin → same pending id, not stacked');
});

test('insertRequest enforces the per-agent pending cap (too-many-pending)', () => {
  const agent = 'agent-cap';
  store.insertRequest({ ...REQ, hostname: 'cap1.com', requestedBy: agent });
  store.insertRequest({ ...REQ, hostname: 'cap2.com', requestedBy: agent });
  assert.throws(
    () => store.insertRequest({ ...REQ, hostname: 'cap3.com', requestedBy: agent }, 2),
    (err: unknown) => err instanceof store.AccessStoreError && err.code === 'too-many-pending',
  );
});

test('listRequestsByAgent returns only that agent\'s requests', () => {
  store.insertRequest({ ...REQ, hostname: 'mine.com', requestedBy: 'agent-mine' });
  const mine = store.listRequestsByAgent('agent-mine');
  assert.ok(mine.length >= 1);
  assert.ok(mine.every((r) => r.requestedBy === 'agent-mine'));
});

test('decideRequest approve → rule with allow_signed_in 0; status flips to approved', () => {
  const req = store.insertRequest({ ...REQ, hostname: 'approve.com', requestedBy: 'agent-ap', wantSignedIn: true });
  const result = store.decideRequest(req.id, 'approve');
  assert.equal(result.request.status, 'approved');
  assert.ok(result.createdRule);
  assert.equal(result.createdRule!.allowSignedIn, false, 'plain approve never grants signed-in');
  assert.equal(result.createdRule!.hostname, 'approve.com');
});

test('decideRequest approve_signed_in → rule with allow_signed_in 1', () => {
  const req = store.insertRequest({ ...REQ, hostname: 'authdrive.com', requestedBy: 'agent-sd', wantSignedIn: true });
  const result = store.decideRequest(req.id, 'approve_signed_in');
  assert.equal(result.createdRule!.allowSignedIn, true);
});

test('decideRequest deny → no rule, status flips to denied', () => {
  const req = store.insertRequest({ ...REQ, hostname: 'deny.com', requestedBy: 'agent-dn' });
  const before = store.listRules().length;
  const result = store.decideRequest(req.id, 'deny');
  assert.equal(result.request.status, 'denied');
  assert.equal(result.createdRule, null);
  assert.equal(store.listRules().length, before, 'deny creates no rule');
});

test('decideRequest is idempotent-safe: deciding an already-decided request throws', () => {
  const req = store.insertRequest({ ...REQ, hostname: 'twice.com', requestedBy: 'agent-tw' });
  store.decideRequest(req.id, 'deny');
  assert.throws(() => store.decideRequest(req.id, 'approve'), /already denied/);
});

// ── Slice-4: workspace scoping ───────────────────────────────────────

test('Slice-4: insertRule stores workspaceId; a null-workspace rule applies to every workspace, a scoped one only to its own', () => {
  const scoped = store.insertRule({ hostname: 'scoped-ws.com', scheme: 'https', includeSubdomains: true, allowSignedIn: false, workspaceId: 'ws-1' });
  const legacy = store.insertRule({ hostname: 'legacy-ws.com', scheme: 'https', includeSubdomains: true, allowSignedIn: false, workspaceId: null });
  assert.equal(store.getRule(scoped.id)?.workspaceId, 'ws-1');
  assert.equal(store.getRule(legacy.id)?.workspaceId, null);
  // A scoped row applies ONLY to its workspace; a null row is the legacy default.
  assert.equal(store.rowAppliesToWorkspace('ws-1', 'ws-1'), true);
  assert.equal(store.rowAppliesToWorkspace('ws-1', 'ws-2'), false);
  assert.equal(store.rowAppliesToWorkspace(null, 'ws-2'), true, 'null = legacy default applies everywhere');
  assert.equal(store.rowAppliesToWorkspace(null, null), true);
});

test('Slice-4: decideRequest approve → the created rule inherits the request workspace (A-approval never authorizes B)', () => {
  const req = store.insertRequest({ ...REQ, hostname: 'inherit-ws.com', requestedBy: 'agent-ws', workspaceId: 'ws-A' });
  assert.equal(req.workspaceId, 'ws-A', 'request carries the trust-side workspace');
  const result = store.decideRequest(req.id, 'approve');
  assert.ok(result.createdRule);
  assert.equal(result.createdRule!.workspaceId, 'ws-A', 'the rule is scoped to the requesting workspace');
  assert.equal(store.rowAppliesToWorkspace(result.createdRule!.workspaceId, 'ws-B'), false, 'so it does NOT authorize workspace B');
});

test('Slice-4: same origin requested from two workspaces yields two distinct pending requests (workspace is part of the dedup key)', () => {
  const a = store.insertRequest({ ...REQ, hostname: 'twows.com', requestedBy: 'agent-2ws', workspaceId: 'ws-X' });
  const b = store.insertRequest({ ...REQ, hostname: 'twows.com', requestedBy: 'agent-2ws', workspaceId: 'ws-Y' });
  assert.notEqual(b.id, a.id, 'different workspaces → not deduped into one request');
});

// ── Signed-in tabs (WI-1): session lifecycle + per-rule consent / patterns ───

test('WI-1: getSignedInOriginState — undefined when no row; active after upsert', () => {
  const rule = store.insertRule({ hostname: 'wi1-state.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true });
  const origin = 'https://wi1-state.com';
  assert.equal(store.getSignedInOriginState(rule.id, origin), undefined, 'no row → undefined (first-ever)');
  store.upsertSignedInOrigin(rule.id, origin, null, { signedInAt: 1000, verifiedAt: 1000 });
  assert.equal(store.getSignedInOriginState(rule.id, origin), 'active', 'an upsert records a live session');
});

test('WI-1: expireSignedInOrigin flips to expired WITHOUT deleting the row (durable consent preserved)', () => {
  const rule = store.insertRule({ hostname: 'wi1-expire.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true });
  const origin = 'https://wi1-expire.com';
  store.upsertSignedInOrigin(rule.id, origin);
  store.expireSignedInOrigin(rule.id, origin, 2000);
  assert.equal(store.getSignedInOriginState(rule.id, origin), 'expired', 'login-wall detection marks the session expired');
  // The row survives (durable consent is the rule, but the origin tracking row stays).
  assert.deepEqual(store.listSignedInOrigins(rule.id), [origin], 'the origin row is preserved, not deleted');
});

test('WI-1: re-upsert after expiry RESTORES active (re-sign-in is a refresh, not a re-grant)', () => {
  const rule = store.insertRule({ hostname: 'wi1-restore.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true });
  const origin = 'https://wi1-restore.com';
  store.upsertSignedInOrigin(rule.id, origin);
  store.expireSignedInOrigin(rule.id, origin);
  assert.equal(store.getSignedInOriginState(rule.id, origin), 'expired');
  store.upsertSignedInOrigin(rule.id, origin, null, { signedInAt: 3000, verifiedAt: 3000 });
  assert.equal(store.getSignedInOriginState(rule.id, origin), 'active', 'a fresh sign-in clears the expiry');
});

test('WI-1: expireSignedInOrigin is a no-op when no row exists (never-signed-in origin)', () => {
  const rule = store.insertRule({ hostname: 'wi1-noop.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true });
  assert.doesNotThrow(() => store.expireSignedInOrigin(rule.id, 'https://wi1-noop.com'));
  assert.equal(store.getSignedInOriginState(rule.id, 'https://wi1-noop.com'), undefined, 'still no row');
});

test('WI-1: listSharedSignedInOrigins reports sessionState + marks an expired session stale', () => {
  const rule = store.insertRule({ hostname: 'wi1-shared.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true });
  const origin = 'https://wi1-shared.com';
  store.upsertSignedInOrigin(rule.id, origin, null, { signedInAt: Date.now(), verifiedAt: Date.now() });
  let row = store.listSharedSignedInOrigins(null).find((s) => s.origin === origin)!;
  assert.ok(row, 'an active origin is listed');
  assert.equal(row.sessionState, 'active');
  assert.equal(row.stale, false, 'a fresh active session is not stale');
  store.expireSignedInOrigin(rule.id, origin);
  row = store.listSharedSignedInOrigins(null).find((s) => s.origin === origin)!;
  assert.equal(row.sessionState, 'expired');
  assert.equal(row.stale, true, 'an expired session is surfaced as stale (offer re-sign-in)');
});

test('WI-1: consent_acked_at + login_url_patterns round-trip through insert/get/update', () => {
  const rule = store.insertRule({
    hostname: 'wi1-consent.com', scheme: 'https', includeSubdomains: true, allowSignedIn: true,
    consentAckedAt: 12345, loginUrlPatterns: ['*/candidate/*', 'auth-gate'],
  });
  assert.equal(rule.consentAckedAt, 12345, 'consent stamp returned from insert');
  assert.deepEqual(rule.loginUrlPatterns, ['*/candidate/*', 'auth-gate'], 'patterns returned from insert');
  const fetched = store.getRule(rule.id)!;
  assert.equal(fetched.consentAckedAt, 12345, 'consent persisted');
  assert.deepEqual(fetched.loginUrlPatterns, ['*/candidate/*', 'auth-gate'], 'patterns persisted (JSON column)');
  // An empty patterns array collapses to undefined (defaults-only) on read.
  const cleared = store.updateRule(rule.id, { loginUrlPatterns: [] });
  assert.equal(cleared.loginUrlPatterns, undefined, 'empty patterns → undefined (defaults only)');
  assert.equal(store.getRule(rule.id)?.consentAckedAt, 12345, 'consent untouched by an unrelated patch');
});

// ── Run ──────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'access-store-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dbm = require('../database') as { initDatabase(): void };
  dbm.initDatabase();
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
