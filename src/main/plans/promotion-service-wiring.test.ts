// WP-P3-wire acceptance — the ASSEMBLED promotion service reaches plan-ipc.
//
// WP-P3C′ left `proposal:promote` rejecting honestly until the wiring lane injects
// a production service via `providePromotionService`. This proves the seam is
// closed end-to-end:
//   1. Injection seam: BEFORE injection the registered `proposal:promote` handler
//      rejects with `promotion-service-unavailable`; AFTER injection it passes that
//      guard and reaches the (server-side) supervisor revalidation — proof the
//      module-injected service feeds the real registered handler.
//   2. Full round-trip: the DEPS-BOUND WP-P3B-core `promoteProposal` (real durable
//      de-dup over `promotion_requests`, fake leaf seams) drives `runPromoteProposal`
//      and its `PromoteResult` maps to the renderer `PromoteProposalResult`.
//
// INTENTIONALLY not registered in scripts/run-main-tests.mjs (P3Z owns that
// registry). Run the compiled test directly:
//   npm run build:main
//   node dist/main/main/plans/promotion-service-wiring.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (promote-proposal.core.test precedent) ─
type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean; step(): boolean;
    getAsObject(): Record<string, unknown>; free(): boolean;
  };
};
let sqlJsCtor: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
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
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; }
        finally { stmt.free(); }
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
      try { const r = fn(...args); this.db.exec('COMMIT'); return r; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let dbm: any;
let promoteMod: any;
let planIpc: any;
let wsId = '';

const SUP = 'sup-1';

function proposalRef(): any {
  return { proposalId: 'prop-row-1', artifactId: 'prop_wire01', relPath: '.lares/proposals/2026-08-03-wire.md', workspaceId: wsId };
}

/** Capture the handlers `registerPromotionIpc` registers on a fake ipcMain. */
function captureHandlers(): { handlers: Record<string, (...a: any[]) => any> } {
  const handlers: Record<string, (...a: any[]) => any> = {};
  planIpc.registerPromotionIpc({ handle(channel: string, listener: any) { handlers[channel] = listener; } });
  return { handlers };
}

/** Build the REAL deps-bound service: WP-P3B-core `promoteProposal` with fake leaf
 *  seams (resolveProposal / scanClaims=none / deliverer / injected dispatch /
 *  enrich) but the REAL durable `promotion_requests` de-dup underneath. */
function assembledService(over: { scan?: any; dispatchResult?: any } = {}): any {
  const resolveProposal = (_id: string) => proposalRef();
  const deps = {
    resolveProposal,
    scanClaims: async () => over.scan ?? { kind: 'none' },
    deliverer: {
      async launchAgent() { throw new Error('deliverer.launchAgent must not run — dispatch is injected'); },
      async sendInputConfirmed() { return { delivered: true, confirmed: true, mode: 'hook' as const }; },
      resubmitEnter() { /* n/a */ },
    },
    enrichAdoptedPlan: async (input: any) => ({ planId: input.planId }),
    // Inject the crash-safe dispatch so no live launch/DB-orchestration is needed —
    // the front half (claim-scan → durable de-dup → branch) is what we are wiring.
    dispatch: async () => over.dispatchResult ?? { runId: 'promrun-wire', agentId: 'agent-wire', delivered: false },
  };
  return {
    promote: (input: { proposalId: string; supervisorId: string }) => promoteMod.promoteProposal(input, deps),
    resolveProposal,
  };
}

// ── cases ────────────────────────────────────────────────────────────────────

test('injection seam: the registered proposal:promote handler rejects until providePromotionService, then reaches revalidation', async () => {
  const { handlers } = captureHandlers();

  // Not injected → honest "unavailable".
  planIpc.providePromotionService(null);
  await assert.rejects(
    () => handlers['proposal:promote']({}, { proposalId: 'prop-row-1', supervisorId: SUP }),
    /unavailable/i,
    'rejects honestly while the service is unwired',
  );

  // Injected → passes the unavailable guard, resolves the proposal, then rejects at
  // the SERVER-side supervisor revalidation (no such agent row) — proof the injected
  // service is what the real handler now drives.
  planIpc.providePromotionService(assembledService());
  await assert.rejects(
    () => handlers['proposal:promote']({}, { proposalId: 'prop-row-1', supervisorId: 'ghost' }),
    (err: any) => err && err.code === 'promote-supervisor-rejected',
    'past the unavailable guard, into revalidation — the injected service is live',
  );
});

test('full round-trip: assembled promoteProposal → runPromoteProposal maps to promotion-pending (real durable de-dup)', async () => {
  const service = assembledService();
  // Drive the plan-ipc core directly with the assembled service + fake ipc-layer db
  // seams (a privileged same-workspace supervisor). This is the outermost injectable
  // seam: `runPromoteProposal` IS the `proposal:promote` core.
  const deps = {
    service,
    getAgent: (id: string) => (id === SUP ? ({ id: SUP, workspaceId: wsId, isSupervisor: true } as any) : null),
    getPlan: () => null,
    getPlanByWorkspaceArtifactId: () => null,
    getPromotionRequestById: (id: string) => dbm.getPromotionRequestById(id),
  };

  const result = await planIpc.runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: SUP }, deps);
  assert.equal(result.status, 'promotion-pending', 'no folder yet → the assembled front half returns pending');
  assert.ok(result.promotionRequestId, 'carries the durable promotion_requests id');
  assert.equal(result.planArtifactId, promoteMod.derivePlanArtifactId('prop_wire01'),
    'the deterministic plan artifact id (claim-scan found no manual claimant)');

  // The durable row actually exists — the assembled service reached the DB de-dup.
  const row = dbm.getPromotionRequestById(result.promotionRequestId);
  assert.ok(row, 'a real promotion_requests row was minted');
  assert.equal(row.state, 'pending');

  // A REPEAT promote reflects the SAME operation (durable de-dup) — mints nothing new.
  const again = await planIpc.runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: SUP }, deps);
  assert.equal(again.status, 'promotion-pending');
  assert.equal(again.promotionRequestId, result.promotionRequestId, 'same request — no second worker');
});

test('non-privileged supervisor is rejected server-side before any mint', async () => {
  const service = assembledService();
  const deps = {
    service,
    getAgent: (id: string) => (id === 'worker-x' ? ({ id: 'worker-x', workspaceId: wsId, isSupervisor: false } as any) : null),
    getPlan: () => null,
    getPlanByWorkspaceArtifactId: () => null,
    getPromotionRequestById: (id: string) => dbm.getPromotionRequestById(id),
  };
  await assert.rejects(
    () => planIpc.runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: 'worker-x' }, deps),
    (err: any) => err && err.code === 'promote-supervisor-rejected',
    'a non-supervisor is rejected before the service is even consulted',
  );
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-wiring-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database');
  promoteMod = require('./promote-proposal');
  planIpc = require('./plan-ipc');
  dbm.initDatabase();
  wsId = dbm.createWorkspace({ title: 'promotion-wiring-ws', path: 'C:\\tmp\\ws', pathType: 'windows' }).id;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
