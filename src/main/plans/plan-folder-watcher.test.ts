// WP-P2B-folder — structured plan-folder ingest.
//   npm run build:main
//   node dist/main/main/plans/plan-folder-watcher.test.js
//
// Proves the acceptance items: two roots enumerated independently; state-dir home
// ensured on init; nested plan.md/output edits trigger a settled callback (a
// depth:0 root-only watch would fail this); late-validity picked up; over-cap
// folder still updates + surfaces `degraded-watch`; idempotent adopt by
// plan_artifact_id; NO author_* write (schema-checked); child-sub set tracked +
// removals reported; duplicate/malformed per policy; no P2L import.
//
// NOT registered in scripts/run-main-tests.mjs here — the stage-end gate (P2Z)
// owns that edit.
//
// Uses the sql.js-backed better-sqlite3 fake (mirrors plan-gallery.test) so the
// REAL database + plan-folder-watcher modules run against a live schema, plus a
// real temp workspace on disk for the fs-backed folder ingest.

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
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};

let sqlJsCtor: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  static lastPath = '';
  private db: SqlJsDatabase;

  constructor(dbPath = ':memory:') {
    FakeBetterSqlite.lastPath = dbPath;
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
  private static store(): SqlJsDatabase {
    const s = FakeBetterSqlite.stores.get(FakeBetterSqlite.lastPath);
    if (!s) throw new Error('no store for last path');
    return s;
  }
  static rawAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = FakeBetterSqlite.store().prepare(sql);
    try {
      stmt.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }
}

// ── Types mirrored off the real modules (structural) ─────────────────────────
type StructuredPlanRow = {
  id: string; workspaceId: string; artifactId: string | null; folderRelPath: string | null;
  path: string; format: string; runState: string | null; mtimeMs: number; sizeBytes: number;
  deletedAt: string | null;
};
type Plan = { id: string; workspaceId: string; deletedAt: string | null };

type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  getPlanByWorkspaceArtifactId(workspaceId: string, artifactId: string): StructuredPlanRow | null;
  getPlans(filters?: { workspaceId?: string; includeDeleted?: boolean }): Plan[];
};

type FolderChangeKind = 'boot' | 'adopted' | 'changed';
type PlanFolderDiagnostic = { kind: string; workspaceId: string; relPath: string; otherRelPath?: string; detail: string };
type FolderReconcileResult = {
  settled: Array<{ planId: string; folderRelPath: string; changeKind: FolderChangeKind }>;
  watchable: string[]; overCap: string[]; removed: string[]; diagnostics: PlanFolderDiagnostic[];
};
type Ws = { id: string; path: string; pathType: string };

type WatcherModule = {
  PlanFolderWatcher: new (opts?: {
    onPlanFolderSettled?: (planId: string, folderRelPath: string, changeKind: FolderChangeKind) => void | Promise<void>;
    now?: () => number; childSubCap?: number;
  }) => {
    reconcileWorkspace(ws: Ws, isBoot: boolean): Promise<FolderReconcileResult>;
    plansHome(ws: Ws): string;
    adoptedFoldersForTests(workspaceId: string): string[];
  };
  validatePlanFolder(folderAbs: string): { valid: boolean; reason?: string; planArtifactId?: string };
  computeFolderSignature(folderAbs: string): number;
  DEFAULT_FOLDER_CHILD_SUB_CAP: number;
  PLAN_FOLDER_OUTPUT_SUBDIRS: readonly string[];
};

let dbm: DbModule;
let wm: WatcherModule;
let wsRoot = '';
let ws: Ws;

/** Full per-test isolation: a fresh on-disk workspace (empty state-dir plans
 *  home) AND a fresh workspace row, so no folder or `plans` row bleeds across
 *  cases. The shared runner state (one DB, one temp APPDATA) is untouched;
 *  `getPlans`/`getPlanByWorkspaceArtifactId` are workspace-scoped, so a new
 *  ws.id starts from zero rows. */
function freshWorkspace(): void {
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pfw-ws-'));
  fs.mkdirSync(path.join(wsRoot, '.lares', 'plans'), { recursive: true });
  ws = {
    id: dbm.createWorkspace({ title: 'ws', path: wsRoot, pathType: 'windows' }).id,
    path: wsRoot,
    pathType: 'windows',
  };
}

// ── Fixture helpers ──────────────────────────────────────────────────────────
function plansHomeAbs(): string { return path.join(wsRoot, '.lares', 'plans'); }
function folderAbsOf(sku: string): string { return path.join(plansHomeAbs(), sku); }
function relOf(sku: string): string { return `.lares/plans/${sku}`; }

/** Write a §R0-shaped plan folder. `artifactId` defaults to `plan_<sku>`; pass
 *  `planJson:'malformed'` for an unterminated blob, or omit `planMd`. */
function writeFolder(sku: string, opts: {
  artifactId?: string; planJson?: string | Record<string, unknown> | 'malformed'; planMd?: string | null; mtimeMs?: number;
} = {}): string {
  const abs = folderAbsOf(sku);
  fs.mkdirSync(abs, { recursive: true });
  let body: string;
  if (opts.planJson === 'malformed') body = '{ this is not : json';
  else if (typeof opts.planJson === 'string') body = opts.planJson;
  else body = JSON.stringify({
    schema_version: 1,
    plan_artifact_id: opts.artifactId ?? `plan_${sku}`,
    plan_sku: sku,
    ...(opts.planJson ?? {}),
  });
  fs.writeFileSync(path.join(abs, 'plan.json'), body);
  if (opts.planMd !== null) fs.writeFileSync(path.join(abs, 'plan.md'), opts.planMd ?? `# ${sku}\n`);
  if (opts.mtimeMs !== undefined) touchAll(abs, opts.mtimeMs);
  return relOf(sku);
}

/** Force mtimes under a folder so signature changes are deterministic. */
function touchAll(dirAbs: string, mtimeMs: number): void {
  const t = mtimeMs / 1000;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { fs.utimesSync(p, t, t); } catch { /* ignore */ } }
    }
  };
  walk(dirAbs);
}

function newWatcher(opts: { childSubCap?: number; settled?: any[] } = {}) {
  const settled = opts.settled;
  return new wm.PlanFolderWatcher({
    childSubCap: opts.childSubCap,
    onPlanFolderSettled: settled ? (id, rel, kind) => { settled.push([id, rel, kind]); } : undefined,
  });
}

function planRowCount(): number {
  return dbm.getPlans({ workspaceId: ws.id, includeDeleted: true }).length;
}

// ── Pure validators ───────────────────────────────────────────────────────────
test('validatePlanFolder classifies valid / absent / malformed / no-artifact-id', () => {
  writeFolder('v-ok');
  assert.equal(wm.validatePlanFolder(folderAbsOf('v-ok')).valid, true);

  fs.mkdirSync(folderAbsOf('v-stray'), { recursive: true }); // no plan.json
  assert.deepEqual(wm.validatePlanFolder(folderAbsOf('v-stray')), { valid: false, reason: 'absent' });

  writeFolder('v-bad', { planJson: 'malformed' });
  assert.equal(wm.validatePlanFolder(folderAbsOf('v-bad')).reason, 'malformed');

  writeFolder('v-noid', { planJson: { plan_artifact_id: '' } as any });
  assert.equal(wm.validatePlanFolder(folderAbsOf('v-noid')).reason, 'no-artifact-id');
});

test('computeFolderSignature rises when a nested output file is added/edited', () => {
  const sku = 'sig-1';
  writeFolder(sku, { mtimeMs: 1_000_000 });
  const s0 = wm.computeFolderSignature(folderAbsOf(sku));
  // Add a deliberation output with a later mtime.
  const delib = path.join(folderAbsOf(sku), 'deliberations');
  fs.mkdirSync(delib, { recursive: true });
  const out = path.join(delib, 'd1.md');
  fs.writeFileSync(out, '# out\n');
  fs.utimesSync(out, 5_000_000 / 1000, 5_000_000 / 1000);
  const s1 = wm.computeFolderSignature(folderAbsOf(sku));
  assert.ok(s1 > s0, `nested edit bumps signature (${s0} → ${s1})`);
});

// ── Adopt behavior ─────────────────────────────────────────────────────────────
test('a valid folder is adopted as a structured/hardening row keyed by plan_artifact_id', async () => {
  const rel = writeFolder('2026-08-03-adopt-aaaa');
  const settled: any[] = [];
  const res = await newWatcher({ settled }).reconcileWorkspace(ws, false);

  const row = dbm.getPlanByWorkspaceArtifactId(ws.id, 'plan_2026-08-03-adopt-aaaa')!;
  assert.ok(row, 'row adopted');
  assert.equal(row.format, 'structured');
  assert.equal(row.runState, 'hardening');
  assert.equal(row.folderRelPath, rel);
  assert.equal(row.path, `${rel}/plan.md`);
  assert.equal(row.deletedAt, null);
  assert.ok(res.settled.some((s) => s.planId === row.id && s.changeKind === 'adopted'));
  assert.deepEqual(settled[0], [row.id, rel, 'adopted']);
  assert.deepEqual(res.watchable, [rel]);
});

test('adopt is idempotent by plan_artifact_id — no duplicate row, no re-settle when unchanged', async () => {
  writeFolder('idem-bbbb', { mtimeMs: 2_000_000 });
  const w = newWatcher();
  await w.reconcileWorkspace(ws, false);
  const first = dbm.getPlanByWorkspaceArtifactId(ws.id, 'plan_idem-bbbb')!;
  const before = planRowCount();

  const settled: any[] = [];
  const w2 = newWatcher({ settled });
  const res2 = await w2.reconcileWorkspace(ws, false);
  const second = dbm.getPlanByWorkspaceArtifactId(ws.id, 'plan_idem-bbbb')!;
  assert.equal(second.id, first.id, 'same plan id (idempotent)');
  assert.equal(planRowCount(), before, 'no duplicate row');
  assert.equal(settled.length, 0, 'no settle on an unchanged re-scan');
  assert.equal(res2.settled.length, 0);
});

test('a nested output edit fires a settled(changed) callback (depth:0 root watch would miss it)', async () => {
  const rel = writeFolder('nested-cccc', { mtimeMs: 3_000_000 });
  const settled: any[] = [];
  const w = newWatcher({ settled });
  await w.reconcileWorkspace(ws, false); // adopt (settled: 'adopted') + seed prior signature
  const row = dbm.getPlanByWorkspaceArtifactId(ws.id, 'plan_nested-cccc')!;
  settled.length = 0;

  // Edit a NESTED output with a later mtime; plan.md itself is untouched.
  const delib = path.join(folderAbsOf('nested-cccc'), 'deliberations');
  fs.mkdirSync(delib, { recursive: true });
  const out = path.join(delib, 'run1.md');
  fs.writeFileSync(out, '# result\n');
  fs.utimesSync(out, 9_000_000 / 1000, 9_000_000 / 1000);

  await w.reconcileWorkspace(ws, false); // signature moved ⇒ 'changed'
  assert.deepEqual(settled, [[row.id, rel, 'changed']]);
});

test('late-validity: a dir without plan.json is skipped, then adopted once plan.json appears', async () => {
  const sku = 'late-dddd';
  fs.mkdirSync(folderAbsOf(sku), { recursive: true });
  fs.writeFileSync(path.join(folderAbsOf(sku), 'plan.md'), '# not yet\n');
  const w = newWatcher();
  const r1 = await w.reconcileWorkspace(ws, false);
  assert.equal(dbm.getPlanByWorkspaceArtifactId(ws.id, `plan_${sku}`), null, 'not adopted without plan.json');
  assert.ok(!r1.watchable.includes(relOf(sku)));

  // plan.json arrives (rename-event OR periodic reconciliation covers this).
  fs.writeFileSync(
    path.join(folderAbsOf(sku), 'plan.json'),
    JSON.stringify({ schema_version: 1, plan_artifact_id: `plan_${sku}`, plan_sku: sku }),
  );
  const r2 = await w.reconcileWorkspace(ws, false);
  assert.ok(dbm.getPlanByWorkspaceArtifactId(ws.id, `plan_${sku}`), 'adopted after plan.json appears');
  assert.ok(r2.watchable.includes(relOf(sku)));
});

test('over-cap: a folder past the child-sub cap still adopts + updates, surfacing degraded-watch', async () => {
  writeFolder('cap-a-eeee', { mtimeMs: 4_000_000 });
  writeFolder('cap-b-ffff', { mtimeMs: 4_000_001 });
  const res = await newWatcher({ childSubCap: 1 }).reconcileWorkspace(ws, false);
  assert.equal(res.watchable.length, 1, 'one folder within the cap');
  assert.equal(res.overCap.length, 1, 'one folder over the cap');
  // BOTH are adopted (over-cap never means unregistered).
  assert.ok(dbm.getPlanByWorkspaceArtifactId(ws.id, 'plan_cap-a-eeee'));
  assert.ok(dbm.getPlanByWorkspaceArtifactId(ws.id, 'plan_cap-b-ffff'));
  const degraded = res.diagnostics.find((d) => d.kind === 'degraded-watch');
  assert.ok(degraded && res.overCap.includes(degraded.relPath), 'degraded-watch surfaced for the over-cap folder');
});

test('duplicate plan_artifact_id across two folders leaves the loser unregistered with a both-paths diagnostic', async () => {
  const relA = writeFolder('dup-a-gggg', { artifactId: 'plan_shared_dup' });
  const relB = writeFolder('dup-b-hhhh', { artifactId: 'plan_shared_dup' });
  const before = planRowCount();
  const res = await newWatcher().reconcileWorkspace(ws, false);
  // a sorts before b → a canonical, b duplicate.
  assert.equal(planRowCount(), before + 1, 'exactly one row for the shared artifact_id');
  const diag = res.diagnostics.find((d) => d.kind === 'duplicate-artifact-id' && d.relPath === relB);
  assert.ok(diag, 'duplicate diagnostic surfaced');
  assert.equal(diag!.otherRelPath, relA);
});

test('malformed plan.json is quarantined — not adopted, never rewritten', async () => {
  const sku = 'mal-iiii';
  writeFolder(sku, { planJson: 'malformed' });
  const abs = path.join(folderAbsOf(sku), 'plan.json');
  const before = fs.readFileSync(abs, 'utf8');
  const res = await newWatcher().reconcileWorkspace(ws, false);
  assert.equal(dbm.getPlanByWorkspaceArtifactId(ws.id, `plan_${sku}`), null, 'not adopted');
  assert.equal(fs.readFileSync(abs, 'utf8'), before, 'plan.json untouched');
  assert.ok(res.diagnostics.some((d) => d.kind === 'malformed-plan-json' && d.relPath === relOf(sku)));
});

test('a removed folder is reported + soft-deleted, and revives (same id) when it reappears', async () => {
  const sku = 'gone-jjjj';
  writeFolder(sku, { mtimeMs: 6_000_000 });
  const w = newWatcher();
  await w.reconcileWorkspace(ws, false);
  const row = dbm.getPlanByWorkspaceArtifactId(ws.id, `plan_${sku}`)!;
  assert.equal(row.deletedAt, null);

  fs.rmSync(folderAbsOf(sku), { recursive: true, force: true });
  const res = await w.reconcileWorkspace(ws, false);
  assert.ok(res.removed.includes(relOf(sku)), 'removal reported');
  assert.ok(dbm.getPlanByWorkspaceArtifactId(ws.id, `plan_${sku}`)!.deletedAt != null, 'row soft-deleted');
  assert.ok(!res.settled.some((s) => s.folderRelPath === relOf(sku)), 'never settle on removal');

  // Reappears → same id revived (deleted_at cleared), no new row.
  writeFolder(sku, { mtimeMs: 7_000_000 });
  await w.reconcileWorkspace(ws, false);
  const revived = dbm.getPlanByWorkspaceArtifactId(ws.id, `plan_${sku}`)!;
  assert.equal(revived.id, row.id, 'same plan id revived');
  assert.equal(revived.deletedAt, null, 'deleted_at cleared on revive');
});

test('two roots are independent — the structured root ignores non-folder + plan.json-less entries', async () => {
  // A stray FILE (e.g. a legacy-style .html) sitting in the state-dir plans home
  // is not a directory and never enters the structured-folder path.
  fs.writeFileSync(path.join(plansHomeAbs(), 'legacy-loose.html'), '<html>x</html>');
  fs.mkdirSync(folderAbsOf('bare-kkkk'), { recursive: true }); // dir, no plan.json
  const res = await newWatcher().reconcileWorkspace(ws, false);
  assert.ok(!res.watchable.some((r) => r.includes('legacy-loose')), 'loose html never adopted');
  assert.ok(!res.watchable.includes(relOf('bare-kkkk')), 'plan.json-less dir not adopted');
});

test('adopt writes NO author_* column (schema-checked): plans has no author columns', () => {
  const cols = FakeBetterSqlite.rawAll('PRAGMA table_info(plans)').map((r) => String(r.name));
  assert.ok(!cols.some((c) => /^author_/.test(c)), `plans carries no author_* column (got: ${cols.join(', ')})`);
});

test('P2 imports nothing from P2L (no intent-ledger dependency)', () => {
  const compiled = fs.readFileSync(path.join(__dirname, 'plan-folder-watcher.js'), 'utf8');
  assert.ok(!/plan-intent/i.test(compiled), 'no plan-intent* import in the compiled module');
});

// ── runner ─────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'pfw-appdata-'));
  process.env.APPDATA = tmpAppData;
  // Per-test workspaces (empty plans home + zero-row ws) are minted by
  // freshWorkspace() inside the loop below — no shared workspace here.

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as DbModule;
  dbm.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  wm = require('./plan-folder-watcher') as WatcherModule;

  let passed = 0, failed = 0;
  for (const t of tests) {
    freshWorkspace(); // isolate every case: empty plans home + zero-row workspace
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }

  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(wsRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
