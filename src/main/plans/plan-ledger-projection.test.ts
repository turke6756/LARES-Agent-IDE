// WP-D6 focused suite.
//   npm run build:main
//   node dist/main/main/plans/plan-ledger-projection.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PLAN_LEDGER_PROJECTION_CHANNEL, type IpcApi } from '../../shared/types';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

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
  pragma(_sql: string): undefined { return undefined; }
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
          stmt.bind(params); const result: Record<string, unknown>[] = [];
          while (stmt.step()) result.push(stmt.getAsObject());
          return result;
        } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try { const result = fn(...args); this.db.exec('COMMIT'); return result; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
}

type DbModule = typeof import('../database');
type ProjectionModule = typeof import('./plan-ledger-projection');
let dbm: DbModule;
let projectionModule: ProjectionModule;

const WS = 'ws-projection';
const PLAN = 'plan-projection';
const ARTIFACT = 'plan_ce97b9ad';
const PROPOSAL = 'proposal-row';
const PROPOSAL_ARTIFACT = 'prop_1234abcd';
const INTENT = 'int_d1d47a05';
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

function seedPackage(id: string, intentId: string | null, projectionStatus: 'synced' | 'legacy-unmigrated'): void {
  dbm.upsertPlanWorkPackage({
    id, workspaceId: WS, planId: PLAN, intentId, schemaVersion: 2,
    contentHash: `hash-${id}`, projectionStatus, title: id,
    acceptanceCondition: `accept ${id}`, state: 'done', assigneeAgentId: 'agent-1',
    revision: 2, createdAt: id === 'pkg-bound' ? 10 : 20, updatedAt: 100,
  });
}

function seedLedger(): void {
  const db = dbm.getDb();
  db.prepare(
    `INSERT INTO workspaces (id, title, path, path_type)
     VALUES (?, 'Projection workspace', 'C:/projection', 'windows')`,
  ).run(WS);
  db.prepare(
    `INSERT INTO proposals
       (id, workspace_id, path, artifact_id, title, state, created_at, updated_at)
     VALUES (?, ?, '.lares/proposals/source.md', ?, 'Source proposal', 'promoted', 1, 2)`,
  ).run(PROPOSAL, WS, PROPOSAL_ARTIFACT);
  db.prepare(
    `INSERT INTO plans
       (id, workspace_id, path, format, run_state, mtime_ms, size_bytes,
        artifact_id, source_proposal_id, responsible_supervisor_id)
     VALUES (?, ?, '.lares/plans/plan', 'structured', 'executing', 0, 0, ?, ?, NULL)`,
  ).run(PLAN, WS, ARTIFACT, PROPOSAL);
  db.prepare(
    `INSERT INTO plan_intents
       (id, workspace_id, plan_id, plan_artifact_id, intent_id, kind, reason,
        source_doc_rel_path, status, integration_note, first_seen_at, updated_at, last_scanned_at)
     VALUES ('intent-row', ?, ?, ?, ?, 'research', 'why', 'deliberation.md',
             'active', 'folded', 1, 2, 3)`,
  ).run(WS, PLAN, ARTIFACT, INTENT);

  seedPackage('pkg-bound', INTENT, 'synced');
  seedPackage('pkg-legacy', null, 'synced');
  seedPackage('pkg-quarantine', INTENT, 'legacy-unmigrated');
  db.prepare(`INSERT INTO plan_work_package_layout (package_id, sort_order) VALUES ('pkg-bound', 0)`).run();

  db.prepare(
    `INSERT INTO turn_records
       (id, workspace_id, turn_seq, agent_id, session_id, status, plan_id,
        plan_item_id, plan_stamp_source, intent_id)
     VALUES ('turn-confirmed', ?, 1, 'agent-1', 'session-from-turn', 'completed', ?,
             'pkg-bound', 'explicit', ?)`,
  ).run(WS, PLAN, INTENT);
  db.prepare(
    `INSERT INTO plan_dispatch_attempts
       (id, package_id, plan_id, execution_run_id, target_agent_id,
        requested_plan_item_id, confirmed_turn_id, state, created_at, confirmed_at,
        package_revision, orchestration_id, target_session_id, intent_id)
     VALUES ('dispatch-1', 'pkg-bound', ?, 'run-1', 'agent-1', 'pkg-bound',
             'turn-confirmed', 'delivered', 20, 30, 2, 'orch-1', NULL, ?)`,
  ).run(PLAN, INTENT);

  for (const gate of [
    { id: 'gate-failed', attemptNo: 1, outcome: 'failed', at: 40, oid: OID_A },
    { id: 'gate-passed', attemptNo: 2, outcome: 'passed', at: 50, oid: OID_A },
    { id: 'gate-second', attemptNo: 1, outcome: 'passed', at: 60, oid: OID_B },
  ] as const) {
    dbm.insertPlanPackageGateAttempt({
      id: gate.id, workspaceId: WS, planId: PLAN, planArtifactId: ARTIFACT,
      intentId: INTENT, packageId: 'pkg-bound', packageRevision: 2,
      gateKey: gate.id === 'gate-second' ? 'compile' : 'production-entry',
      gateRevision: 1, attemptNo: gate.attemptNo, outcome: gate.outcome,
      finalizationId: null, witnessAgentId: 'gate-agent', witnessSessionId: 'gate-session',
      witnessTurnId: 'turn-confirmed', evidenceJson: JSON.stringify({ gate: gate.id }),
      decidedAt: gate.at, createdAt: gate.at,
    });
    dbm.insertPlanPackageGateCommitLink({
      gateAttemptId: gate.id, repositoryKey: 'repo', commitOid: gate.oid, createdAt: gate.at,
    });
  }
  db.prepare(
    `INSERT INTO commit_records
       (repository_key, commit_oid, parent_oid, observed_at, source, pushed_remote_count)
     VALUES ('repo', ?, NULL, 35, 'lares', 0), ('repo', ?, ?, 55, 'lares', 0)`,
  ).run(OID_A, OID_B, OID_A);

  for (const event of [
    { id: 'deploy-none', state: 'not_deployed', at: 70 },
    { id: 'deploy-done', state: 'deployed', at: 80 },
  ] as const) {
    dbm.insertPlanPackageDeploymentEvent({
      id: event.id, workspaceId: WS, planId: PLAN, packageId: 'pkg-bound',
      packageRevision: 2, environment: 'production', state: event.state,
      repositoryKey: 'repo', commitOid: OID_B, witnessAgentId: 'deploy-agent',
      witnessSessionId: 'deploy-session', detailJson: JSON.stringify({ event: event.id }),
      occurredAt: event.at,
    });
  }
  db.prepare(
    `INSERT INTO plan_wp_lifecycle_events
       (id, package_id, plan_id, from_state, to_state, actor, reason, ts)
     VALUES ('life-executing', 'pkg-bound', ?, 'ready', 'executing', 'dispatcher', NULL, 30),
            ('life-done', 'pkg-bound', ?, 'executing', 'done', 'executor', 'verified', 90)`,
  ).run(PLAN, PLAN);
}

test('renderPlanFromLedger returns every facet while filesystem reads throw', () => {
  const nodeFs = require('node:fs') as Record<string, unknown>;
  const forbidden = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync'] as const;
  const originals = new Map<string, unknown>();
  for (const name of forbidden) {
    originals.set(name, nodeFs[name]);
    nodeFs[name] = () => { throw new Error(`filesystem read forbidden: ${name}`); };
  }
  let rendered;
  try { rendered = projectionModule.renderPlanFromLedger(PLAN); }
  finally { for (const [name, original] of originals) nodeFs[name] = original; }

  assert.ok(rendered);
  assert.equal(rendered.planArtifactId, ARTIFACT);
  assert.deepEqual(rendered.sourceProposal, {
    id: PROPOSAL, artifactId: PROPOSAL_ARTIFACT, title: 'Source proposal', state: 'promoted',
  });
  assert.deepEqual(rendered.packages.map((pkg) => [pkg.id, pkg.bindingState]), [
    ['pkg-bound', 'bound'], ['pkg-legacy', 'legacy-unbound'], ['pkg-quarantine', 'quarantined'],
  ]);
  const pkg = rendered.packages[0];
  assert.equal(pkg.revision, 2);
  assert.equal(pkg.intent?.intentId, INTENT);
  assert.equal(pkg.dispatchAttempts[0].targetAgentId, 'agent-1');
  assert.equal(pkg.dispatchAttempts[0].targetSessionId, 'session-from-turn');
  assert.deepEqual(pkg.gateAttempts.map((gate) => gate.outcome), ['failed', 'passed', 'passed']);
  assert.deepEqual(pkg.commitChain.map((commit) => commit.commitOid), [OID_A, OID_B]);
  assert.deepEqual(pkg.commitChain[0].gateAttemptIds, ['gate-failed', 'gate-passed']);
  assert.deepEqual(pkg.deploymentState, [{ environment: 'production', state: 'deployed' }]);
  assert.deepEqual(pkg.deploymentEvents.map((event) => event.current), [false, true]);
  assert.deepEqual(pkg.stateHistory.map((event) => event.toState), ['executing', 'done']);
});

test('binding completeness is derived from joins and has no stored marker', () => {
  const columns = dbm.getDb().prepare('PRAGMA table_info(plan_work_packages)').all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === 'binding_state'), false);
  assert.equal(projectionModule.renderPlanFromLedger(PLAN)?.packages[0].bindingState, 'bound');
  dbm.getDb().prepare(`DELETE FROM plan_intents WHERE id = 'intent-row'`).run();
  assert.equal(projectionModule.renderPlanFromLedger(PLAN)?.packages[0].bindingState, 'legacy-unbound');
});

test('real registerIpcHandlers mounts and enters the ledger projection channel', () => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, handler: Handler) { handlers.set(channel, handler); },
    on() { /* registration-only fake */ },
  };
  const noop = () => undefined;
  const electronPath = require.resolve('electron');
  const priorElectron = require.cache[electronPath];
  const bridgePath = require.resolve('../ipc-handlers');
  const priorBridge = require.cache[bridgePath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      ipcMain,
      app: { getPath: () => process.cwd(), isPackaged: false, on: noop },
      dialog: { showOpenDialog: noop, showMessageBox: noop },
      shell: { openExternal: noop, trashItem: noop },
      BrowserWindow: class {},
      nativeTheme: { on: noop, themeSource: 'system', shouldUseDarkColors: false },
    },
    children: [], paths: [],
  } as unknown as NodeModule;
  delete require.cache[bridgePath];
  try {
    const bridge = require('../ipc-handlers') as typeof import('../ipc-handlers');
    const supervisor = new Proxy({}, { get: () => noop });
    const mainWindow = new Proxy({
      isDestroyed: () => false,
      webContents: new Proxy({ send: noop }, { get: () => noop }),
    }, { get: (target, property) => property in target
      ? target[property as keyof typeof target] : noop });
    bridge.registerIpcHandlers(
      supervisor as Parameters<typeof bridge.registerIpcHandlers>[0],
      mainWindow as unknown as Parameters<typeof bridge.registerIpcHandlers>[1],
      {} as Parameters<typeof bridge.registerIpcHandlers>[2],
    );
    const handler = handlers.get(PLAN_LEDGER_PROJECTION_CHANNEL);
    assert.ok(handler, 'REACHABILITY:registerIpcHandlers:plan:ledgerProjection');
    assert.equal((handler({}, PLAN) as { planId: string } | null)?.planId, PLAN);
  } finally {
    if (priorElectron) require.cache[electronPath] = priorElectron;
    else delete require.cache[electronPath];
    if (priorBridge) require.cache[bridgePath] = priorBridge;
    else delete require.cache[bridgePath];
  }
});

test('real preload exposes plans.ledgerProjection on the same channel', async () => {
  const invokes: unknown[][] = [];
  let exposed: IpcApi | null = null;
  const electronPath = require.resolve('electron');
  const priorElectron = require.cache[electronPath];
  const preloadPath = require.resolve('../../preload/index');
  const priorPreload = require.cache[preloadPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      contextBridge: { exposeInMainWorld: (_name: string, api: IpcApi) => { exposed = api; } },
      ipcRenderer: {
        invoke: (...args: unknown[]) => { invokes.push(args); return Promise.resolve(null); },
        on: () => undefined,
        removeListener: () => undefined,
      },
      webUtils: { getPathForFile: () => '' },
    },
    children: [], paths: [],
  } as unknown as NodeModule;
  delete require.cache[preloadPath];
  try {
    require('../../preload/index');
    assert.ok(exposed);
    await (exposed as IpcApi).plans.ledgerProjection(PLAN);
    assert.deepEqual(invokes.at(-1), [PLAN_LEDGER_PROJECTION_CHANNEL, PLAN]);
  } finally {
    if (priorElectron) require.cache[electronPath] = priorElectron;
    else delete require.cache[electronPath];
    if (priorPreload) require.cache[preloadPath] = priorPreload;
    else delete require.cache[preloadPath];
  }
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-ledger-projection-'));
  process.env.APPDATA = tmpAppData;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs(); sqlJsCtor = SQL.Database;
  const sqlitePath = require.resolve('better-sqlite3');
  const priorSqlite = require.cache[sqlitePath];
  require.cache[sqlitePath] = {
    id: sqlitePath, filename: sqlitePath, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;
  dbm = require('../database') as DbModule;
  dbm.initDatabase();
  projectionModule = require('./plan-ledger-projection') as ProjectionModule;
  seedLedger();

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }
  if (priorSqlite) require.cache[sqlitePath] = priorSqlite;
  else delete require.cache[sqlitePath];
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
