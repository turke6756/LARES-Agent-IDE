// WP-C: strict work-package parsing, responsibility, race retry, and restart idempotence.
//
//   npm run build:main
//   node dist/main/main/plans/plan-work-package-ingest.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

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
  pragma(_sql: string): unknown { return undefined; }
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
          stmt.bind(params); const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
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
type IngestModule = typeof import('./plan-work-package-ingest');
type WatcherModule = typeof import('./plan-folder-watcher');
let dbm: DbModule;
let ingest: IngestModule;
let watcher: WatcherModule;
let root: string;
let seq = 0;

type PackageSpec = {
  id: string; order: number; title: string; initial_state: 'ready' | 'blocked';
  acceptance_conditions: string[];
  paths: Array<{ path: string; intent_kind?: 'create' | 'edit' | 'delete' | 'verify' }>;
  depends_on: string[];
};

function spec(over: Partial<PackageSpec> = {}): PackageSpec {
  return {
    id: 'WP-A', order: 10, title: 'Package A', initial_state: 'ready',
    acceptance_conditions: ['A works.'], paths: [{ path: 'src/a.ts', intent_kind: 'edit' }],
    depends_on: [], ...over,
  };
}

function document(packages: PackageSpec[], over: { artifactId?: string; jsonText?: string } = {}): string {
  const artifactId = over.artifactId ?? 'plan_fixture';
  const projection = over.jsonText ?? JSON.stringify({ schema_version: 1,
    plan_artifact_id: artifactId, packages }, null, 2);
  const prose = packages.map((pkg) => `## ${pkg.id} - ${pkg.title}\n\n**Accept**\n- fixture`).join('\n\n');
  return `---\nplan_artifact_id: ${artifactId}\nkind: work-packages\n---\n\n`
    + `<!--PLAN-WORK-PACKAGES:v1\n${projection}\n-->\n\n${prose}\n`;
}

function context() {
  seq += 1;
  const workspacePath = path.join(root, `ws-${seq}`);
  const folderAbs = path.join(workspacePath, '.lares', 'plans', `plan-${seq}`);
  fs.mkdirSync(path.join(folderAbs, 'supplements'), { recursive: true });
  const workspace = dbm.createWorkspace({ title: `ws-${seq}`, path: workspacePath, pathType: 'windows' });
  const artifactId = `plan_fixture_${seq}`;
  const plan = dbm.createOrRevivePlan({ workspaceId: workspace.id,
    path: `.lares/plans/plan-${seq}/plan.md`, format: 'structured', runState: 'hardening' });
  return { workspace, plan, folderAbs, folderRelPath: `.lares/plans/plan-${seq}`, artifactId };
}

function writeManifest(ctx: ReturnType<typeof context>, events: unknown[] = []): void {
  fs.writeFileSync(path.join(ctx.folderAbs, 'plan.json'), JSON.stringify({
    schema_version: 1, plan_artifact_id: ctx.artifactId, plan_sku: `plan-${seq}`,
    responsibility_events: events,
  }, null, 2));
}

function writePackages(ctx: ReturnType<typeof context>, packages: PackageSpec[], suffix = ''): string {
  const abs = path.join(ctx.folderAbs, 'supplements', 'work-packages.md');
  fs.writeFileSync(abs, document(packages, { artifactId: ctx.artifactId }) + suffix);
  return abs;
}

function reconcile(ctx: ReturnType<typeof context>, over: Record<string, unknown> = {}) {
  return ingest.reconcilePlanFolderPlanningState({ workspaceId: ctx.workspace.id,
    planId: ctx.plan.id, folderAbs: ctx.folderAbs, folderRelPath: ctx.folderRelPath,
    now: () => 10_000 + seq, ...over });
}

function raw(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  return dbm.getDb().prepare(sql).all(...params) as Record<string, unknown>[];
}

test('valid projection has casing-stable ids and distinct content/projection hashes', () => {
  const a = spec();
  const b = spec({ id: 'WP-B', order: 20, title: 'Package B', initial_state: 'blocked',
    paths: [], depends_on: [] });
  const first = ingest.parsePlanWorkPackageDocument(document([a, b]), 'plan_fixture');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.projection.packages[0].id, 'wp:plan_fixture:wp-a');
  assert.match(first.projection.packages[0].contentHash, /^[a-f0-9]{64}$/);
  const casing = ingest.parsePlanWorkPackageDocument(document([{ ...a, id: 'wp-a' },
    b]), 'plan_fixture');
  assert.equal(casing.ok, true);
  if (!casing.ok) return;
  assert.equal(casing.projection.packages[0].id, first.projection.packages[0].id);
  assert.equal(casing.projection.packages[0].contentHash, first.projection.packages[0].contentHash);

  const reordered = ingest.parsePlanWorkPackageDocument(document([
    { ...a, order: 20 }, { ...b, order: 10 },
  ]), 'plan_fixture');
  assert.equal(reordered.ok, true);
  if (!reordered.ok) return;
  const firstA = first.projection.packages.find((pkg) => pkg.sourceLocalId === 'WP-A')!;
  const reorderedA = reordered.projection.packages.find((pkg) => pkg.sourceLocalId === 'WP-A')!;
  assert.equal(firstA.contentHash, reorderedA.contentHash, 'order is excluded from content digest');
  assert.notEqual(first.projection.projectionHash, reordered.projection.projectionHash,
    'order is included in projection digest');
});

test('strict parser rejects duplicate/unknown keys, comments, traversal, dependencies, and prose drift', () => {
  const good = spec();
  const cases: Array<[string, string, string]> = [
    ['duplicate JSON key', document([good], { jsonText: '{"schema_version":1,"schema_version":1,"plan_artifact_id":"plan_fixture","packages":[]}' }), 'json-invalid'],
    ['unknown key', document([{ ...good, extra: true } as PackageSpec]), 'package-invalid'],
    ['comment', document([good], { jsonText: '{"schema_version":1,//x\n"plan_artifact_id":"plan_fixture","packages":[]}' }), 'json-invalid'],
    ['traversal', document([{ ...good, paths: [{ path: '../escape.ts' }] }]), 'package-invalid'],
    ['future dependency', document([good, spec({ id: 'WP-B', order: 5, depends_on: ['WP-A'] })]), 'dependency-invalid'],
    ['duplicate frontmatter', document([good]).replace('kind: work-packages', 'kind: work-packages\nkind: work-packages'), 'frontmatter-invalid'],
  ];
  for (const [label, body, code] of cases) {
    const parsed = ingest.parsePlanWorkPackageDocument(body, 'plan_fixture');
    assert.equal(parsed.ok, false, label);
    if (!parsed.ok) assert.equal(parsed.diagnostics[0].code, code, label);
  }
  const drift = document([good]).replace('## WP-A - Package A', '## WP-A - Different');
  const parsed = ingest.parsePlanWorkPackageDocument(drift, 'plan_fixture');
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.diagnostics[0].code, 'prose-mismatch');
});

test('the plan dogfood work-package document satisfies the frozen parser contract', () => {
  const abs = path.join(process.cwd(), '.lares', 'plans',
    '2026-08-05-bridge-the-proposal-to-plan-skill-and-the-planni-e0001372',
    'supplements', '2026-08-05-work-packages.md');
  const parsed = ingest.parsePlanWorkPackageDocument(fs.readFileSync(abs, 'utf8'), 'plan_e0001372',
    'supplements/2026-08-05-work-packages.md');
  assert.equal(parsed.ok, true, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics));
  if (parsed.ok) assert.equal(parsed.projection.packages.length, 11);
});

test('one source race retries and a second race fails closed without applying', () => {
  const ctx = context(); writeManifest(ctx); const source = writePackages(ctx, [spec()]);
  let calls = 0;
  const result = reconcile(ctx, { beforeSourceRestat: (attempt: number) => {
    calls += 1;
    if (attempt === 0) fs.writeFileSync(source, document([spec({ title: 'Retried package' })], { artifactId: ctx.artifactId }) + '\nchanged');
  } });
  assert.equal(result.workPackages.status, 'synced');
  assert.equal(calls, 2);
  assert.equal(dbm.listManagedPlanWorkPackages(ctx.plan.id)[0].package.title, 'Retried package');

  const ctx2 = context(); writeManifest(ctx2); const source2 = writePackages(ctx2, [spec()]);
  const failed = reconcile(ctx2, { beforeSourceRestat: (attempt: number) => {
    fs.appendFileSync(source2, `\nrace-${attempt}`);
  } });
  assert.equal(failed.workPackages.status, 'invalid');
  assert.equal(failed.workPackages.diagnostics[0].code, 'source-raced');
  assert.equal(dbm.listManagedPlanWorkPackages(ctx2.plan.id).length, 0);
});

test('missing and malformed replacements preserve rows; valid omission tombstones only omitted planning rows', () => {
  const ctx = context(); writeManifest(ctx);
  const a = spec(); const b = spec({ id: 'WP-B', order: 20, title: 'Package B', depends_on: ['WP-A'] });
  const source = writePackages(ctx, [a, b]);
  assert.equal(reconcile(ctx).workPackages.status, 'synced');
  fs.unlinkSync(source);
  assert.equal(reconcile(ctx).workPackages.status, 'conflict');
  assert.equal(dbm.listManagedPlanWorkPackages(ctx.plan.id).filter((row) => row.source.present).length, 2);
  fs.writeFileSync(source, document([a, b], { artifactId: ctx.artifactId }).replace('"schema_version": 1', '"schema_version": 2'));
  assert.equal(reconcile(ctx).workPackages.status, 'invalid');
  assert.equal(dbm.listManagedPlanWorkPackages(ctx.plan.id).filter((row) => row.source.present).length, 2);
  const durableDiagnostics = JSON.parse(dbm.getPlanFolderProjectionState(ctx.plan.id)!.wpDiagnosticsJson) as Array<{ code: string }>;
  assert.equal(durableDiagnostics[0].code, 'identity-mismatch');
  writePackages(ctx, [a]);
  assert.equal(reconcile(ctx).workPackages.status, 'synced');
  const rows = dbm.listManagedPlanWorkPackages(ctx.plan.id);
  assert.equal(rows.find((row) => row.source.sourceLocalId === 'WP-A')?.source.present, true);
  assert.equal(rows.find((row) => row.source.sourceLocalId === 'WP-B')?.source.present, false);
});

test('last assigned array entry wins without timestamp sorting and never assigns active plan', () => {
  const ctx = context();
  const sup1 = dbm.createAgent({ workspaceId: ctx.workspace.id, title: 'Sup 1', roleDescription: '',
    workingDirectory: ctx.workspace.path, command: 'x', isSupervisor: true,
    tmuxSessionName: null, autoRestartEnabled: false, logPath: 'l' });
  const sup2 = dbm.createAgent({ workspaceId: ctx.workspace.id, title: 'Sup 2', roleDescription: '',
    workingDirectory: ctx.workspace.path, command: 'x', privilegeLane: 'supervisor',
    tmuxSessionName: null, autoRestartEnabled: false, logPath: 'l' });
  writeManifest(ctx, [
    { event_id: 'first', event: 'assigned', agent_id: sup1.id, at: 9999 },
    { event_id: 'last', event: 'assigned', agent_id: sup2.id, at: 1 },
  ]);
  writePackages(ctx, [spec()]);
  const result = reconcile(ctx);
  assert.equal(result.responsibility.status, 'valid');
  assert.equal(result.responsibility.supervisorId, sup2.id);
  assert.equal(raw('SELECT responsible_supervisor_id FROM plans WHERE id = ?', [ctx.plan.id])[0].responsible_supervisor_id, sup2.id);
  assert.equal(raw('SELECT * FROM supervisor_active_plan WHERE plan_id = ?', [ctx.plan.id]).length, 0,
    'boot/order reconciliation never assigns active attention');
});

test('invalid latest assignment clears stale authority independently while valid WP ingest proceeds', () => {
  const ctx = context();
  const sup = dbm.createAgent({ workspaceId: ctx.workspace.id, title: 'Sup', roleDescription: '',
    workingDirectory: ctx.workspace.path, command: 'x', isSupervisor: true,
    tmuxSessionName: null, autoRestartEnabled: false, logPath: 'l' });
  writeManifest(ctx, [{ event_id: 'good', event: 'assigned', agent_id: sup.id }]);
  writePackages(ctx, [spec()]); reconcile(ctx);
  dbm.getDb().prepare('INSERT INTO supervisor_active_plan (supervisor_id, plan_id) VALUES (?, ?)').run(sup.id, ctx.plan.id);
  writeManifest(ctx, [
    { event_id: 'good', event: 'assigned', agent_id: sup.id },
    { event_id: 'bad', event: 'assigned', agent_id: 'missing-agent' },
  ]);
  const result = reconcile(ctx);
  assert.equal(result.responsibility.status, 'invalid');
  assert.equal(result.workPackages.status, 'synced');
  assert.equal(raw('SELECT responsible_supervisor_id FROM plans WHERE id = ?', [ctx.plan.id])[0].responsible_supervisor_id, null);
  assert.equal(raw('SELECT * FROM supervisor_active_plan WHERE supervisor_id = ?', [sup.id]).length, 0);
  const state = dbm.getPlanFolderProjectionState(ctx.plan.id)!;
  assert.equal(state.responsibilityStatus, 'invalid');
  assert.equal((JSON.parse(state.responsibilityDetail!) as { code: string }).code, 'assignee-invalid');
  assert.equal(state.wpStatus, 'synced');
});

test('responsibility rejects same-workspace non-supervisors and cross-workspace supervisors', () => {
  const ctx = context(); writePackages(ctx, [spec()]);
  const worker = dbm.createAgent({ workspaceId: ctx.workspace.id, title: 'Worker', roleDescription: '',
    workingDirectory: ctx.workspace.path, command: 'x', tmuxSessionName: null,
    autoRestartEnabled: false, logPath: 'l' });
  writeManifest(ctx, [{ event_id: 'worker', event: 'assigned', agent_id: worker.id }]);
  assert.equal(reconcile(ctx).responsibility.status, 'invalid');

  const foreignWorkspace = dbm.createWorkspace({ title: 'foreign', path: path.join(root, `foreign-${seq}`), pathType: 'windows' });
  const foreignSupervisor = dbm.createAgent({ workspaceId: foreignWorkspace.id, title: 'Foreign', roleDescription: '',
    workingDirectory: foreignWorkspace.path, command: 'x', isSupervisor: true,
    tmuxSessionName: null, autoRestartEnabled: false, logPath: 'l' });
  writeManifest(ctx, [{ event_id: 'foreign', event: 'assigned', agent_id: foreignSupervisor.id }]);
  assert.equal(reconcile(ctx).responsibility.status, 'invalid');
});

test('moving responsibility clears only the prior pointer when it targets this plan', () => {
  const ctx = context();
  const prior = dbm.createAgent({ workspaceId: ctx.workspace.id, title: 'Prior', roleDescription: '',
    workingDirectory: ctx.workspace.path, command: 'x', isSupervisor: true,
    tmuxSessionName: null, autoRestartEnabled: false, logPath: 'l' });
  const next = dbm.createAgent({ workspaceId: ctx.workspace.id, title: 'Next', roleDescription: '',
    workingDirectory: ctx.workspace.path, command: 'x', isSupervisor: true,
    tmuxSessionName: null, autoRestartEnabled: false, logPath: 'l' });
  writeManifest(ctx, [{ event_id: 'one', event: 'assigned', agent_id: prior.id }]);
  writePackages(ctx, [spec()]); reconcile(ctx);
  const other = dbm.createOrRevivePlan({ workspaceId: ctx.workspace.id, path: 'plans/other.md', format: 'md' });
  dbm.getDb().prepare('INSERT INTO supervisor_active_plan (supervisor_id, plan_id) VALUES (?, ?)').run(prior.id, other.id);
  writeManifest(ctx, [{ event_id: 'two', event: 'assigned', agent_id: next.id }]);
  reconcile(ctx);
  assert.equal(raw('SELECT plan_id FROM supervisor_active_plan WHERE supervisor_id = ?', [prior.id])[0].plan_id, other.id);
  assert.equal(raw('SELECT * FROM supervisor_active_plan WHERE supervisor_id = ?', [next.id]).length, 0);
});

test('repeated refresh and simulated restart are idempotent', () => {
  const ctx = context(); writeManifest(ctx); writePackages(ctx, [spec()]);
  reconcile(ctx); reconcile(ctx);
  assert.equal(raw('SELECT * FROM plan_work_packages WHERE plan_id = ?', [ctx.plan.id]).length, 1);
  assert.equal(raw('SELECT * FROM plan_work_package_sources WHERE plan_id = ?', [ctx.plan.id]).length, 1);
  assert.equal(raw('SELECT * FROM plan_wp_lifecycle_events WHERE plan_id = ?', [ctx.plan.id]).length, 0);
  assert.equal(dbm.getPlanWorkPackage(`wp:${ctx.artifactId}:wp-a`)?.revision, 1);
  reconcile(ctx); // a fresh watcher process calls the same service on boot
  assert.equal(dbm.getPlanWorkPackage(`wp:${ctx.artifactId}:wp-a`)?.revision, 1);
});

test('watcher boot/change and explicit single-folder refresh share one projection outcome', async () => {
  seq += 1;
  const workspacePath = path.join(root, `watcher-ws-${seq}`);
  const folderRelPath = `.lares/plans/watcher-plan-${seq}`;
  const folderAbs = path.join(workspacePath, ...folderRelPath.split('/'));
  fs.mkdirSync(path.join(folderAbs, 'supplements'), { recursive: true });
  const workspace = dbm.createWorkspace({ title: `watcher-${seq}`, path: workspacePath, pathType: 'windows' });
  const artifactId = `plan_watcher_${seq}`;
  fs.writeFileSync(path.join(folderAbs, 'plan.json'), JSON.stringify({
    schema_version: 1, plan_artifact_id: artifactId, plan_sku: `watcher-plan-${seq}`,
    responsibility_events: [],
  }));
  fs.writeFileSync(path.join(folderAbs, 'plan.md'), '# watcher\n');
  const source = path.join(folderAbs, 'supplements', 'work-packages.md');
  fs.writeFileSync(source, document([spec()], { artifactId }));

  const bootWatcher = new watcher.PlanFolderWatcher();
  const boot = await bootWatcher.reconcileWorkspace(workspace, true);
  const planId = boot.settled[0].planId;
  assert.equal(dbm.getPlanFolderProjectionState(planId)?.wpStatus, 'synced');
  assert.equal(dbm.getPlanWorkPackage(`wp:${artifactId}:wp-a`)?.revision, 1);

  fs.writeFileSync(source, document([spec({ title: 'Changed through watcher' })], { artifactId }) + '\nchanged');
  await bootWatcher.reconcileWorkspace(workspace, false);
  assert.equal(dbm.getPlanWorkPackage(`wp:${artifactId}:wp-a`)?.title, 'Changed through watcher');
  assert.equal(dbm.getPlanWorkPackage(`wp:${artifactId}:wp-a`)?.revision, 2);

  const manual = await watcher.adoptPlanFolder(workspace, folderRelPath);
  assert.equal(manual.adopted, true);
  assert.equal(manual.planId, planId);
  assert.equal(dbm.getPlanWorkPackage(`wp:${artifactId}:wp-a`)?.revision, 2,
    'explicit refresh is idempotent after watcher convergence');

  const restartedWatcher = new watcher.PlanFolderWatcher();
  await restartedWatcher.reconcileWorkspace(workspace, true);
  assert.equal(dbm.getPlanWorkPackage(`wp:${artifactId}:wp-a`)?.revision, 2,
    'boot restart converges without another semantic revision');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-ingest-appdata-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-ingest-workspaces-'));
  process.env.APPDATA = tmpAppData;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true,
    exports: FakeBetterSqlite } as unknown as NodeJS.Module;
  dbm = require('../database') as DbModule;
  dbm.initDatabase();
  ingest = require('./plan-work-package-ingest') as IngestModule;
  watcher = require('./plan-folder-watcher') as WatcherModule;

  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
