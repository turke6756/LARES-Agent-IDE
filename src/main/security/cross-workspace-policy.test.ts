// WP0 (plans/cross-workspace-collaboration.md — "WP0 — Policy primitives,
// fail-closed + single-token credential propagation, audit") — unit tests for the
// two cross-workspace authorizers on ApiServer plus the cross_workspace_audit
// round-trip.
//
// Two independent concerns in one file (per the plan's "WP0 tests" bullet):
//   1. authorizeCrossWorkspace / authorizeAgentTarget matrices:
//      {undefined, supervisor, worker, researcher} × {no explicit, own, foreign}
//      → allow/deny + the EXACT machine-readable code on a denial.
//   2. recordCrossWorkspaceAudit / getCrossWorkspaceAudit: insert/query round-trip,
//      denials recorded, message CONTENTS never stored (only length), and `detail`
//      reduced to the fixed key allowlist.
//
// The helpers touch no DB, so they run against a plain ApiServer instance (no
// start()). The audit half needs the real database accessors, so — like
// database.active-agents.test.ts — a sql.js stand-in is injected into
// require.cache BEFORE ./database is first required (better-sqlite3's native
// binding is Electron-ABI). Everything is therefore require()d in the runner,
// after the injection, rather than statically imported.
//
//   npm run build:main
//   node dist/main/main/security/cross-workspace-policy.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CapabilityClaim } from './agent-capabilities';
import type { Agent } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (database.active-agents.test.ts precedent) ──

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

// ── modules under test (loaded in the runner, after the cache injection) ──────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let apiServer: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbm: any;

const OWN = 'ws-own';
const FOREIGN = 'ws-foreign';

const claim = (lane: CapabilityClaim['privilegeLane'], workspaceId = OWN): CapabilityClaim =>
  ({ agentId: `a-${lane}`, workspaceId, privilegeLane: lane });

const targetAgent = (workspaceId: string): Agent =>
  ({ id: 'target', workspaceId } as unknown as Agent);

/** Assert the call throws an Error carrying the expected statusCode + code. */
function assertThrowsCode(fn: () => unknown, statusCode: number, code: string): void {
  assert.throws(fn, (err: any) => {
    assert.equal(err.statusCode, statusCode, `statusCode: got ${err.statusCode}`);
    assert.equal(err.code, code, `code: got ${err.code}`);
    return true;
  });
}

// ── authorizeCrossWorkspace matrix ────────────────────────────────────────────

test('authorizeCrossWorkspace: global bearer (undefined) is trusted for every explicit scope', () => {
  for (const explicit of [null, OWN, FOREIGN]) {
    const r = apiServer.authorizeCrossWorkspace(undefined, explicit);
    assert.deepEqual(r, { trusted: true, scope: explicit, actor: null });
  }
});

test('authorizeCrossWorkspace: supervisor reaches its own and (crucially) foreign', () => {
  const cap = claim('supervisor');
  assert.deepEqual(apiServer.authorizeCrossWorkspace(cap, null), { trusted: false, scope: OWN, actor: cap });
  assert.deepEqual(apiServer.authorizeCrossWorkspace(cap, OWN), { trusted: false, scope: OWN, actor: cap });
  assert.deepEqual(apiServer.authorizeCrossWorkspace(cap, FOREIGN), { trusted: false, scope: FOREIGN, actor: cap });
});

test('authorizeCrossWorkspace: worker/researcher may reach self but foreign → 403 cross-workspace-requires-supervisor', () => {
  for (const lane of ['worker', 'researcher'] as const) {
    const cap = claim(lane);
    assert.deepEqual(apiServer.authorizeCrossWorkspace(cap, null), { trusted: false, scope: OWN, actor: cap });
    assert.deepEqual(apiServer.authorizeCrossWorkspace(cap, OWN), { trusted: false, scope: OWN, actor: cap });
    assertThrowsCode(() => apiServer.authorizeCrossWorkspace(cap, FOREIGN), 403, 'cross-workspace-requires-supervisor');
  }
});

// ── authorizeAgentTarget matrix ───────────────────────────────────────────────

test('authorizeAgentTarget: global bearer (undefined) is trusted for own and foreign targets', () => {
  for (const ws of [OWN, FOREIGN]) {
    const r = apiServer.authorizeAgentTarget(undefined, targetAgent(ws));
    assert.deepEqual(r, { trusted: true, actor: null });
  }
});

test('authorizeAgentTarget: supervisor may target own and foreign agents', () => {
  const cap = claim('supervisor');
  assert.deepEqual(apiServer.authorizeAgentTarget(cap, targetAgent(OWN)), { trusted: false, actor: cap });
  assert.deepEqual(apiServer.authorizeAgentTarget(cap, targetAgent(FOREIGN)), { trusted: false, actor: cap });
});

test('authorizeAgentTarget: worker/researcher target own OK, foreign → 403 cross-workspace-target-forbidden', () => {
  for (const lane of ['worker', 'researcher'] as const) {
    const cap = claim(lane);
    assert.deepEqual(apiServer.authorizeAgentTarget(cap, targetAgent(OWN)), { trusted: false, actor: cap });
    assertThrowsCode(() => apiServer.authorizeAgentTarget(cap, targetAgent(FOREIGN)), 403, 'cross-workspace-target-forbidden');
  }
});

// ── cross_workspace_audit round-trip ──────────────────────────────────────────

test('audit: an OK success round-trips through insert → query', () => {
  dbm.recordCrossWorkspaceAudit({
    operation: 'list_agents',
    actorAgentId: 'sup-1', actorWorkspaceId: OWN, actorLane: 'supervisor',
    targetWorkspaceId: FOREIGN, outcome: 'ok',
    detail: { code: 'ok' },
  });
  const rows = dbm.getCrossWorkspaceAudit({ workspaceId: FOREIGN });
  const row = rows.find((r: any) => r.operation === 'list_agents');
  assert.ok(row, 'the inserted row is queryable by target workspace');
  assert.equal(row.actorLane, 'supervisor');
  assert.equal(row.actorWorkspaceId, OWN);
  assert.equal(row.targetWorkspaceId, FOREIGN);
  assert.equal(row.outcome, 'ok');
  assert.deepEqual(row.detail, { code: 'ok' });
  assert.ok(typeof row.ts === 'number' && row.ts > 0, 'ts is a positive epoch ms');
});

test('audit: a DENIED attempt is recorded (not just successes)', () => {
  dbm.recordCrossWorkspaceAudit({
    operation: 'revive',
    actorAgentId: 'w-1', actorWorkspaceId: OWN, actorLane: 'worker',
    targetAgentId: 'victim', targetWorkspaceId: FOREIGN,
    outcome: 'denied:cross-workspace-target-forbidden',
    detail: { code: 'cross-workspace-target-forbidden' },
  });
  const rows = dbm.getCrossWorkspaceAudit({ workspaceId: FOREIGN });
  const denial = rows.find((r: any) => r.outcome.startsWith('denied:'));
  assert.ok(denial, 'the denied attempt is stored');
  assert.equal(denial.operation, 'revive');
  assert.equal(denial.actorLane, 'worker');
});

test('audit: message CONTENTS are never stored — only queued_message_len', () => {
  const secret = 'the actual private message body that must never persist';
  dbm.recordCrossWorkspaceAudit({
    operation: 'send_message',
    actorAgentId: 'sup-1', actorWorkspaceId: OWN, actorLane: 'supervisor',
    targetAgentId: 't', targetWorkspaceId: FOREIGN,
    queuedMessageLen: secret.length, outcome: 'ok',
    // A caller passing a wider object must NOT be able to smuggle the body through:
    detail: { body: secret, message: secret, code: 'ok' } as any,
  });
  const rows = dbm.getCrossWorkspaceAudit({ workspaceId: FOREIGN });
  const row = rows.find((r: any) => r.operation === 'send_message');
  assert.ok(row);
  assert.equal(row.queuedMessageLen, secret.length, 'length is recorded');
  // The whole stored row, serialized, must not contain the secret text.
  assert.ok(!JSON.stringify(row).includes(secret), 'no message content anywhere in the stored row');
});

test('audit: detail is reduced to the fixed key allowlist (code/gate/successorId/provider)', () => {
  dbm.recordCrossWorkspaceAudit({
    operation: 'revive',
    actorWorkspaceId: OWN, actorLane: 'global-bearer',
    targetAgentId: 'sup-b', targetWorkspaceId: FOREIGN,
    outcome: 'error:revive-live-successor',
    detail: {
      code: 'revive-live-successor', gate: 'proceed', successorId: 'sup-c', provider: 'claude',
      // These non-allowlisted keys must be dropped:
      rawError: 'C:\\Users\\secret\\path exploded', stack: 'Error: ...', internalIp: '10.0.0.9',
    } as any,
  });
  const rows = dbm.getCrossWorkspaceAudit({ workspaceId: FOREIGN });
  const row = rows.find((r: any) => r.outcome === 'error:revive-live-successor');
  assert.ok(row);
  assert.deepEqual(
    row.detail,
    { code: 'revive-live-successor', gate: 'proceed', successorId: 'sup-c', provider: 'claude' },
    'only the four allowlisted keys survive',
  );
  assert.ok(!JSON.stringify(row).includes('secret'), 'a raw path/error never reaches storage');
});

test('audit: getCrossWorkspaceAudit filters by sinceTs and orders newest-first', () => {
  const before = dbm.getCrossWorkspaceAudit({ limit: 1000 });
  // Newest-first: the most recent inserts are at the head.
  for (let i = 1; i < before.length; i++) {
    assert.ok(before[i - 1].ts >= before[i].ts, 'rows are ordered by ts DESC');
  }
  const future = dbm.getCrossWorkspaceAudit({ sinceTs: Date.now() + 60_000 });
  assert.equal(future.length, 0, 'a future lower-bound excludes all existing rows');
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  // Keep initDatabase's mkdir off the real APPDATA profile.
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-ws-policy-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database');
  dbm.initDatabase();

  // A plain ApiServer instance — the two authorizers touch no DB, so no start().
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ApiServer } = require('../api-server');
  const stubSupervisor = { getContextStats: () => null, isInputInFlight: () => false };
  apiServer = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');

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
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
