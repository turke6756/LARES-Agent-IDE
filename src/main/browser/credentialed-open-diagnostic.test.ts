// Phase 0 (BrowserSigninSharing plan §D) — credentialed-open DIAGNOSTIC exercise.
//
// This file PASSES against current code on purpose: it validates the Phase 0
// INSTRUMENTATION that is delivered in this same change (the pure
// `classifyCredentialedOpen` classifier), not a future fix. It is the
// acceptance-gate proof that a single diagnostic can distinguish the SIX
// situations the plan calls out, and it names which FIELD distinguishes each:
//
//   1. visit-only guest      → grantState === 'visit_only'
//   2. wrong-partition guest  → grantState === 'wrong_partition'   (partitionMatch === false)
//   3. false-active import    → grantState === 'false_active_import' (activation === 'cookie_import_unverified')
//   4. true active session    → grantState === 'active'
//   5. expired session        → grantState === 'expired'          (sessionState === 'expired')
//   6. unattended rejection   → grantState === 'unattended_rejected' / desiredOutcome === 'unavailable'
//
// `legacyReady` on states 2 and 3 is TRUE while `desiredOutcome` is
// 'needs_signin' — that gap is the live defect the browser-signin-repro.test.ts
// reproductions assert against, and that Phase 1/2 will close.
//
// It is intentionally NOT registered in package.json `test:supervisor` yet — the
// whole browser-signin suite is wired into the supervisor chain in Phase 1.
//
//   npm run build:main
//   node dist/main/main/browser/credentialed-open-diagnostic.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (so requiring ../database resolves) ──
// The classifier under test is PURE (no getDb), but requiring access-policy-store
// pulls in ../database, whose better-sqlite3 native binding won't load under the
// system Node this test runs on. Same injection precedent as
// access-policy-store.test.ts.

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
    return (...args: A) => { this.db.exec('BEGIN'); try { const r = fn(...args); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } };
  }
}

type StoreModule = typeof import('./access-policy-store');
let store: StoreModule;

// Partition strings as agentPartitionForWorkspace() would derive them.
const DEFAULT_PARTITION = 'persist:agent:default';
const NAMED_PARTITION = 'persist:agent:ws-named';

// ── 1. visit-only guest ──────────────────────────────────────────────────────

test('visit-only guest → grantState visit_only, desiredOutcome ready (no allow_signed_in rule governs)', () => {
  const d = store.classifyCredentialedOpen({
    ruleId: null,
    ruleWorkspaceId: null,
    callerWorkspaceId: 'ws-named',
    credentialHomePartition: NAMED_PARTITION,
    callerSessionPartition: NAMED_PARTITION,
    sessionState: 'none',
  });
  assert.equal(d.grantState, 'visit_only');
  assert.equal(d.desiredOutcome, 'ready');
});

// ── 2. wrong-partition guest (the PRIMARY defect) ────────────────────────────

test('wrong-partition guest → grantState wrong_partition; partitionMatch false; legacyReady true but desiredOutcome needs_signin', () => {
  const d = store.classifyCredentialedOpen({
    ruleId: 'rule-null',
    ruleWorkspaceId: null,                       // legacy wildcard rule
    callerWorkspaceId: 'ws-named',
    credentialHomePartition: DEFAULT_PARTITION,  // creds imported into persist:agent:default
    callerSessionPartition: NAMED_PARTITION,     // researcher reads persist:agent:ws-named
    sessionState: 'active',
  });
  assert.equal(d.grantState, 'wrong_partition', 'grantState is the distinguishing field');
  assert.equal(d.partitionMatch, false, 'partitionMatch=false distinguishes it from a true active session');
  assert.equal(d.legacyReady, true, 'the CURRENT classifier reports ready (the defect)');
  assert.equal(d.desiredOutcome, 'needs_signin', 'post-fix it must NOT be ready');
});

// ── 3. false-active import (the SECONDARY defect) ────────────────────────────

test('false-active import → grantState false_active_import; activation distinguishes it from a verified active session', () => {
  const d = store.classifyCredentialedOpen({
    ruleId: 'rule-scoped',
    ruleWorkspaceId: 'ws-named',
    callerWorkspaceId: 'ws-named',
    credentialHomePartition: NAMED_PARTITION,    // partition MATCHES — isolates the provenance defect
    callerSessionPartition: NAMED_PARTITION,
    sessionState: 'active',
    activation: 'cookie_import_unverified',
  });
  assert.equal(d.grantState, 'false_active_import');
  assert.equal(d.partitionMatch, true, 'same partition — so partitionMatch does NOT explain this one; activation does');
  assert.equal(d.activation, 'cookie_import_unverified', 'the activation field distinguishes false-active from true-active');
  assert.equal(d.legacyReady, true);
  assert.equal(d.desiredOutcome, 'needs_signin');
});

// ── 4. true active session ───────────────────────────────────────────────────

test('true active session → grantState active, desiredOutcome ready (right partition + verified sign-in)', () => {
  const d = store.classifyCredentialedOpen({
    ruleId: 'rule-scoped',
    ruleWorkspaceId: 'ws-named',
    callerWorkspaceId: 'ws-named',
    credentialHomePartition: NAMED_PARTITION,
    callerSessionPartition: NAMED_PARTITION,
    sessionState: 'active',
    activation: 'interactive_verified',
  });
  assert.equal(d.grantState, 'active');
  assert.equal(d.desiredOutcome, 'ready');
  assert.equal(d.legacyReady, true);
});

// ── 5. expired session ───────────────────────────────────────────────────────

test('expired session → grantState expired; sessionState distinguishes it; needs_signin', () => {
  const d = store.classifyCredentialedOpen({
    ruleId: 'rule-scoped',
    ruleWorkspaceId: 'ws-named',
    callerWorkspaceId: 'ws-named',
    credentialHomePartition: NAMED_PARTITION,
    callerSessionPartition: NAMED_PARTITION,
    sessionState: 'expired',
  });
  assert.equal(d.grantState, 'expired');
  assert.equal(d.sessionState, 'expired', 'sessionState=expired is the distinguishing field');
  assert.equal(d.desiredOutcome, 'needs_signin');
  assert.equal(d.legacyReady, false, 'an expired row is not legacy-ready either');
});

// ── 6. unattended rejection ──────────────────────────────────────────────────

test('unattended rejection → grantState unattended_rejected; desiredOutcome unavailable (needs human, none present)', () => {
  const d = store.classifyCredentialedOpen({
    ruleId: 'rule-scoped',
    ruleWorkspaceId: 'ws-named',
    callerWorkspaceId: 'ws-named',
    credentialHomePartition: NAMED_PARTITION,
    callerSessionPartition: NAMED_PARTITION,
    sessionState: 'none',
    unattended: true,
  });
  assert.equal(d.grantState, 'unattended_rejected', 'grantState collapses a needs-human state under unattended');
  assert.equal(d.desiredOutcome, 'unavailable', 'desiredOutcome=unavailable is the distinguishing field');
  assert.equal(d.unattended, true);
});

// ── the six are mutually distinct ────────────────────────────────────────────

test('all six situations map to DISTINCT grantState/outcome signatures', () => {
  const sig = (d: ReturnType<StoreModule['classifyCredentialedOpen']>) =>
    `${d.grantState}|${d.desiredOutcome}|${d.partitionMatch}|${d.activation}|${d.sessionState}`;
  const six = [
    store.classifyCredentialedOpen({ ruleId: null, ruleWorkspaceId: null, callerWorkspaceId: 'w', credentialHomePartition: NAMED_PARTITION, callerSessionPartition: NAMED_PARTITION, sessionState: 'none' }),
    store.classifyCredentialedOpen({ ruleId: 'r', ruleWorkspaceId: null, callerWorkspaceId: 'w', credentialHomePartition: DEFAULT_PARTITION, callerSessionPartition: NAMED_PARTITION, sessionState: 'active' }),
    store.classifyCredentialedOpen({ ruleId: 'r', ruleWorkspaceId: 'w', callerWorkspaceId: 'w', credentialHomePartition: NAMED_PARTITION, callerSessionPartition: NAMED_PARTITION, sessionState: 'active', activation: 'cookie_import_unverified' }),
    store.classifyCredentialedOpen({ ruleId: 'r', ruleWorkspaceId: 'w', callerWorkspaceId: 'w', credentialHomePartition: NAMED_PARTITION, callerSessionPartition: NAMED_PARTITION, sessionState: 'active', activation: 'interactive_verified' }),
    store.classifyCredentialedOpen({ ruleId: 'r', ruleWorkspaceId: 'w', callerWorkspaceId: 'w', credentialHomePartition: NAMED_PARTITION, callerSessionPartition: NAMED_PARTITION, sessionState: 'expired' }),
    store.classifyCredentialedOpen({ ruleId: 'r', ruleWorkspaceId: 'w', callerWorkspaceId: 'w', credentialHomePartition: NAMED_PARTITION, callerSessionPartition: NAMED_PARTITION, sessionState: 'none', unattended: true }),
  ];
  const sigs = new Set(six.map(sig));
  assert.equal(sigs.size, 6, `all six diagnostic signatures are distinct, got: ${[...sigs].join(' ;; ')}`);
});

// ── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-diag-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;

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
